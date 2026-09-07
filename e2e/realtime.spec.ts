import { expect, test } from "@playwright/test";
import { installRealtimeBrowserFakes } from "./support/realtime-browser";
import { deselectWorkspace } from "./support/workspace";

test.beforeEach(async ({ request }) => {
  await deselectWorkspace(request);
});

test("connects and requests the one-time Elva greeting after session registration", async ({ page }) => {
  await installRealtimeBrowserFakes(page);
  await page.route("**/api/realtime/call", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/sdp", body: "e2e-answer" });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".status-pill")).toHaveText("Connected");

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __e2eRealtimeEvents: unknown[] }).__e2eRealtimeEvents.length
      )
    )
    .toBe(2);

  const sentEvents = await page.evaluate(
    () => (window as unknown as { __e2eRealtimeEvents: unknown[] }).__e2eRealtimeEvents
  );
  expect(sentEvents[0]).toMatchObject({
    type: "session.update",
    session: {
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "codex_task" }),
        expect.objectContaining({ name: "web_search" })
      ])
    }
  });
  expect(sentEvents[1]).toMatchObject({
    type: "response.create",
    response: {
      instructions: expect.stringContaining("Greet the user once as Elva")
    }
  });

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator(".status-pill")).toHaveText("Disconnected");
});
