import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { ConversationAttention } from "../../src/client/lib/conversationAttention";
import type { RealtimeEvent } from "../../src/client/types";
import { runWebSearch } from "../../src/server/webSearch";
import type { ToolResult } from "../../src/shared/contracts";

type EvaluationWindow = Window & {
  __attentionEval: { channel: RTCDataChannel; events: RealtimeEvent[] };
};

async function send(page: Page, event: Record<string, unknown>) {
  await page.evaluate((value) => {
    const channel = (window as unknown as EvaluationWindow).__attentionEval.channel;
    if (channel.readyState !== "open") throw new Error("Realtime channel closed during search evaluation.");
    channel.send(JSON.stringify(value));
  }, event);
}

export async function evaluateSearchPolicy(page: Page, liveSearch: boolean) {
  const caseFlag = process.argv.indexOf("--case");
  const scenario = liveSearch ? "live" : caseFlag < 0 ? "refinement" : process.argv[caseFlag + 1];
  if (!["content", "refinement", "unavailable", "live"].includes(scenario)) {
    throw new Error("Search evaluation --case must be content, refinement, or unavailable.");
  }
  const queries: string[] = [];
  const results: ToolResult[] = [];
  let providerCalls = 0;
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { scrapeOptions?: { formats?: string[] } };
    providerCalls++;
    const available = scenario === "content" || (scenario === "refinement" && providerCalls > 1);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ success: true, data: { web: [{
      title: "Fixture Weather Bureau",
      url: "https://weather.example.test/glass-harbor/2026-09-09",
      description: "Glass Harbor daily forecast. See the page for the high and low temperatures.",
      metadata: { statusCode: available ? 200 : 503 },
      ...(available && body.scrapeOptions?.formats?.includes("markdown") ? {
        markdown: "# Fixture Weather Bureau\n\nSynthetic test forecast, not real weather.\n\nGlass Harbor, September 9, 2026. Daily high: 31°C. Daily low: 24°C."
      } : {})
    }] } }));
  });
  if (!liveSearch) {
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
  }
  const requests: Record<string, unknown>[] = [];
  const toolTasks: Promise<void>[] = [];
  const notices: string[] = [];
  let transcript: string | undefined;
  let failure: Error | undefined;
  let controller: ConversationAttention | undefined;
  const startedAt = Date.now();
  try {
    let cursor = await page.evaluate(() => (window as unknown as EvaluationWindow).__attentionEval.events.length);
    const sessionEvent = await page.evaluate(() => (window as unknown as EvaluationWindow).__attentionEval.events.filter(
      (event) => event.type === "session.updated"
    ).at(-1)!);
    const searchTool = sessionEvent.session?.tools?.find((tool) => tool.name === "web_search");
    if (!searchTool) throw new Error("The app's live session does not expose web_search.");
    await send(page, { type: "session.update", session: { type: "realtime", tools: [searchTool] } });
    await page.waitForFunction((offset) => (window as unknown as EvaluationWindow).__attentionEval.events.slice(offset).some(
      (event) => event.type === "session.updated" || event.type === "error"
    ), cursor, { timeout: 15_000 });
    const configured = await page.evaluate((offset) => (window as unknown as EvaluationWindow).__attentionEval.events.slice(offset), cursor);
    const setupError = configured.find((event) => event.type === "error");
    if (setupError) throw new Error(setupError.error?.message);
    const confirmed = configured.find((event) => event.type === "session.updated")!;
    cursor = await page.evaluate(() => (window as unknown as EvaluationWindow).__attentionEval.events.length);
    controller = new ConversationAttention({
      send: (event) => requests.push(event), onState: () => {}, onNotice: (message) => notices.push(message),
      onUnsafeSession: () => { failure = new Error("Unsafe Realtime session configuration."); },
      cancelCodingTasks: () => { failure = new Error("Search evaluation must not cancel coding work."); },
      executeToolCall: (name, callId, args) => {
        toolTasks.push((async () => {
          if (name !== "web_search" || queries.length >= 3) throw new Error(`Unexpected or unbounded tool call: ${name}`);
          const { query } = JSON.parse(args) as { query: string };
          if (typeof query !== "string" || !query.trim()) throw new Error("Search query is missing.");
          queries.push(query);
          let result: ToolResult;
          if (liveSearch) {
            const response = await page.request.post(new URL("/api/tools/web_search", page.url()).href, {
              data: { query }, timeout: 60_000
            });
            result = await response.json() as ToolResult;
          } else {
            const port = (fixture.address() as AddressInfo).port;
            const search = await runWebSearch(query, `http://127.0.0.1:${port}`);
            result = { ok: true, output: search.text, metadata: { sources: search.sources, retrievedAt: search.retrievedAt } };
          }
          results.push(result);
          controller!.finishToolCall(callId, result, false);
        })().catch((error) => { failure = error instanceof Error ? error : new Error(String(error)); }));
      }
    });
    controller.handleEvent(confirmed);
    controller.sendText(liveSearch
      ? "Elva, what are Singapore's forecast high and low temperatures in Celsius tomorrow?"
      : "Elva, what are the forecast high and low temperatures in Celsius for Glass Harbor on September 9, 2026?");
    const deadline = Date.now() + (liveSearch ? 180_000 : 90_000);
    while (transcript === undefined && Date.now() < deadline) {
      if (failure) throw failure;
      if (notices.length) throw new Error(notices.join("; "));
      for (const request of requests.splice(0)) await send(page, request);
      await page.waitForFunction((offset) => (window as unknown as EvaluationWindow).__attentionEval.events.length > offset,
        cursor, { timeout: Math.min(30_000, Math.max(1, deadline - Date.now())) });
      const events = await page.evaluate((offset) => (window as unknown as EvaluationWindow).__attentionEval.events.slice(offset), cursor);
      cursor += events.length;
      for (const event of events) {
        if (event.type === "error") throw new Error(`Realtime search cycle failed: ${event.error?.message}`);
        controller.handleEvent(event);
        if (event.type === "response.done" && event.response?.metadata?.attention_reply) {
          if (event.response.status !== "completed") throw new Error(`Search reply status: ${event.response.status}`);
          if (!event.response.output?.some((item) => item.type === "function_call")) {
            transcript = event.response.output?.flatMap((item) => item.content ?? []).map((content) => content.transcript ?? content.text ?? "").join(" ") ?? "";
          }
        }
      }
      await Promise.all(toolTasks.splice(0));
    }
    if (failure) throw failure;
    if (!transcript || !queries.length) throw new Error("The requested lookup never completed.");
    if (/if you (?:want|like)|would you like|shall I|want me to|I can try|say [“"]?continue|I(?:'d| would) need to open/i.test(transcript)) {
      throw new Error(`Premature handoff instead of completing the lookup: ${transcript}`);
    }
    if (scenario === "unavailable") {
      if (queries.length !== 3) throw new Error(`Unavailable-data case stopped after ${queries.length} searches instead of using the bounded alternatives.`);
      if (/\b\d+\s*(?:°|degrees)|thirty.one|twenty.four/i.test(transcript)) throw new Error(`Unsupported temperatures in unavailable-data reply: ${transcript}`);
      if (!/unavailable|unable|cannot|can't|couldn't|could not|not (?:available|verified)|(?:don't|do not|didn't|did not) have|failed|missing|blocked/i.test(transcript)) {
        throw new Error(`Reply did not disclose unavailable data: ${transcript}`);
      }
    } else if (scenario === "live") {
      if (!results.some((result) => /Page content/.test(result.output))) throw new Error("Live Firecrawl provided no page content.");
      if (!/high/i.test(transcript) || !/low/i.test(transcript) || !/celsius|°\s*c\b/i.test(transcript) || !/\d|twenty|thirty|forty/i.test(transcript)) {
        throw new Error(`Live reply did not contain high/low values and Celsius units: ${transcript}`);
      }
    } else {
      if (!/(?:31|thirty.one)/i.test(transcript) || !/(?:24|twenty.four)/i.test(transcript) || !/celsius|°\s*c\b/i.test(transcript)) {
        throw new Error(`Reply did not preserve the fixture values and units: ${transcript}`);
      }
      if (!/fixture weather|weather bureau/i.test(transcript)) throw new Error(`Missing fixture source attribution: ${transcript}`);
      if (scenario === "content" && queries.length !== 1) throw new Error("Sufficient page content caused unnecessary searches.");
      if (scenario === "refinement" && new Set(queries.map((query) => query.trim().toLowerCase())).size < 2) {
        throw new Error("Insufficient snippets did not cause an automatic distinct query refinement.");
      }
    }
    console.log(`PASS live search policy (${scenario}): ${queries.length} searches, one invitation, no forced tool choice or scripted answer; ${Date.now() - startedAt}ms.`);
    console.log(JSON.stringify({ queries, transcript, sources: results.map((result) => result.metadata?.sources) }, null, 2));
    if (liveSearch) console.log("Live weather is a changing smoke check; inspect the retrieved dates and units, not a fixed temperature assertion.");
  } catch (error) {
    console.log(JSON.stringify({ scenario, queries, transcript, notices, sources: results.map((result) => result.metadata?.sources) }));
    throw error;
  } finally {
    controller?.dispose();
    if (fixture.listening) {
      fixture.closeAllConnections();
      await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    }
  }
}
