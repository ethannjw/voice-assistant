import { expect, test, type Page } from "@playwright/test";
import { emitInvitedRealtimeReply, installRealtimeBrowserFakes } from "./support/realtime-browser";

type SentEvent = {
  type: string;
  response?: {
    conversation?: string;
    output_modalities?: string[];
    tools?: unknown[];
    metadata?: Record<string, string>;
    input?: { type: string; id: string }[];
  };
};

async function sentEvents(page: Page): Promise<SentEvent[]> {
  return page.evaluate(() => (window as unknown as {
    __e2eRealtimeEvents: SentEvent[];
  }).__e2eRealtimeEvents);
}

async function emit(page: Page, event: unknown) {
  await page.evaluate((value) => {
    (window as unknown as {
      __e2eRealtimeDataChannel: { onmessage: ((event: MessageEvent) => void) | null };
    }).__e2eRealtimeDataChannel.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify(value)
    }));
  }, event);
}

async function connect(page: Page) {
  await installRealtimeBrowserFakes(page);
  await page.route("**/api/realtime/call", (route) => route.fulfill({
    status: 200, contentType: "application/sdp", body: "e2e-answer"
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Connected");
}

async function decide(page: Page, action: string, cancelTask = false) {
  const check = (await sentEvents(page)).filter((event) => event.response?.metadata?.attention_check).at(-1)!;
  const response = { id: `check-${check.response!.metadata!.attention_check}`, metadata: check.response!.metadata };
  await emit(page, { type: "response.created", response });
  await emit(page, { type: "response.done", response: { ...response, status: "completed", output: [{
    type: "function_call", name: "attention_decision", arguments: JSON.stringify({ action, cancel_task: cancelTask })
  }] } });
}

async function replyCount(page: Page) {
  return (await sentEvents(page)).filter((event) => event.response?.metadata?.attention_reply).length;
}

test("attention disables automatic speech responses and interruptions", async ({ request }) => {
  const response = await request.get("/api/realtime/session");
  const { session } = await response.json();
  expect(session.audio.input.turn_detection).toMatchObject({
    type: "semantic_vad", create_response: false, interrupt_response: false
  });
});

test("attention connection is silent until Elva is invited", async ({ page }) => {
  await connect(page);
  expect((await sentEvents(page)).filter((event) => event.type === "response.create")).toEqual([]);
});

test("attention search result completes a persisted tool cycle without missing-call or item errors", async ({ page }) => {
  await page.route("**/api/tools/web_search", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ ok: true, output: "Synthetic forecast: purple clouds, nineteen degrees." })
  }));
  await connect(page);
  await emitInvitedRealtimeReply(page, "Elva, look up the synthetic forecast.", [{
    id: "forecast-call-item", type: "function_call", name: "web_search", call_id: "forecast-call", arguments: '{"query":"synthetic forecast"}'
  }]);
  await expect.poll(() => replyCount(page)).toBe(2);
  await expect(page.locator("article.message.tool").filter({ hasText: "Synthetic forecast:" })).toContainText("purple clouds");
  const continuation = (await sentEvents(page)).filter((event) => event.response?.metadata?.attention_reply).at(-1)!;
  expect(continuation.response?.conversation).toBe("auto");
  expect(continuation.response?.input).toBeUndefined();
  await emit(page, { type: "response.done", response: {
    id: "forecast-reply", metadata: continuation.response!.metadata, status: "completed", output: [{
      id: "forecast-message", type: "message", role: "assistant", content: [{ type: "output_audio", transcript: "Purple clouds, nineteen degrees." }]
    }]
  } });
  await emit(page, { type: "input_audio_buffer.committed", item_id: "forecast-follow-up" });
  await decide(page, "follow_up");
  await expect.poll(() => replyCount(page)).toBe(3);
  await expect(page.locator("article.message.system").filter({ hasText: /not found in conversation|does not exist|rejected the tool result/ })).toHaveCount(0);
});

test("attention delivers scraped values through the real search route and continues without a second invitation", async ({ page }) => {
  await connect(page);
  await emitInvitedRealtimeReply(page, "Elva, find the Glass Harbor forecast.", [{
    id: "scraped-search-item", type: "function_call", name: "web_search", call_id: "scraped-search", arguments: '{"query":"Glass Harbor high low forecast"}'
  }]);
  await expect(page.locator("article.message.tool").filter({ hasText: "Page content" })).toContainText("high 31°C, low 24°C");
  await expect.poll(() => replyCount(page)).toBe(2);
  const outputs = await page.evaluate(() => (window as unknown as {
    __e2eRealtimeEvents: { item?: { type?: string; call_id?: string; output?: string } }[];
  }).__e2eRealtimeEvents.filter((event) => event.item?.call_id === "scraped-search" && event.item.type === "function_call_output"));
  expect(outputs).toHaveLength(1);
  const result = JSON.parse(outputs[0].item!.output!);
  expect(result.output).toContain("high 31°C, low 24°C");
  expect(result.metadata.sources[0]).toMatchObject({ contentStatus: "scraped", url: "https://example.test/firecrawl-result" });
});

