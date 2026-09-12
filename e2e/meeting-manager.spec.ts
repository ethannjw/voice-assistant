import { expect, test } from "@playwright/test";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { MeetingManager } from "../src/server/meeting/manager";
import { createMeetingRuntime } from "../src/server/meeting/runtime";
import { buildSessionConfig } from "../src/server/realtime";
import type { WireEvent } from "../src/server/meeting/audioRelay";

test("meeting manager authenticates transports, preserves tools, relays PCM and cleans up on UI loss", async () => {
  const certificate = await createMeetingRuntime();
  const provider = new WebSocketServer({port: 0, host: "127.0.0.1"});
  await once(provider, "listening");
  let providerSocket: WebSocket | undefined;
  const upstream: WireEvent[] = [];
  provider.on("connection", socket => {
    providerSocket = socket;
    socket.on("message", raw => upstream.push(JSON.parse(raw.toString())));
  });
  let runtimeConfiguration: WireEvent | undefined;
  let stops = 0;
  const manager = new MeetingManager({
    session: () => buildSessionConfig("test-model", "marin", null),
    providerUrl: `http://127.0.0.1:${(provider.address() as {port: number}).port}`,
    apiKey: "fake-test-key", name: "Elva AI assistant", durationMinutes: 1,
    runtimeFactory: async () => ({...certificate, start: config => {runtimeConfiguration = config;}, stop: async () => {stops++;}})
  });
  const app = express();
  app.use(express.json());
  const server = createServer(app);
  manager.mount(app, server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const start = (headers = {}) => fetch(`${origin}/api/meeting/start`, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify({meetingUrl: "https://teams.microsoft.com/meet/123"})});
  const sockets: WebSocket[] = [];
  const connect = (url: string, protocols: string[], options = {}) => {
    const socket = new WebSocket(url, protocols, options);
    sockets.push(socket);
    socket.on("error", () => {});
    return socket;
  };
  try {
    expect((await start({Origin: "https://untrusted.example"})).status).toBe(403);
    const started = await start();
    expect(started.status).toBe(200);
    const {token} = await started.json() as {token: string};
    expect((await fetch(`${origin}/api/meeting/stop`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token: "wrong"})})).status).toBe(403);
    expect((await start()).status).toBe(409);
    const rejected = connect(origin.replace("http:", "ws:") + "/api/meeting/control", ["elva-control", "wrong-token"]);
    await expect.poll(() => rejected.readyState).toBe(WebSocket.CLOSED);
    const control = connect(origin.replace("http:", "ws:") + "/api/meeting/control", ["elva-control", token]);
    const browser: WireEvent[] = [];
    control.on("message", raw => browser.push(JSON.parse(raw.toString())));
    await once(control, "open");
    control.send(JSON.stringify({type: "session.update", session: {tools: []}}));
    await expect.poll(() => upstream.length).toBe(1);
    const config = upstream[0].session;
    expect(config.model).toBeUndefined();
    expect(config.tools.map((tool: WireEvent) => tool.name)).toEqual(expect.arrayContaining(["coding_task", "mcp_call", "read_file"]));
    expect(runtimeConfiguration).toBeUndefined();
    providerSocket!.send(JSON.stringify({type: "session.updated", session: config}));
    await expect.poll(() => Boolean(runtimeConfiguration)).toBe(true);
    const botAddress = new URL(runtimeConfiguration!.url);
    botAddress.hostname = "localhost";
    const bot = connect(botAddress.href, [], {ca: certificate.certificate});
    const playback: WireEvent[] = [];
    bot.on("message", raw => playback.push(JSON.parse(raw.toString())));
    await once(bot, "open");
    const audio = Buffer.alloc(480).toString("base64");
    bot.send(JSON.stringify({trigger: "realtime_audio.mixed", data: {chunk: audio, sample_rate: 24000}}));
    await expect.poll(() => upstream.some(event => event.type === "input_audio_buffer.append")).toBe(true);
    control.send(JSON.stringify({type: "response.create", response: {metadata: {attention_reply: "accepted"}}}));
    await expect.poll(() => upstream.some(event => event.type === "response.create")).toBe(true);
    providerSocket!.send(JSON.stringify({type: "response.created", response: {id: "reply", metadata: {attention_reply: "accepted"}}}));
    providerSocket!.send(JSON.stringify({type: "response.output_audio.delta", response_id: "reply", item_id: "item", content_index: 0, delta: audio}));
    await expect.poll(() => playback.some(event => event.trigger === "realtime_audio.bot_output")).toBe(true);
    expect(browser.some(event => event.type === "response.output_audio.delta")).toBe(false);
    control.close();
    await expect.poll(() => stops).toBe(1);
    await expect.poll(() => bot.readyState).toBe(WebSocket.CLOSED);
    runtimeConfiguration = undefined;
    const second = await start();
    expect(second.status).toBe(200);
    const secondToken = (await second.json() as {token: string}).token;
    const nextControl = connect(origin.replace("http:", "ws:") + "/api/meeting/control", ["elva-control", secondToken]);
    await once(nextControl, "open");
    const previousUpdates = upstream.filter(event => event.type === "session.update").length;
    nextControl.send(JSON.stringify({type: "session.update"}));
    await expect.poll(() => upstream.filter(event => event.type === "session.update").length).toBe(previousUpdates + 1);
    providerSocket!.send(JSON.stringify({type: "session.updated", session: {audio: {input: {turn_detection: {create_response: true, interrupt_response: true}}}}}));
    await expect.poll(() => nextControl.readyState).toBe(WebSocket.CLOSED);
    expect(runtimeConfiguration).toBeUndefined();
    expect(stops).toBe(2);
  } finally {
    sockets.forEach(socket => socket.terminate());
    await manager.stop();
    provider.clients.forEach(socket => socket.terminate());
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await certificate.stop();
  }
});
