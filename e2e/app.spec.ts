import { expect, test } from "@playwright/test";
import { installRealtimeBrowserFakes } from "./support/realtime-browser";
import { deselectWorkspace } from "./support/workspace";

test.beforeEach(async ({ request }) => {
  await deselectWorkspace(request);
});

test("loads the application in a real Chromium browser", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Voice Pair Programmer" })).toBeVisible();
  await expect(page.locator(".status-pill")).toHaveText("Idle");
  await expect(page.getByRole("button", { name: "Connect" })).toBeEnabled();
  await expect(page.getByText("No project selected", { exact: true }).first()).toBeVisible();
});

test("renders disconnected text turns", async ({ page }) => {
  await page.route("**/api/codex/message", async (route) => {
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

test("shows a microphone permission failure", async ({ page }) => {
  await installRealtimeBrowserFakes(page, { microphoneError: "E2E microphone denied" });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.locator(".status-pill")).toHaveText("Error");
  await expect(page.locator(".mic-banner")).toContainText("E2E microphone denied");
});