test("attention checks committed audio without speech or workspace tools", async ({ page }) => {
  await connect(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "audio-background" });
  await expect.poll(async () => (await sentEvents(page)).filter(
    (event) => event.response?.metadata?.attention_check
  ).length).toBe(1);
  const check = (await sentEvents(page)).find((event) => event.response?.metadata?.attention_check)!;
  expect(check.response).toMatchObject({
    conversation: "none", output_modalities: ["text"], tools: [{ type: "function", name: "attention_decision" }],
    input: [{ type: "item_reference", id: "audio-background" }]
  });
});

test("attention ignores uninvited Realtime tool calls", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/api/tools/**", async (route) => {
    calls.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"output":"unexpected"}' });
  });
  await connect(page);
  await emit(page, { type: "response.done", response: {
    id: "uninvited", status: "completed", output: [{
      type: "function_call", name: "coding_task", call_id: "uninvited-task",
      arguments: '{"task":"this background conversation is not a command"}'
    }]
  } });
  expect(calls).toEqual([]);
});

test("attention browser accepts an invitation and natural follow-up but ignores side conversation", async ({ page }) => {
  await connect(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "Elva-help-with-this-error" });
  await decide(page, "direct");
  await expect(page.getByLabel("Conversation attention")).toHaveText("In conversation");
  expect(await replyCount(page)).toBe(1);

  await emit(page, { type: "input_audio_buffer.committed", item_id: "Alex-can-you-share-your-screen" });
  await decide(page, "ignore");
  expect(await replyCount(page)).toBe(1);

  await emit(page, { type: "input_audio_buffer.committed", item_id: "why-does-that-happen" });
  await decide(page, "follow_up");
  expect(await replyCount(page)).toBe(2);
});

test("attention browser returns to waiting after 30 seconds despite background speech", async ({ page }) => {
  await connect(page);
  await page.clock.install();
  await emit(page, { type: "input_audio_buffer.committed", item_id: "invitation" });
  await decide(page, "direct");
  await page.clock.fastForward(29_000);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "unrelated-call-discussion" });
  await decide(page, "ignore");
  await page.clock.fastForward(1_001);
  await expect(page.getByLabel("Conversation attention")).toHaveText("Waiting for Elva");
  await emit(page, { type: "input_audio_buffer.committed", item_id: "question-without-invitation" });
  await decide(page, "follow_up");
  expect(await replyCount(page)).toBe(1);
});

test("attention browser preserves a follow-up started before the idle window ends", async ({ page }) => {
  await connect(page);
  await page.clock.install();
  await emit(page, { type: "input_audio_buffer.committed", item_id: "initial-invitation" });
  await decide(page, "direct");
  await page.clock.fastForward(29_000);
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "name-free-follow-up" });
  await page.clock.fastForward(2_000);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "name-free-follow-up" });
  await page.clock.fastForward(1_000);
  await decide(page, "follow_up");
  expect(await replyCount(page)).toBe(2);
  await expect(page.getByLabel("Conversation attention")).toHaveText("In conversation");
});

test("attention browser dismissal is silent and requires another invitation", async ({ page }) => {
  await connect(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "invitation" });
  await decide(page, "direct");
  await emit(page, { type: "input_audio_buffer.committed", item_id: "thanks-that-is-all" });
  await decide(page, "dismiss");
  await expect(page.getByLabel("Conversation attention")).toHaveText("Waiting for Elva");
  expect(await replyCount(page)).toBe(1);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "call-discussion" });
  await decide(page, "follow_up");
  expect(await replyCount(page)).toBe(1);
});

test("attention browser reconnect cannot accept an old decision", async ({ page }) => {
  await connect(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "old-invitation" });
  const oldCheck = (await sentEvents(page)).find((event) => event.response?.metadata?.attention_check)!;
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Connected");
  await emit(page, { type: "response.done", response: {
    metadata: oldCheck.response!.metadata, status: "completed", output: [{
      type: "function_call", name: "attention_decision", arguments: '{"action":"direct","cancel_task":false}'
    }]
  } });
  expect(await replyCount(page)).toBe(0);
  await expect(page.getByLabel("Conversation attention")).toHaveText("Waiting for Elva");
});

test("attention browser disconnects if the server enables automatic replies", async ({ page }) => {
  await connect(page);
  await emit(page, { type: "session.updated", session: { audio: { input: {
    turn_detection: { create_response: true, interrupt_response: true }
  } } } });
  await expect(page.locator(".status-pill")).toHaveText("Error");
  expect(await replyCount(page)).toBe(0);
});

test("attention session configuration failure cannot leave a voice connection open", async ({ page }) => {
  await installRealtimeBrowserFakes(page);
  await page.route("**/api/realtime/session", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.route("**/api/realtime/call", (route) => route.fulfill({ status: 200, body: "e2e-answer" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Error");
});

test("attention microphone stays disabled until confirmation and disconnects on timeout", async ({ page }) => {
  await installRealtimeBrowserFakes(page, { confirmSession: false });
  await page.route("**/api/realtime/call", (route) => route.fulfill({ status: 200, body: "e2e-answer" }));
  await page.goto("/");
  await page.clock.install();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(async () => (await sentEvents(page)).some((event) => event.type === "session.update")).toBe(true);
  expect(await page.evaluate(() => (window as unknown as {
    __e2eMicrophoneTrack: { enabled: boolean };
  }).__e2eMicrophoneTrack.enabled)).toBe(false);
  await page.clock.fastForward(10_001);
  await expect(page.locator(".status-pill")).toHaveText("Error");
});
