import { chromium, type Page } from "@playwright/test";
import { ATTENTION_IDLE_MS, ConversationAttention } from "../../src/client/lib/conversationAttention";
import type { RealtimeEvent } from "../../src/client/types";

type EvaluationWindow = Window & {
  __attentionEval: { channel: RTCDataChannel | null; events: RealtimeEvent[] };
};

const cases = [
  { name: "direct invitation", text: "Elva, can you summarize our decision?", active: false, action: "direct", cancel: false },
  { name: "mere name mention", text: "I asked Elva about this yesterday.", active: false, action: "ignore", cancel: false },
  { name: "question to another participant", text: "Alex, could you share your screen?", active: false, action: "ignore", cancel: false },
  { name: "unaddressed question while waiting", text: "What do you think about this change?", active: false, action: "ignore", cancel: false },
  { name: "quoted instruction", text: 'Alex said, "Elva, run the tests." I am quoting him, not asking you.', active: false, action: "ignore", cancel: false },
  { name: "natural follow-up", text: "Can you show me a smaller example?", active: true, action: "follow_up", cancel: false },
  { name: "side conversation while active", text: "Alex, do you agree with that?", active: true, action: "ignore", cancel: false },
  { name: "unrelated question while active", text: "What time is lunch?", active: true, action: "ignore", cancel: false },
  { name: "end exchange", text: "Thanks Elva, that is all.", active: true, action: "dismiss", cancel: false },
  { name: "explicit task cancellation", text: "Elva, cancel the running Cursor task.", active: true, action: "direct", cancel: true },
  { name: "reported cancellation", text: "Alex told Sam to stop Cursor; I am reporting their conversation.", active: true, action: "ignore", cancel: false }
];

async function send(page: Page, event: unknown) {
  await page.evaluate((value) => {
    const channel = (window as unknown as EvaluationWindow).__attentionEval.channel;
    if (channel?.readyState !== "open") throw new Error("Realtime channel is not open.");
    channel.send(JSON.stringify(value));
  }, event);
}

async function createItem(page: Page, item: Record<string, unknown>) {
  await send(page, { type: "conversation.item.create", item });
  await page.waitForFunction((id) => (window as unknown as EvaluationWindow).__attentionEval.events.some(
    (event) => (event.type === "conversation.item.added" || event.type === "conversation.item.created") && event.item?.id === id
  ), item.id, { timeout: 15_000 });
}

