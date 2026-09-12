import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { e2eRoot, repositoryRoot } from "./support/paths";

let remote: ChildProcessWithoutNullStreams;
let origin: string;

test.describe.serial("remote MCP transports and OAuth", () => {
  test.beforeAll(async () => {
    remote = spawn(process.execPath, [path.join(repositoryRoot, "e2e/fixtures/mcp-remote.mjs")], { stdio: "pipe" });
    origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { remote.kill(); reject(new Error("Remote MCP fixture startup timed out.")); }, 10_000);
      remote.once("error", (error) => { clearTimeout(timer); reject(error); });
      remote.stderr.on("data", (chunk) => { clearTimeout(timer); reject(new Error(String(chunk))); });
      remote.stdout.once("data", (chunk) => { clearTimeout(timer); resolve(String(chunk).trim()); });
    });
  });
  test.afterAll(async () => { remote?.kill(); });
  test.afterEach(async ({ request }) => { await request.put("/api/mcp/config", { data: { mcpServers: {} } }); });

  for (const type of ["http", "sse"] as const) {
    test(`negotiates and executes through ${type}`, async ({ request }) => {
      await request.put("/api/mcp/config", { data: { mcpServers: { remote: { type, url: `${origin}/${type === "http" ? "mcp" : "sse"}` } } } });
      const catalog = await request.post("/api/tools/mcp_list", { data: { server: "remote" } });
      expect(await catalog.json()).toMatchObject({ ok: true, output: expect.stringContaining("echo") });
      const result = await request.post("/api/tools/mcp_call", { data: { server: "remote", operation: "tool", name: "echo", arguments: { message: type } } });
      expect(await result.json()).toMatchObject({ ok: true, output: expect.stringContaining(`remote:${type}`) });
    });
  }

  test("passes configured headers without including secrets in status", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { remote: { type: "http", url: `${origin}/header/mcp`, headers: { "x-fixture-key": "fixture-secret" } } } } });
    const result = await request.post("/api/tools/mcp_call", { data: { server: "remote", operation: "tool", name: "echo", arguments: { message: "headers" } } });
    expect(await result.json()).toMatchObject({ ok: true });
    const status = await request.get("/api/mcp/status");
    expect(await status.text()).not.toContain("fixture-secret");
    expect((await stat(path.join(e2eRoot, "mcp.json"))).mode & 0o777).toBe(0o600);
  });

  test("keeps idle SSE connections alive beyond individual request timeouts", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { remote: { type: "sse", url: `${origin}/sse`, timeoutMs: 1000 } } } });
    await request.post("/api/mcp/servers/remote/connect");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await request.post("/api/tools/mcp_call", { data: { server: "remote", operation: "tool", name: "echo", arguments: { message: "still connected" } } });
    expect(await result.json()).toMatchObject({ ok: true, output: expect.stringContaining("still connected") });
  });

  test("performs OAuth discovery, registration, PKCE, callback validation and persistence", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { authenticated: { type: "http", url: `${origin}/protected/mcp`, headers: { "x-fixture-private": "resource-only-secret" } } } } });
    const connect = await request.post("/api/mcp/servers/authenticated/connect");
    expect(connect.status()).toBe(400);
    const status = await (await request.get("/api/mcp/status")).json();
    expect(status.servers[0].state, JSON.stringify(status)).toBe("auth_required");
    const authorization = await request.get(status.servers[0].authorizationUrl);
    const { callback } = await authorization.json();
    const badCallback = new URL(callback);
    badCallback.searchParams.set("state", "invalid");
    expect((await request.get(badCallback.href)).status()).toBe(400);
    const finished = await request.get(callback);
    expect(finished.status(), await finished.text()).toBe(200);
    expect((await request.get(callback)).status()).toBe(400);
    const result = await request.post("/api/tools/mcp_call", { data: { server: "authenticated", operation: "tool", name: "echo", arguments: { message: "oauth" } } });
    expect(await result.json()).toMatchObject({ ok: true, output: expect.stringContaining("remote:oauth") });
    const credentials = path.join(e2eRoot, "mcp-credentials");
    const files = await readdir(credentials);
    const tokenFile = (await Promise.all(files.map(async (file) => ({ file, content: await readFile(path.join(credentials, file), "utf8") })))).find((entry) => entry.content.includes("fixture-access"));
    expect(tokenFile).toBeDefined();
    expect((await stat(path.join(credentials, tokenFile!.file))).mode & 0o777).toBe(0o600);
    await request.post("/api/mcp/servers/authenticated/reconnect");
    expect((await (await request.get("/api/mcp/status")).json()).servers[0].state).toBe("connected");
    expect(await (await request.get(`${origin}/stats`)).json()).toMatchObject({ tokenExchanges: 1, leakedOAuthHeader: false });
    await request.post("/api/mcp/servers/authenticated/logout");
    expect((await (await request.get("/api/mcp/status")).json()).servers[0].state).toBe("disconnected");
    expect(await readFile(path.join(credentials, tokenFile!.file), "utf8").catch(() => null)).toBeNull();
  });

  test("bounds SSE startup even if the server never sends its endpoint", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { stalled: { type: "sse", url: `${origin}/stalled-sse`, timeoutMs: 1000 } } } });
    const connecting = request.post("/api/mcp/servers/stalled/connect", { timeout: 5000 }).catch(() => undefined);
    try {
      await expect.poll(async () => (await (await request.get("/api/mcp/status")).json()).servers[0].state, { timeout: 2500 }).toBe("error");
    } finally {
      await request.put("/api/mcp/config", { data: { mcpServers: {} }, timeout: 5000 }).catch(() => {});
      await connecting;
    }
  });

  test("terminates stateful HTTP sessions on reconnect", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { remote: { type: "http", url: `${origin}/mcp` } } } });
    await request.post("/api/mcp/servers/remote/connect");
    const before = (await (await request.get(`${origin}/stats`)).json()).terminatedSessions;
    await request.post("/api/mcp/servers/remote/reconnect");
    expect((await (await request.get(`${origin}/stats`)).json()).terminatedSessions).toBe(before + 1);
  });
});
