import { expect, test } from "@playwright/test";
import { ConversationAttention, ATTENTION_IDLE_MS, ATTENTION_CHECK_TIMEOUT_MS } from "../src/client/lib/conversationAttention";
import type { AttentionState, RealtimeEvent, RealtimeItem } from "../src/client/types";

type ClientEvent = {
  type: string;
  event_id?: string;
  response_id?: string;
  response?: {
    metadata: Record<string, string>;
    conversation?: string;
    instructions?: string;
    input?: { type: string; id: string }[];
    tools?: unknown[];
    max_output_tokens?: number;
  };
  item?: RealtimeItem & { id: string; type: string };
};

const controllers: ConversationAttention[] = [];

test.afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function setup(checkTimeoutMs?: number, idleMs?: number) {
  let now = 1_000;
  let cancellations = 0;
  let unsafeSessions = 0;
  const events: ClientEvent[] = [];
  const states: AttentionState[] = [];
  const notices: string[] = [];
  const tools: string[] = [];
  const controller = new ConversationAttention({
    send: (event) => events.push(event as ClientEvent),
    onState: (state) => states.push(state),
    onNotice: (message) => notices.push(message),
    onUnsafeSession: () => { unsafeSessions++; },
    executeToolCall: (_name, callId) => tools.push(callId),
    cancelCodingTasks: () => { cancellations++; },
    now: () => now,
    checkTimeoutMs,
    idleMs
  });
  controllers.push(controller);
  controller.handleEvent({ type: "session.updated", session: { audio: { input: {
    turn_detection: { create_response: false, interrupt_response: false }
  } } } });
  const requests = (kind: string) => events.filter((event) => event.response?.metadata[kind]);
  const checks = () => requests("attention_check");
  const replies = () => requests("attention_reply");
  const done = (request: ClientEvent, output: RealtimeItem[], status = "completed") => {
    const response = { id: `response-${request.event_id}`, metadata: request.response!.metadata };
    controller.handleEvent({ type: "response.created", response });
    const event: RealtimeEvent = { type: "response.done", response: { ...response, status, output } };
    controller.handleEvent(event);
    return event;
  };
  const decide = (action: string, cancelTask = false, request = checks().at(-1)!) => done(request, [{
    type: "function_call", name: "attention_decision", arguments: JSON.stringify({ action, cancel_task: cancelTask })
  }]);
  return {
    controller, events, states, notices, tools, checks, replies, done, decide,
    acknowledge: (callId: string) => controller.handleEvent({ type: "conversation.item.added",
      item: events.find((event) => event.item?.type === "function_call_output" && event.item.call_id === callId)!.item }),
    cancellations: () => cancellations,
    unsafeSessions: () => unsafeSessions,
    advance: (milliseconds: number) => { now += milliseconds; },
    audio: (itemId: string) => controller.handleEvent({ type: "input_audio_buffer.committed", item_id: itemId }),
    invite: () => { controller.sendText("Elva, help me investigate this error."); }
  };
}

test("attention requires confirmed manual response control", () => {
  const harness = setup();
  harness.controller.handleEvent({ type: "session.updated", session: {} });
  harness.audio("unsafe-audio");
  expect(harness.unsafeSessions()).toBe(1);
  expect(harness.checks()).toHaveLength(0);
  expect(harness.controller.sendText("hello")).toBe(false);
});

test("attention replies use the durable conversation and keep the accepted turn targeted", () => {
  const harness = setup();
  harness.controller.handleEvent({ type: "session.updated", session: { instructions: "Preserve workspace approval rules.", audio: { input: {
    turn_detection: { create_response: false, interrupt_response: false }
  } } } });
  harness.audio("invited-forecast");
  harness.audio("newer-background");
  harness.decide("direct");
  const response = harness.replies()[0].response!;
  expect(response.conversation).toBe("auto");
  expect(response.input).toBeUndefined();
  expect(response.instructions).toContain("Preserve workspace approval rules.");
  expect(response.instructions).toContain("invited-forecast");
  expect(response.instructions).toContain("not new requests");
});