async function evaluateToolCycle(page: Page) {
  const requests: Record<string, unknown>[] = [];
  const received: RealtimeEvent[] = [];
  let cursor = await page.evaluate(() => (window as unknown as EvaluationWindow).__attentionEval.events.length);
  let repliesSent = 0;
  let repliesCompleted = 0;
  let toolCalls = 0;
  const followUps = ["Can you repeat that?", "Again, please."];
  let followUpsSent = 0;
  let lastReplyId: string | undefined;
  let clockOffset = 0;
  const expectedReplies = 2 + followUps.length;
  const controller = new ConversationAttention({
    now: () => Date.now() + clockOffset,
    send: (event) => requests.push(event), onState: () => {},
    onNotice: (message) => { throw new Error(message); },
    onUnsafeSession: () => { throw new Error("Unsafe session configuration."); },
    cancelCodingTasks: () => { throw new Error("Tool-cycle evaluation must not cancel coding tasks."); },
    executeToolCall: (name, callId) => {
      if (name !== "attention_test_lookup" || ++toolCalls !== 1) throw new Error(`Unexpected evaluation tool: ${name}`);
      controller.finishToolCall(callId, { ok: true, output: "Synthetic forecast: purple clouds, nineteen degrees." }, false);
    }
  });
  try {
    controller.handleEvent(await page.evaluate(() => (window as unknown as EvaluationWindow).__attentionEval.events.filter(
      (event) => event.type === "session.updated"
    ).at(-1)!));
    controller.sendText("Elva, look up the synthetic forecast using attention_test_lookup and read it back.");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && repliesCompleted < expectedReplies) {
      for (const request of requests.splice(0)) {
        const response = request.response as Record<string, unknown> | undefined;
        if ((response?.metadata as Record<string, string> | undefined)?.attention_reply) {
          repliesSent++;
          const attentionInstructions = response!.instructions;
          Object.assign(response!, repliesSent === 1 ? {
            tools: [{ type: "function", name: "attention_test_lookup", description: "Read a synthetic test fixture, not live weather.",
              parameters: { type: "object", properties: {}, additionalProperties: false } }],
            tool_choice: { type: "function", name: "attention_test_lookup" },
            output_modalities: ["text"], max_output_tokens: 512,
            instructions: "Call attention_test_lookup once with empty arguments. Do not call any other tool."
          } : {
            tools: [], tool_choice: "none", output_modalities: ["audio"], max_output_tokens: 512,
            instructions: "Read the synthetic forecast returned by the tool in one short sentence. Include purple clouds and nineteen degrees."
          });
          response!.instructions = [attentionInstructions, response!.instructions].filter((value) => typeof value === "string").join("\n\n");
        }
        await send(page, request);
      }
      await page.waitForFunction((offset) => (window as unknown as EvaluationWindow).__attentionEval.events.length > offset,
        cursor, { timeout: 20_000 });
      const events = await page.evaluate((offset) => (window as unknown as EvaluationWindow).__attentionEval.events.slice(offset), cursor);
      cursor += events.length;
      for (const event of events) {
        received.push(event);
        if (event.type === "error") throw new Error(`Realtime rejected the tool cycle: ${event.error?.message}`);
        controller.handleEvent(event);
        if (event.type === "response.done" && event.response?.metadata?.attention_check) {
          const decision = event.response.output?.find((item) => item.type === "function_call" && item.name === "attention_decision");
          if (event.response.status !== "completed" || JSON.parse(decision?.arguments ?? "{}")?.action !== "follow_up") {
            throw new Error(`Name-free follow-up ${followUpsSent} was not accepted: ${decision?.arguments ?? event.response.status}`);
          }
        }
        if (event.type === "response.done" && event.response?.metadata?.attention_reply) {
          if (event.response.status !== "completed") throw new Error(`Reply failed: ${JSON.stringify(event.response)}`);
          repliesCompleted++;
          lastReplyId = event.response.id;
          if (repliesCompleted > 1) {
            const transcript = event.response.output?.flatMap((item) => item.content ?? []).map((content) => content.transcript ?? content.text ?? "").join(" ") ?? "";
            if (!/purple clouds/i.test(transcript) || !/nineteen|19/i.test(transcript)) {
              throw new Error(`Spoken reply did not use the fixture output: ${transcript}`);
            }
          }
        }
      }
      if (repliesCompleted === 2 + followUpsSent && followUpsSent < followUps.length && received.some(
        (event) => event.type === "output_audio_buffer.stopped" && event.response_id === lastReplyId
      )) {
        const itemId = crypto.randomUUID().replaceAll("-", "");
        if (followUpsSent === 0) {
          clockOffset += ATTENTION_IDLE_MS - 1_000;
          controller.handleEvent({ type: "input_audio_buffer.speech_started", item_id: itemId });
          clockOffset += 2_000;
        }
        await createItem(page, { id: itemId, type: "message", role: "user", content: [{ type: "input_text", text: followUps[followUpsSent++] }] });
        controller.handleEvent({ type: "input_audio_buffer.committed", item_id: itemId });
      }
    }
    if (toolCalls !== 1 || repliesCompleted !== expectedReplies) throw new Error("Tool-cycle evaluation did not complete the tool result, spoken reply, and name-free follow-ups.");
    console.log(`PASS live tool cycle: accepted tool result, spoken fixture reply, and ${followUps.length} consecutive name-free follow-ups, including a simulated idle-boundary crossing; no Realtime errors.`);
  } catch (error) {
    console.log(JSON.stringify(received.filter((event) => event.type === "response.done" || event.type.startsWith("conversation.item") || event.type === "error")));
    throw error;
  } finally {
    controller.dispose();
  }
}

