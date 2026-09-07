import { expect, test } from "@playwright/test";
import { installRealtimeBrowserFakes } from "./support/realtime-browser";
import { deselectWorkspace } from "./support/workspace";

test.beforeEach(async ({ request }) => {
  await deselectWorkspace(request);
});

test("loads the application in a real Chromium browser", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Voice Pair Programmer" })).toBeVisible();
  await expect(page.getByLabel("Coding harness: Cursor")).toBeVisible();
  await expect(page.locator(".status-pill")).toHaveText("Idle");
  await expect(page.getByRole("button", { name: "Connect" })).toBeEnabled();
  await expect(page.getByText("No project selected", { exact: true }).first()).toBeVisible();
});

test("shows Codex when configured as the coding harness", async ({ page }) => {
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        activeProject: null,
        projects: [],
        realtimeModel: "gpt-realtime-2",
        voice: "marin",
        codingAgent: "codex",
        codingModel: "gpt-5.4"
      })
    });
  });

  await page.goto("/");
  await expect(page.getByLabel("Coding harness: Codex")).toBeVisible();
});

test("renders disconnected text turns", async ({ page }) => {
  await page.route("**/api/coding-agent/message", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ text: "Explain the current state" });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "E2E disconnected response" })
    });
  });

  await page.goto("/");
  const input = page.getByPlaceholder("Ask by text — Enter to send, ⌘Enter from anywhere");
  await input.fill("Explain the current state");
  await input.press("Enter");

  await expect(page.locator("article.message.user")).toContainText("Explain the current state");
  await expect(page.locator("article.message.assistant")).toContainText("E2E disconnected response");
});

test("uses generic coding-agent approvals and labels Cursor requests", async ({ page }) => {
  let resolved = false;
  let decision: unknown = null;
  let legacyRequests = 0;
  const approval = {
    id: "cursor-approval-e2e",
    kind: "cursor_tool",
    title: "Run npm test",
    reason: "execute",
    command: "npm test",
    cwd: "/tmp/project",
    grantRoot: null,
    diff: null,
    availableDecisions: ["accept", "acceptForSession", "decline"],
    createdAt: new Date().toISOString()
  };

  await page.route("**/api/coding-agent/approvals**", async (route) => {
    if (route.request().method() === "POST") {
      decision = route.request().postDataJSON();
      resolved = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ approvals: resolved ? [] : [approval] })
    });
  });
  await page.route("**/api/codex/approvals**", async (route) => {
    legacyRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"approvals":[]}' });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Coding approval" })).toBeVisible();
  await expect(page.getByText("Cursor tool", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  await expect.poll(() => decision).toEqual({ decision: "accept" });
  expect(legacyRequests).toBe(0);
});

test("shows a microphone permission failure", async ({ page }) => {
  await installRealtimeBrowserFakes(page, { microphoneError: "E2E microphone denied" });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.locator(".status-pill")).toHaveText("Error");
  await expect(page.locator(".mic-banner")).toContainText("E2E microphone denied");
});