test("attention does not reference or continue a tool result until the server accepts it", () => {
  const harness = setup();
  harness.invite();
  harness.done(harness.replies()[0], [{ id: "lookup-item", type: "function_call", name: "web_search", call_id: "lookup" }]);
  harness.controller.finishToolCall("lookup", { ok: true, output: "fixture forecast" }, false);
  const output = harness.events.find((event) => event.item?.type === "function_call_output")!;
  expect(output.event_id).toBe(output.item!.id);
  expect(harness.replies()).toHaveLength(1);
  harness.audio("background-before-ack");
  expect(harness.checks().at(-1)?.response?.input?.map((item) => item.id)).not.toContain(output.item!.id);
  harness.decide("ignore");
  harness.acknowledge("lookup");
  expect(harness.replies()).toHaveLength(2);
  harness.acknowledge("lookup");
  expect(harness.replies()).toHaveLength(2);
  harness.audio("follow-up-after-ack");
  expect(harness.checks().at(-1)?.response?.input?.map((item) => item.id)).toEqual(expect.arrayContaining(["lookup-item", output.item!.id]));
});

test("attention rejected tool outputs cannot poison later checks or resume a reply", () => {
  const harness = setup();
  harness.invite();
  harness.done(harness.replies()[0], [{ id: "rejected-call-item", type: "function_call", name: "web_search", call_id: "rejected-call" }]);
  harness.controller.finishToolCall("rejected-call", { ok: true, output: "fixture forecast" }, false);
  const output = harness.events.find((event) => event.item?.type === "function_call_output")!;
  harness.controller.handleEvent({ type: "error", error: { event_id: output.item!.id, message: "Tool call ID not found in conversation." } });
  expect(harness.notices).toContain("Realtime rejected the tool result; remaining silent. Reconnect before retrying this request.");
  harness.acknowledge("rejected-call");
  expect(harness.replies()).toHaveLength(1);
  harness.audio("next-invitation");
  expect(harness.checks().at(-1)?.response?.input?.map((item) => item.id)).not.toContain(output.item!.id);
});

test("attention accepts direct invitations and exactly one name-free follow-up", () => {
  const harness = setup();
  harness.audio("invitation");
  harness.decide("direct");
  expect(harness.replies()).toHaveLength(1);
  expect(harness.states.at(-1)).toBe("engaged");
  harness.audio("why-is-that");
  const event = harness.decide("follow_up");
  harness.controller.handleEvent(event);
  expect(harness.replies()).toHaveLength(2);
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was IN CONVERSATION.");
});

test("attention rejects name-free follow-ups before an invitation", () => {
  const harness = setup();
  harness.audio("question-for-someone-else");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(0);
});

test("attention ignores background and quoted-name decisions without extending the window", () => {
  const harness = setup();
  harness.invite();
  harness.advance(ATTENTION_IDLE_MS - 1_000);
  harness.audio("i-asked-elva-yesterday");
  harness.decide("ignore");
  harness.advance(1_001);
  harness.audio("ordinary-call-question");
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was WAITING for a direct invitation.");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(1);
});

test("attention expires at the boundary and accepts a fresh direct invitation", () => {
  const harness = setup();
  harness.invite();
  harness.advance(ATTENTION_IDLE_MS);
  harness.audio("late-follow-up");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(1);
  harness.audio("fresh-invitation");
  harness.decide("direct");
  expect(harness.replies()).toHaveLength(2);
});

test("attention preserves an in-window follow-up while its classification finishes", () => {
  const harness = setup();
  harness.invite();
  harness.advance(ATTENTION_IDLE_MS - 10);
  harness.audio("follow-up-near-expiry");
  harness.advance(11);
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(2);
});

test("attention uses speech start rather than speech completion for follow-up eligibility", () => {
  const harness = setup();
  harness.invite();
  harness.advance(ATTENTION_IDLE_MS - 1_000);
  harness.controller.handleEvent({ type: "input_audio_buffer.speech_started", item_id: "long-follow-up" });
  harness.advance(3_000);
  harness.audio("long-follow-up");
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was IN CONVERSATION.");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(2);
});

test("attention keeps an in-window follow-up eligible while another check is queued", () => {
  const harness = setup();
  harness.invite();
  harness.advance(ATTENTION_IDLE_MS - 1_000);
  harness.audio("background-first");
  harness.audio("queued-follow-up");
  harness.advance(2_000);
  harness.decide("ignore");
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was IN CONVERSATION.");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(2);
});