async function main() {
  const toolCycle = process.argv.includes("--tool-cycle");
  const caseFlag = process.argv.indexOf("--case");
  const selectedCases = toolCycle ? [] : caseFlag < 0 ? cases : cases.filter((example) =>
    new RegExp(process.argv[caseFlag + 1] ?? "", "i").test(example.name)
  );
  if (!toolCycle && selectedCases.length === 0) throw new Error("No evaluation cases matched --case.");
  const baseUrl = process.env.ATTENTION_EVAL_BASE_URL ?? "http://127.0.0.1:8787";
  const target = new URL(baseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
    throw new Error("ATTENTION_EVAL_BASE_URL must point to your local application.");
  }
  console.log("Opt-in live evaluation: synthetic input only; uses your running app's Realtime API credits.");
  if (toolCycle) console.log("Tool-cycle mode uses one harmless fixture tool and generated speech; no workspace tools, coding tasks, or live search.");
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    const page = await browser.newPage();
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.addInitScript({ content: `
      const state = { channel: null, events: [] };
      window.__attentionEval = state;
      const original = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (label, options) {
        const channel = original.call(this, label, options);
        state.channel = channel;
        channel.addEventListener("message", (message) => state.events.push(JSON.parse(message.data)));
        return channel;
      };
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
        const context = new AudioContext();
        const source = context.createConstantSource();
        source.offset.value = 0;
        const destination = context.createMediaStreamDestination();
        source.connect(destination);
        source.start();
        await context.resume();
        return destination.stream;
      } });
    ` });
    await page.goto(baseUrl);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try {
      await page.waitForFunction(() => document.querySelector(".status-pill")?.textContent === "Error" ||
        (window as unknown as EvaluationWindow).__attentionEval.events.some(
          (event) => event.type === "session.updated" && event.session?.audio?.input?.turn_detection?.create_response === false
        ), undefined, { timeout: 30_000 });
      if (await page.locator(".status-pill").textContent() !== "Connected") throw new Error("Session setup failed.");
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        status: document.querySelector(".status-pill")?.textContent,
        messages: [...document.querySelectorAll("article.message.system")].map((node) => node.textContent),
        events: (window as unknown as EvaluationWindow).__attentionEval?.events.filter(
          (event) => event.type === "error" || event.type === "session.created" || event.type === "session.updated"
        ).map((event) => ({ type: event.type, error: event.error?.message, detection: event.session?.audio?.input?.turn_detection }))
      }));
      throw new Error(`Live session unavailable: ${JSON.stringify({ ...diagnostics, browserErrors })}`, { cause: error });
    }

    if (toolCycle) await evaluateToolCycle(page);
    for (const example of selectedCases) {
      const requests: Record<string, unknown>[] = [];
      let cancellations = 0;
      const replyCount = () => requests.filter((request) =>
        (request.response as { metadata?: Record<string, string> } | undefined)?.metadata?.attention_reply
      ).length;
      const controller = new ConversationAttention({
        send: (event) => requests.push(event), onState: () => {}, onNotice: () => {},
        onUnsafeSession: () => { throw new Error("Unsafe session configuration."); },
        executeToolCall: () => { throw new Error("Live attention checks must not execute tools."); },
        cancelCodingTasks: () => { cancellations++; }
      });
      try {
        controller.handleEvent({ type: "session.updated", session: { audio: { input: {
          turn_detection: { create_response: false, interrupt_response: false }
        } } } });
        if (example.active) {
          controller.sendText("Elva, help me debug the failing TypeScript build.");
          const invitation = requests.find((event) => event.type === "conversation.item.create")!;
          await createItem(page, invitation.item as Record<string, unknown>);
        }
        const itemId = crypto.randomUUID().replaceAll("-", "");
        await createItem(page, { id: itemId, type: "message", role: "user", content: [{ type: "input_text", text: example.text }] });
        controller.handleEvent({ type: "input_audio_buffer.committed", item_id: itemId });
        const check = requests.filter((event) => (event.response as { metadata?: Record<string, string> } | undefined)?.metadata?.attention_check).at(-1)!;
        const checkId = check.event_id as string;
        const startedAt = Date.now();
        await send(page, check);
        await page.waitForFunction((id) => (window as unknown as EvaluationWindow).__attentionEval.events.some(
          (event) => (event.type === "response.done" && event.response?.metadata?.attention_check === id) ||
            (event.type === "error" && event.error?.event_id === id)
        ), checkId, { timeout: 20_000 });
        const event = await page.evaluate((id) => (window as unknown as EvaluationWindow).__attentionEval.events.find(
          (value) => (value.type === "response.done" && value.response?.metadata?.attention_check === id) ||
            (value.type === "error" && value.error?.event_id === id)
        )!, checkId);
        const priorReplies = replyCount();
        controller.handleEvent(event);
        const admitted = replyCount() - priorReplies;
        const text = event.response?.output?.find((item) => item.type === "function_call" && item.name === "attention_decision")?.arguments ?? "";
        let decision: { action?: string; cancel_task?: boolean } = {};
        try { decision = JSON.parse(text); } catch {}
        const expectedReplies = example.action === "direct" || example.action === "follow_up" ? 1 : 0;
        const passed = event.response?.status === "completed" && decision.action === example.action &&
          decision.cancel_task === example.cancel && admitted === expectedReplies && cancellations === Number(example.cancel);
        if (!passed) failed++;
        console.log(`${passed ? "PASS" : "FAIL"} ${example.name}: ${text || event.error?.message || event.response?.status}; admitted=${admitted}; elapsed=${Date.now() - startedAt}ms`);
        if (!passed) {
          const response = event.response as typeof event.response & { status_details?: unknown; usage?: unknown };
          console.log(JSON.stringify({ status: response?.status, details: response?.status_details, usage: response?.usage,
            output: response?.output?.map((item) => ({ type: item.type, name: item.name, arguments: item.arguments })) }));
        }
      } finally {
        controller.dispose();
      }
    }
    if (!toolCycle) console.log(`${selectedCases.length - failed}/${selectedCases.length} synthetic text cases passed. This does not measure real microphone/acoustic accuracy.`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await browser.close();
  }
}

await main();
