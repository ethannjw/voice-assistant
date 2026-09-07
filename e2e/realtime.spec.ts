import path from "node:path";
import { expect, test } from "@playwright/test";
import { PROJECT_SCOPED_REALTIME_TOOLS, REALTIME_TOOLS } from "../src/server/realtime";
import { WORKSPACE_TOOL_NAMES, type ToolResult } from "../src/shared/contracts";
import { e2eWorkspace } from "./support/paths";
import { installRealtimeBrowserFakes } from "./support/realtime-browser";
import { deselectWorkspace, selectE2eWorkspace } from "./support/workspace";

type RealtimeSessionUpdate = {
  session: {
    instructions: string;
    tools: { type: string; name: string; description: string; parameters: unknown }[];
  };
};

/** Every workspace tool plus the two delegation tools, in registration order. */
const EXPECTED_REALTIME_TOOL_NAMES = [
  "coding_task",
  "workspace_status",
  "search_workspace",
  "read_file",
  "git_diff",
  "run_tests",
  "propose_patch",
  "web_search"
] as const;

test.beforeEach(async ({ request }) => {
  await deselectWorkspace(request);
});

test("connects and requests the one-time Elva greeting after session registration", async ({ page }) => {
  await installRealtimeBrowserFakes(page);
  await page.route("**/api/realtime/call", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/sdp", body: "e2e-answer" });
  });

  await page.goto("/");
  await expect(page.getByLabel("Coding harness: Cursor")).toBeVisible();
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
      tools: expect.arrayContaining(
        EXPECTED_REALTIME_TOOL_NAMES.map((name) => expect.objectContaining({ name }))
      )
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

test("shows coding_task progress for realtime delegation", async ({ page }) => {
  await installRealtimeBrowserFakes(page);
  await page.route("**/api/realtime/call", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/sdp", body: "e2e-answer" });
  });

  let releaseToolResponse!: () => void;
  const toolResponseGate = new Promise<void>((resolve) => {
    releaseToolResponse = resolve;
  });
  await page.route("**/api/tools/coding_task", async (route) => {
    await toolResponseGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, output: "Cursor completed the task." })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".status-pill")).toHaveText("Connected");
  await page.evaluate(() => {
    const channel = (
      window as unknown as {
        __e2eRealtimeDataChannel: { onmessage: ((event: MessageEvent) => void) | null };
      }
    ).__e2eRealtimeDataChannel;
    channel.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.done",
          response: {
            status: "completed",
            output: [
              {
                type: "function_call",
                name: "coding_task",
                call_id: "coding-call-e2e",
                arguments: JSON.stringify({ task: "update the selected project" })
              }
            ]
          }
        })
      })
    );
  });

  await expect(page.locator("article.message.tool").first()).toContainText(
    "Cursor · coding_task · running"
  );
  releaseToolResponse();
  await expect(page.locator("article.message.tool").first()).toContainText(
    "Cursor · coding_task · finished"
  );
});

test.describe("realtime tool registry", () => {
  test("exposes every workspace tool to the realtime model", async ({ request }) => {
    const response = await request.get("/api/realtime/session");
    expect(response.status()).toBe(200);
    const { session } = (await response.json()) as RealtimeSessionUpdate;

    const exposedNames = session.tools.map((tool) => tool.name);
    expect(exposedNames).toEqual([...EXPECTED_REALTIME_TOOL_NAMES]);
    // The registry served to the model must cover the whole shared workspace contract.
    for (const workspaceTool of WORKSPACE_TOOL_NAMES) {
      expect(exposedNames).toContain(workspaceTool);
    }
    expect(REALTIME_TOOLS.map((tool) => tool.name)).toEqual(exposedNames);
  });

  test("declares a usable function schema for every exposed tool", async ({ request }) => {
    const response = await request.get("/api/realtime/session");
    const { session } = (await response.json()) as RealtimeSessionUpdate;

    for (const tool of session.tools) {
      expect(tool.type, tool.name).toBe("function");
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.parameters, tool.name).toMatchObject({
        type: "object",
        additionalProperties: false
      });
    }

    expect(session.tools.find((tool) => tool.name === "read_file")).toMatchObject({
      parameters: {
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    });
    expect(session.tools.find((tool) => tool.name === "search_workspace")).toMatchObject({
      parameters: {
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    });
    expect(session.tools.find((tool) => tool.name === "propose_patch")).toMatchObject({
      parameters: {
        properties: { diff: { type: "string" } },
        required: ["diff"]
      }
    });
    // Argument-free tools still need an object schema the Realtime API accepts.
    for (const name of ["workspace_status", "git_diff", "run_tests"]) {
      expect(session.tools.find((tool) => tool.name === name), name).toMatchObject({
        parameters: { properties: {}, required: [] }
      });
    }
  });

  test("instructs Elva to prefer fast tools and delegate real work to coding_task", async ({
    request
  }) => {
    await selectE2eWorkspace(request);
    const response = await request.get("/api/realtime/session");
    const { session } = (await response.json()) as RealtimeSessionUpdate;

    expect(session.instructions).toContain("Fast read-only workspace tools:");
    expect(session.instructions).toContain(
      "For code implementation, file changes, multi-step investigation"
    );
    expect(session.instructions).toContain("call coding_task so the configured Cursor agent does the work");
    expect(session.instructions).toContain("Call it only when the user explicitly asks to run the tests");
    expect(session.instructions).toContain("propose_patch only stages a unified diff");
    expect(session.instructions).toContain(
      "All workspace tools require a selected project and accept workspace-relative paths only."
    );
    expect(session.instructions).toContain("a project is selected.");
  });

  test("withholds the project-scoped tools while no project is selected", async ({ request }) => {
    const response = await request.get("/api/realtime/session");
    const { session } = (await response.json()) as RealtimeSessionUpdate;

    expect(session.instructions).toContain("no project is selected.");
    expect(session.instructions).toContain(
      `Do not call these tools until a project is selected: ${PROJECT_SCOPED_REALTIME_TOOLS.join(", ")}.`
    );
    expect(session.instructions).toContain("web_search still works without a project.");
  });
});

test.describe("workspace tool execution from the realtime path", () => {
  test("every workspace tool refuses to run while no project is selected", async ({ request }) => {
    for (const name of WORKSPACE_TOOL_NAMES) {
      const response = await request.post(`/api/tools/${name}`, { data: {} });
      expect(response.status(), name).toBe(400);
      const payload = (await response.json()) as ToolResult;
      expect(payload.ok, name).toBe(false);
      expect(payload.output, name).toContain("No project is selected");
    }
  });

  test("keeps the workspace path protection for read_file", async ({ request }) => {
    await selectE2eWorkspace(request);
    const response = await request.post("/api/tools/read_file", { data: { path: "/etc/hosts" } });
    expect(response.status()).toBe(400);
    const payload = (await response.json()) as ToolResult;
    expect(payload.ok).toBe(false);
    expect(payload.output).toContain("Path escapes WORKSPACE_ROOT.");
  });

  test("clamps traversal paths back inside the selected project", async ({ request }) => {
    await selectE2eWorkspace(request);
    const response = await request.post("/api/tools/read_file", {
      data: { path: "../../e2e/fixtures/tool-test-command.cjs" }
    });
    const payload = (await response.json()) as ToolResult;
    expect(payload.ok).toBe(false);
    // The leading ../ segments are stripped, so the lookup stays under the selected project.
    expect(payload.output).toContain(path.join(e2eWorkspace, "e2e/fixtures/tool-test-command.cjs"));
    expect(payload.output).not.toContain("E2E_TOOL_TEST_OK");
  });
});