test("attention joins a follow-up queued behind the invitation that opens the exchange", () => {
  const harness = setup();
  harness.audio("Elva");
  harness.audio("question-immediately-after-name");
  harness.decide("direct");
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was IN CONVERSATION.");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(2);
});

test("attention a fresh invitation reopens the chain for later queued follow-ups after dismissal", () => {
  const harness = setup();
  harness.invite();
  harness.audio("dismissal");
  harness.audio("Elva-one-more-thing");
  harness.audio("question-after-fresh-invitation");
  harness.decide("dismiss");
  harness.decide("direct");
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was IN CONVERSATION.");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(3);
});

test("attention ignoring speech across expiry does not renew the exchange", () => {
  const harness = setup();
  harness.invite();
  harness.advance(ATTENTION_IDLE_MS - 1_000);
  harness.controller.handleEvent({ type: "input_audio_buffer.speech_started", item_id: "long-side-conversation" });
  harness.advance(3_000);
  harness.audio("long-side-conversation");
  harness.decide("ignore");
  harness.audio("unaddressed-after-expiry");
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was WAITING for a direct invitation.");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(1);
});

test("attention dismissal invalidates the active state of a queued follow-up", () => {
  const harness = setup();
  harness.invite();
  harness.audio("dismissal");
  harness.audio("queued-unaddressed-speech");
  harness.decide("dismiss");
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was WAITING for a direct invitation.");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(1);
});

test("attention speech from before a typed invitation cannot interrupt the newer exchange", () => {
  const harness = setup();
  harness.invite();
  harness.controller.handleEvent({ type: "input_audio_buffer.speech_started", item_id: "old-spoken-follow-up" });
  harness.controller.sendText("Elva, help with a different task.");
  harness.audio("old-spoken-follow-up");
  harness.decide("follow_up", true);
  expect(harness.replies()).toHaveLength(2);
  expect(harness.cancellations()).toBe(0);
});

test("attention rejects overdue decisions even if browser timers were throttled", () => {
  const harness = setup();
  harness.audio("old-invitation");
  harness.advance(ATTENTION_CHECK_TIMEOUT_MS + 1);
  harness.decide("direct");
  expect(harness.replies()).toHaveLength(0);
});

test("attention serializes checks and suppresses duplicate committed events", () => {
  const harness = setup();
  harness.audio("first");
  harness.audio("first");
  harness.audio("second");
  expect(harness.checks()).toHaveLength(1);
  harness.decide("ignore");
  expect(harness.checks()).toHaveLength(2);
  expect(harness.checks()[1].response?.input?.at(-1)?.id).toBe("second");
});

for (const text of ["not JSON", '{"action":"direct"}', '{"action":"unknown","cancel_task":false}',
  '{"action":"ignore","cancel_task":true}', '{"action":"direct","cancel_task":false,"extra":"execute"}']) {
  test(`attention fails closed on malformed decision ${text}`, () => {
    const harness = setup();
    harness.audio("uncertain-audio");
    harness.done(harness.checks()[0], [{ type: "function_call", name: "attention_decision", arguments: text }]);
    expect(harness.replies()).toHaveLength(0);
    expect(harness.cancellations()).toBe(0);
  });
}

test("attention never executes tools emitted by a classifier", () => {
  const harness = setup();
  harness.audio("audio");
  harness.done(harness.checks()[0], [{ type: "function_call", name: "coding_task", call_id: "forbidden" }]);
  expect(harness.tools).toEqual([]);
  expect(harness.replies()).toHaveLength(0);
});

test("attention failures and timeouts remain silent and unblock queued audio", async () => {
  const harness = setup(15);
  harness.audio("first");
  const stale = harness.checks()[0];
  harness.audio("second");
  harness.controller.handleEvent({ type: "error", error: { event_id: stale.event_id, message: "denied" } });
  expect(harness.checks()).toHaveLength(2);
  harness.decide("direct", false, stale);
  expect(harness.replies()).toHaveLength(0);
  await expect.poll(() => harness.notices.some((notice) => notice.includes("timed out"))).toBe(true);
  harness.decide("direct");
  expect(harness.replies()).toHaveLength(0);
});

