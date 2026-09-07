import { expect, test, type APIRequestContext } from "@playwright/test";
import { REALTIME_TOOLS } from "../src/server/realtime";
import { WORKSPACE_TOOL_NAMES, type ToolName, type ToolResult } from "../src/shared/contracts";
import { e2eWorkspace } from "./support/paths";
import { selectE2eWorkspace } from "./support/workspace";

const COVERED_TOOL_NAMES = [
  "workspace_status",
  "search_workspace",
  "read_file",
  "git_diff",
  "run_tests",
  "propose_patch",
  "codex_task",
  "web_search"
] as const;

async function callTool(
  request: APIRequestContext,
  name: ToolName | "codex_task" | "web_search",
  data: Record<string, unknown> = {}
) {
  const response = await request.post(`/api/tools/${name}`, { data });
  const payload = (await response.json()) as ToolResult;
  expect(response.status(), JSON.stringify(payload)).toBe(200);
  return payload;
}

test.describe.serial("registered tools", () => {
  test.beforeEach(async ({ request }) => {
    await selectE2eWorkspace(request);
  });

  test("has explicit E2E coverage for every registered tool", () => {
    const registeredToolNames = [
      ...WORKSPACE_TOOL_NAMES,
      ...REALTIME_TOOLS.map((tool) => tool.name)
    ].sort();
    expect([...COVERED_TOOL_NAMES].sort()).toEqual(registeredToolNames);
  });

  test("workspace_status reports the selected disposable repository", async ({ request }) => {
    const result = await callTool(request, "workspace_status");
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`Workspace: ${e2eWorkspace}`);
    expect(result.output).toContain("tool-target.txt");
  });

  test("search_workspace finds fixture content", async ({ request }) => {
    const result = await callTool(request, "search_workspace", { query: "E2E_SEARCH_NEEDLE" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("README.md");
    expect(result.output).toContain("E2E_SEARCH_NEEDLE");
  });

  test("read_file returns fixture content", async ({ request }) => {
    const result = await callTool(request, "read_file", { path: "README.md" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# E2E Workspace");
  });

  test("git_diff returns the fixture working-tree change", async ({ request }) => {
    const result = await callTool(request, "git_diff");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("working tree change");
  });

  test("run_tests executes the isolated configured command", async ({ request }) => {
    const result = await callTool(request, "run_tests");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("E2E_TOOL_TEST_OK");
  });

  test("propose_patch creates a pending patch without applying it", async ({ request }) => {
    const diff = [
      "diff --git a/proposed.txt b/proposed.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/proposed.txt",
      "@@ -0,0 +1 @@",
      "+proposed by e2e",
      ""
    ].join("\n");
    const result = await callTool(request, "propose_patch", { diff });
    expect(result.ok).toBe(true);
    expect(result.metadata?.pendingPatch).toMatchObject({ diff });

    const patch = result.metadata?.pendingPatch as { id: string };
    const discardResponse = await request.delete(`/api/patch/${patch.id}`);
    expect(discardResponse.status()).toBe(204);
  });

  test("codex_task completes through the fake app-server process", async ({ request }) => {
    const result = await callTool(request, "codex_task", { task: "inspect the E2E workspace" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Fake Codex completed: inspect the E2E workspace");
    expect(result.metadata).toMatchObject({
      threadId: "e2e-thread",
      turnId: "e2e-turn",
      status: "completed"
    });
  });

  test("web_search completes through the Firecrawl stub", async ({ request }) => {
    const result = await callTool(request, "web_search", { query: "playwright tool query" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Stub result for playwright tool query");
    expect(result.metadata).toMatchObject({ provider: "firecrawl" });
  });
});
