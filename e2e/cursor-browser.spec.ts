import { randomUUID } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { e2eRoot, e2eWorkspace } from "./support/paths";
import { emitInvitedRealtimeReply, installRealtimeBrowserFakes } from "./support/realtime-browser";

let workspace: string;
let browserErrors: string[];

test.beforeEach(async ({ page, request }) => {
  workspace = path.join(e2eRoot, "browser", randomUUID());
  await cp(e2eWorkspace, workspace, { recursive: true });
  const selected = await request.post("/api/projects", { data: { name: "Cursor browser fixture", path: workspace } });
  expect(selected.status()).toBe(201);
  browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === "fonts.googleapis.com") {
      await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return;
    }
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      browserErrors.push(`Unexpected external request: ${hostname}`);
      await route.abort();
    } else {
      await route.continue();
    }
  });
});

test.afterEach(() => expect(browserErrors).toEqual([]));

async function sendText(page: Page, text: string) {
  const input = page.getByPlaceholder("Ask by text — Enter to send, ⌘Enter from anywhere");
  await input.fill(text);
  await input.press("Enter");
}

async function connectRealtime(page: Page) {
  await installRealtimeBrowserFakes(page);
  await page.route("**/api/realtime/call", (route) => route.fulfill({
    status: 200, contentType: "application/sdp", body: "e2e-answer"
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Connected");
}

async function emitTask(page: Page, task: string) {
  await emitInvitedRealtimeReply(page, `Elva, ${task}`, [{
    id: "cursor-connected-item", type: "function_call", name: "coding_task", call_id: "cursor-connected-call",
    arguments: JSON.stringify({ task })
  }]);
}

test("typed task reaches the real Cursor adapter and returns its response", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Coding harness: Cursor")).toBeVisible();
  await sendText(page, "CURSOR_BROWSER_TASK");
  await expect(page.locator("article.message.assistant")).toContainText("completed: CURSOR_BROWSER_TASK");
  await expect(page.locator("article.message.assistant")).toContainText("Fake Cursor (cursor-e2e-model");
});

for (const decision of ["Approve", "Decline"] as const) {
  test(`browser ${decision.toLowerCase()} controls a real fixture file change`, async ({ page }) => {
    await page.goto("/");
    await sendText(page, "e2e:edit");
    await expect(page.getByRole("heading", { name: "Coding approval" })).toBeVisible();
    await expect(readFile(path.join(workspace, "agent-result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await page.getByRole("button", { name: decision, exact: true }).click();
    await expect(page.locator("article.message.assistant")).toContainText(
      decision === "Approve" ? "permission=allow-once" : "permission=reject-once"
    );
    await expect(page.getByRole("heading", { name: "Coding approval" })).toHaveCount(0);
    if (decision === "Approve") {
      expect(await readFile(path.join(workspace, "agent-result.txt"), "utf8")).toBe("implemented by cursor\n");
    } else {
      await expect(readFile(path.join(workspace, "agent-result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
}

test("persistent-only permission never displays an ordinary Approve button", async ({ page }) => {
  await page.goto("/");
  await sendText(page, "needs approval persistent-only");
  await expect(page.getByRole("heading", { name: "Coding approval" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.locator("article.message.assistant")).toContainText("permission=reject-once");
});

test("Realtime task crosses the server and approval UI and returns exactly one correlated result", async ({ page }) => {
  await connectRealtime(page);
  await emitTask(page, "e2e:edit");
  await expect(page.getByRole("heading", { name: "Coding approval" })).toBeVisible();
  await expect(page.locator("article.message.tool").first()).toContainText("Cursor · coding_task · running");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator("article.message.tool").first()).toContainText("Cursor · coding_task · finished");
  const events = await page.evaluate(() => (window as unknown as {
    __e2eRealtimeEvents: { type: string; item?: { type: string; call_id: string; output: string } }[];
  }).__e2eRealtimeEvents);
  const outputs = events.filter((event) => event.item?.type === "function_call_output");
  expect(outputs).toHaveLength(1);
  expect(outputs[0].item?.call_id).toBe("cursor-connected-call");
  expect(JSON.parse(outputs[0].item!.output)).toMatchObject({ ok: true, metadata: { provider: "cursor", status: "end_turn" } });
  expect(await readFile(path.join(workspace, "agent-result.txt"), "utf8")).toBe("implemented by cursor\n");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
});

test("Realtime disconnect cancels the backend approval without changing files", async ({ page, request }) => {
  await connectRealtime(page);
  await emitTask(page, "e2e:edit");
  await expect(page.getByRole("heading", { name: "Coding approval" })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect.poll(async () => {
    const response = await request.get("/api/coding-agent/approvals");
    return (await response.json()).approvals;
  }).toEqual([]);
  await expect(readFile(path.join(workspace, "agent-result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(page.locator("article.message.tool").first()).toContainText("interrupted");
});

test("Realtime background speech cannot cancel an approved Cursor task", async ({ page }) => {
  await connectRealtime(page);
  await emitTask(page, "e2e:edit");
  await expect(page.getByRole("heading", { name: "Coding approval" })).toBeVisible();
  await page.evaluate(() => {
    const channel = (window as unknown as {
      __e2eRealtimeDataChannel: { onmessage: ((event: MessageEvent) => void) | null };
    }).__e2eRealtimeDataChannel;
    for (const event of [
      { type: "input_audio_buffer.speech_started" },
      { type: "conversation.item.input_audio_transcription.completed", transcript: "stop cursor" }
    ]) channel.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  });
  await expect(page.getByRole("heading", { name: "Coding approval" })).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator("article.message.tool").first()).toContainText("finished");
  expect(await readFile(path.join(workspace, "agent-result.txt"), "utf8")).toBe("implemented by cursor\n");
});

test("Realtime accepted spoken cancellation stops Cursor without applying files", async ({ page, request }) => {
  await connectRealtime(page);
  await emitTask(page, "e2e:edit");
  await expect(page.getByRole("heading", { name: "Coding approval" })).toBeVisible();
  await page.evaluate(() => {
    const browser = window as unknown as {
      __e2eRealtimeEvents: { response?: { metadata?: Record<string, string> } }[];
      __e2eRealtimeDataChannel: { onmessage: ((event: MessageEvent) => void) | null };
    };
    const emit = (event: unknown) => browser.__e2eRealtimeDataChannel.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) })
    );
    emit({ type: "input_audio_buffer.committed", item_id: "Elva-cancel-cursor" });
    const check = browser.__e2eRealtimeEvents.filter((event) => event.response?.metadata?.attention_check).at(-1)!;
    emit({ type: "response.done", response: {
      id: "accepted-cancellation", status: "completed", metadata: check.response!.metadata,
      output: [{ type: "function_call", name: "attention_decision", arguments: '{"action":"follow_up","cancel_task":true}' }]
    } });
  });
  await expect.poll(async () => (await (await request.get("/api/coding-agent/approvals")).json()).approvals).toEqual([]);
  await expect(page.locator("article.message.tool").first()).toContainText("interrupted");
  await expect(readFile(path.join(workspace, "agent-result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});