test("attention typed invitations invalidate earlier audio checks", () => {
  const harness = setup();
  harness.audio("old-background");
  const stale = harness.checks()[0];
  harness.invite();
  harness.decide("direct", false, stale);
  expect(harness.replies()).toHaveLength(1);
});

test("attention ignores background interruption phrases but accepts an addressed cancellation", () => {
  const harness = setup();
  harness.invite();
  const priorEvents = harness.events.length;
  harness.controller.handleEvent({ type: "input_audio_buffer.speech_started" });
  harness.controller.handleEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "stop cursor" });
  expect(harness.events).toHaveLength(priorEvents);
  expect(harness.cancellations()).toBe(0);
  harness.audio("stop-the-cursor-task");
  harness.decide("follow_up", true);
  expect(harness.cancellations()).toBe(1);
});

test("attention dismissal returns to waiting without cancelling coding work", () => {
  const harness = setup();
  harness.invite();
  harness.audio("thanks-that-is-all");
  harness.decide("dismiss");
  expect(harness.states.at(-1)).toBe("waiting");
  expect(harness.cancellations()).toBe(0);
  harness.audio("unrelated-question");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(1);
});

test("attention admits only correlated tool calls and resumes a complete batch once", () => {
  const harness = setup();
  harness.invite();
  const event = harness.done(harness.replies()[0], [
    { id: "call-item-one", type: "function_call", name: "read_file", call_id: "call-one", arguments: "{}" },
    { id: "call-item-two", type: "function_call", name: "git_diff", call_id: "call-two", arguments: "{}" }
  ]);
  harness.controller.handleEvent(event);
  expect(harness.tools).toEqual(["call-one", "call-two"]);
  harness.controller.finishToolCall("call-one", { ok: true, output: "file" }, false);
  harness.acknowledge("call-one");
  expect(harness.replies()).toHaveLength(1);
  harness.controller.finishToolCall("call-two", { ok: true, output: "diff" }, false);
  harness.acknowledge("call-two");
  expect(harness.replies()).toHaveLength(2);
  harness.controller.finishToolCall("call-two", { ok: true, output: "duplicate" }, false);
  expect(harness.replies()).toHaveLength(2);
  expect(harness.replies()[1].response?.input).toBeUndefined();
});

test("attention dismissal blocks late tool results from resuming speech", () => {
  const harness = setup();
  harness.invite();
  harness.done(harness.replies()[0], [{ id: "task-item", type: "function_call", name: "coding_task", call_id: "task" }]);
  harness.audio("end-exchange");
  harness.decide("dismiss");
  harness.controller.finishToolCall("task", { ok: true, output: "finished" }, false);
  harness.acknowledge("task");
  expect(harness.replies()).toHaveLength(1);
  expect(harness.events.some((event) => event.item?.call_id === "task")).toBe(true);
});

test("attention old tool results cannot interrupt a newer invited turn", () => {
  const harness = setup();
  harness.invite();
  harness.done(harness.replies()[0], [{ type: "function_call", name: "coding_task", call_id: "old-task" }]);
  harness.controller.sendText("Elva, answer a different question.");
  harness.controller.finishToolCall("old-task", { ok: true, output: "late" }, false);
  harness.acknowledge("old-task");
  expect(harness.replies()).toHaveLength(2);
});

test("attention keeps the exchange active through authorized audio playback", () => {
  const harness = setup();
  harness.invite();
  const request = harness.replies()[0];
  const responseId = `response-${request.event_id}`;
  harness.controller.handleEvent({ type: "response.created", response: { id: responseId, metadata: request.response!.metadata } });
  harness.controller.handleEvent({ type: "output_audio_buffer.started", response_id: responseId });
  harness.advance(ATTENTION_IDLE_MS + 1);
  harness.audio("follow-up-during-answer");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(2);
  expect(harness.events.some((event) => event.type === "output_audio_buffer.clear")).toBe(true);
});

test("attention disposal drops late decisions, tool outputs, and reconnect-era events", () => {
  const harness = setup();
  harness.audio("old-session");
  const request = harness.checks()[0];
  harness.controller.dispose();
  harness.decide("direct", false, request);
  harness.audio("after-disconnect");
  expect(harness.replies()).toHaveLength(0);
  expect(harness.checks()).toHaveLength(1);
});

