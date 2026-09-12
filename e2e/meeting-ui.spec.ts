import { expect, test } from "@playwright/test";
import { selectE2eWorkspace } from "./support/workspace";

test("Teams uses the existing tools and transcript UI without opening the local microphone", async ({page, request}, testInfo) => {
  await selectE2eWorkspace(request);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {configurable: true, value: {getUserMedia: () => {throw new Error("Teams must not open the local microphone");}}});
  });
  await page.route("**/api/config", async route => {
    const response = await route.fetch();
    await route.fulfill({json: {...await response.json(), meeting: {mode: "teams", url: "https://teams.microsoft.com/meet/123", name: "Elva AI assistant", durationMinutes: 120}}});
  });
  await page.route("**/api/meeting/start", route => route.fulfill({json: {token: "test-control-token", path: "/api/meeting/control"}}));
  const sent: Record<string, any>[] = [];
  let reply = 0;
  let closed = false;
  await page.routeWebSocket("**/api/meeting/control", socket => {
    socket.onClose(() => {closed = true;});
    socket.onMessage(raw => {
      const event = JSON.parse(raw.toString());
      sent.push(event);
      const emit = (data: unknown) => socket.send(JSON.stringify(data));
      if (event.type === "session.update") {
        emit({type: "session.updated", session: event.session});
        emit({type: "elva.meeting.status", state: "Joined - Not Recording"});
      }
      if (event.type === "conversation.item.create") emit({type: "conversation.item.added", item: event.item});
      if (event.type === "response.create" && event.response.metadata?.attention_reply) {
        const response = {id: `reply-${++reply}`, metadata: event.response.metadata};
        emit({type: "response.created", response});
        if (reply === 1) emit({type: "response.done", response: {...response, status: "completed", output: [{id: "tool-item", type: "function_call", name: "workspace_status", call_id: "tool-call", arguments: "{}"}]}});
        else {
          emit({type: "response.output_audio_transcript.done", response_id: response.id, transcript: "Workspace checked through the existing harness."});
          emit({type: "response.done", response: {...response, status: "completed", output: []}});
        }
      }
    });
  });
  await page.goto("/");
  await expect(page.getByLabel("Session mode")).toHaveValue("teams");
  await page.getByRole("button", {name: "Join meeting", exact: true}).click();
  await expect(page.locator(".status-pill")).toHaveText("Connected");
  await expect(page.getByLabel("Meeting status")).toHaveText("Joined - Not Recording");
  const registered = sent.find(event => event.type === "session.update")?.session.tools.map((tool: {name: string}) => tool.name);
  expect(registered).toEqual(expect.arrayContaining(["coding_task", "mcp_list", "mcp_call", "read_file", "workspace_status"]));
  await page.getByPlaceholder("Ask by text — Enter to send, ⌘Enter from anywhere").fill("Elva, report the workspace status.");
  await page.getByPlaceholder("Ask by text — Enter to send, ⌘Enter from anywhere").press("Enter");
  await expect(page.locator("article.message.tool").last()).toContainText("workspace");
  await expect(page.locator("article.message.assistant")).toContainText("Workspace checked through the existing harness.");
  await page.screenshot({path: testInfo.outputPath("teams-mode.png"), fullPage: true});
  await page.getByRole("button", {name: "Mute", exact: true}).click();
  expect(sent.some(event => event.type === "elva.mute" && event.muted)).toBeTruthy();
  await page.getByRole("button", {name: "Leave meeting", exact: true}).click();
  await expect(page.locator(".status-pill")).toHaveText("Disconnected");
  await expect.poll(() => closed).toBeTruthy();
});