test("attention dismissal clears audio that is generated but has not started playing", () => {
  const harness = setup();
  harness.invite();
  const reply = harness.replies()[0];
  const responseId = "buffered-response";
  harness.controller.handleEvent({ type: "response.created", response: { id: responseId, metadata: reply.response!.metadata } });
  harness.audio("dismissal");
  harness.decide("dismiss");
  expect(harness.events.some((event) => event.type === "output_audio_buffer.clear")).toBe(true);
  harness.controller.handleEvent({ type: "output_audio_buffer.started", response_id: responseId });
  expect(harness.states.at(-1)).toBe("waiting");
});

test("attention dismissal preserves a newer invitation queued during classification", () => {
  const harness = setup();
  harness.invite();
  harness.audio("dismissal");
  harness.audio("Elva-one-more-thing");
  harness.decide("dismiss");
  expect(harness.checks()).toHaveLength(2);
  expect(harness.checks().at(-1)?.response?.instructions).toContain("At the start of this turn, Elva was WAITING for a direct invitation.");
  harness.decide("direct");
  expect(harness.replies()).toHaveLength(2);
});

test("attention authorized playback reopens an exchange after generation delay", async () => {
  const harness = setup(undefined, 15);
  harness.invite();
  const request = harness.replies()[0];
  const responseId = "slow-response";
  await expect.poll(() => harness.states.at(-1)).toBe("waiting");
  harness.controller.handleEvent({ type: "response.created", response: { id: responseId, metadata: request.response!.metadata } });
  harness.controller.handleEvent({ type: "output_audio_buffer.started", response_id: responseId });
  expect(harness.states.at(-1)).toBe("engaged");
  harness.audio("follow-up-during-playback");
  harness.decide("follow_up");
  expect(harness.replies()).toHaveLength(2);
});

test("attention stale playback cannot clear a newer buffered reply", () => {
  const harness = setup();
  harness.invite();
  harness.controller.handleEvent({ type: "response.created", response: {
    id: "old-response", metadata: harness.replies()[0].response!.metadata
  } });
  harness.audio("dismiss-old-response");
  harness.decide("dismiss");
  harness.invite();
  harness.controller.handleEvent({ type: "response.created", response: {
    id: "new-response", metadata: harness.replies()[1].response!.metadata
  } });
  const clears = harness.events.filter((event) => event.type === "output_audio_buffer.clear").length;
  harness.controller.handleEvent({ type: "output_audio_buffer.started", response_id: "old-response" });
  expect(harness.events.filter((event) => event.type === "output_audio_buffer.clear")).toHaveLength(clears);
});

test("attention requests a private structured decision rather than free-form JSON", () => {
  const harness = setup();
  harness.audio("invitation");
  expect(harness.checks()[0].response?.tools).toEqual([expect.objectContaining({
    type: "function", name: "attention_decision"
  })]);
  expect(harness.checks()[0].response?.max_output_tokens).toBe(512);
});

test("attention accepts the private decision function without executing it as a tool", () => {
  const harness = setup();
  harness.audio("invitation");
  harness.done(harness.checks()[0], [{
    type: "function_call", name: "attention_decision", call_id: "private-decision",
    arguments: '{"action":"direct","cancel_task":false}'
  }]);
  expect(harness.replies()).toHaveLength(1);
  expect(harness.tools).toEqual([]);
});

test("attention accepts one private decision alongside silent model commentary", () => {
  const harness = setup();
  harness.audio("explicit-cancellation");
  harness.done(harness.checks()[0], [
    { type: "message", content: [{ type: "output_text", text: "This is addressed to Elva." }] },
    { type: "function_call", name: "attention_decision", arguments: '{"action":"direct","cancel_task":true}' }
  ]);
  expect(harness.replies()).toHaveLength(1);
  expect(harness.cancellations()).toBe(1);
  expect(harness.tools).toEqual([]);
});

test("attention rejects extra function calls even alongside a valid decision", () => {
  const harness = setup();
  harness.audio("untrusted-audio");
  harness.done(harness.checks()[0], [
    { type: "function_call", name: "attention_decision", arguments: '{"action":"direct","cancel_task":false}' },
    { type: "function_call", name: "coding_task", call_id: "must-not-run", arguments: "{}" }
  ]);
  expect(harness.replies()).toHaveLength(0);
  expect(harness.tools).toEqual([]);
});
