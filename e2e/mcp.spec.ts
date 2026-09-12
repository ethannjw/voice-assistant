import { expect, test } from "@playwright/test";
import path from "node:path";
import { e2eWorkspace, repositoryRoot } from "./support/paths";
import { emitInvitedRealtimeReply, installRealtimeBrowserFakes } from "./support/realtime-browser";
import { selectE2eWorkspace } from "./support/workspace";

const serverConfig = {
  type: "stdio",
  command: process.execPath,
  args: [path.join(repositoryRoot, "e2e/fixtures/mcp-server.mjs")],
  permission: "allow"
};

test.describe.serial("user-configurable MCP", () => {
  test.afterEach(async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: {} } });
  });

  test("imports standard server configuration and discovers tools, resources and prompts", async ({ request }) => {
    const saved = await request.put("/api/mcp/config", {
      data: { mcpServers: { fixture: serverConfig } }
    });
    expect(saved.status()).toBe(200);
    const connected = await request.post("/api/mcp/servers/fixture/connect");
    expect(connected.status(), await connected.text()).toBe(200);
    const listed = await request.post("/api/tools/mcp_list", { data: { server: "fixture" } });
    const catalog = await listed.json();
    expect(catalog.ok).toBe(true);
    expect(catalog.output).toContain("echo");
    expect(catalog.output).toContain("fixture://readme");
    expect(catalog.output).toContain("greeting");
    const result = await request.post("/api/tools/mcp_call", {
      data: { server: "fixture", operation: "tool", name: "echo", arguments: { message: "hello MCP" } }
    });
    expect(await result.json()).toMatchObject({ ok: true, output: expect.stringContaining("hello MCP") });
  });

  test("rejects invalid configuration without replacing saved servers", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: serverConfig } } });
    const invalid = await request.put("/api/mcp/config", {
      data: { mcpServers: { broken: { type: "http", url: "file:///etc/passwd" } } }
    });
    expect(invalid.status()).toBe(400);
    const saved = await request.get("/api/mcp/config");
    expect((await saved.json()).mcpServers.fixture.command).toBe(process.execPath);
  });

  test("enforces deny policy and prevents cross-origin configuration", async ({ request }) => {
    await request.put("/api/mcp/config", {
      data: { mcpServers: { fixture: { ...serverConfig, permission: "deny" } } }
    });
    const result = await request.post("/api/tools/mcp_call", {
      data: { server: "fixture", operation: "tool", name: "echo", arguments: { message: "denied" } }
    });
    expect(await result.json()).toMatchObject({ ok: false, output: expect.stringContaining("denied") });
    const crossOrigin = await request.put("/api/mcp/config", {
      headers: { Origin: "https://untrusted.example" }, data: { mcpServers: {} }
    });
    expect(crossOrigin.status()).toBe(403);
  });

  test("allows users to configure an MCP server in the browser", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Manage MCP servers" }).click();
    await page.getByLabel("MCP configuration JSON").fill(JSON.stringify({ mcpServers: { fixture: serverConfig } }));
    await page.getByRole("button", { name: "Save and trust configuration" }).click();
    await expect(page.getByRole("heading", { name: "fixture", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Connect fixture", exact: true }).click();
    await expect(page.getByText("connected", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mcp-panel.png"), fullPage: true });
  });

  test("reads resources, retrieves prompts, and preserves tool errors", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: serverConfig } } });
    for (const [operation, params, expected] of [
      ["read_resource", { uri: "fixture://readme" }, "fixture resource"],
      ["get_prompt", { name: "greeting", arguments: { person: "Elva" } }, "Hello Elva"]
    ] as const) {
      const response = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation, ...params } });
      expect(await response.json()).toMatchObject({ ok: true, output: expect.stringContaining(expected) });
    }
    const failure = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "fail" } });
    expect(await failure.json()).toMatchObject({ ok: false, metadata: { result: { isError: true } } });
    const invalid = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "echo", arguments: { message: 123 } } });
    expect(await invalid.json()).toMatchObject({ ok: false, output: expect.stringContaining("Invalid tool arguments") });
  });

  test("waits for explicit approval and cancels pending requests when disabled", async ({ request }) => {
    const config = { ...serverConfig, permission: "ask" };
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: config } } });
    const pending = request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "echo", arguments: { message: "approved" } } });
    await expect.poll(async () => (await (await request.get("/api/mcp/status")).json()).interactions.length).toBe(1);
    const status = await (await request.get("/api/mcp/status")).json();
    await request.post(`/api/mcp/interactions/${status.interactions[0].id}`, { data: { action: "accept" } });
    expect(await (await pending).json()).toMatchObject({ ok: true, output: expect.stringContaining("approved") });
    const cancelled = request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "echo", arguments: { message: "cancelled" } } });
    await expect.poll(async () => (await (await request.get("/api/mcp/status")).json()).interactions.length).toBe(1);
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: { ...config, enabled: false } } } });
    expect(await (await cancelled).json()).toMatchObject({ ok: false });
    expect((await (await request.get("/api/mcp/status")).json()).interactions).toEqual([]);
  });

  test("uses exact per-tool permissions, including prototype-like tool names", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: { ...serverConfig, permission: "deny", permissions: { echo: "allow" } } } } });
    const allowed = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "echo", arguments: { message: "override" } } });
    expect(await allowed.json()).toMatchObject({ ok: true });
    const denied = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "toString" } });
    expect(await denied.json()).toMatchObject({ ok: false, output: expect.stringContaining("denied") });
  });

  test("separates tool permissions from resource-operation permissions", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: { ...serverConfig, permission: "deny", operationPermissions: { read_resource: "allow" } } } } });
    const resource = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "read_resource", uri: "fixture://readme" } });
    expect(await resource.json()).toMatchObject({ ok: true });
    const tool = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "read_resource" } });
    expect(await tool.json()).toMatchObject({ ok: false, output: expect.stringContaining("denied") });
  });

  test("handles paginated discovery and repeated cursors safely", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: { ...serverConfig, env: { MCP_FIXTURE_PAGINATION: "yes" } } } } });
    const catalog = await request.post("/api/tools/mcp_list", { data: { server: "fixture" } });
    expect(await catalog.json()).toMatchObject({ ok: true, output: expect.stringContaining("page_two") });
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: { ...serverConfig, env: { MCP_FIXTURE_PAGINATION: "loop" } } } } });
    const loop = await request.post("/api/tools/mcp_list", { data: { server: "fixture" } });
    expect(await loop.json()).toMatchObject({ ok: false });
  });

  test("handles server-initiated form elicitation and reports selected roots", async ({ request }) => {
    await selectE2eWorkspace(request);
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: serverConfig } } });
    const pending = request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "elicit" } });
    await expect.poll(async () => (await (await request.get("/api/mcp/status")).json()).interactions.length).toBe(1);
    const status = await (await request.get("/api/mcp/status")).json();
    expect(status.interactions[0].kind).toBe("elicitation");
    const invalid = await request.post(`/api/mcp/interactions/${status.interactions[0].id}`, { data: { action: "accept", content: {} } });
    expect(invalid.status()).toBe(400);
    await request.post(`/api/mcp/interactions/${status.interactions[0].id}`, { data: { action: "accept", content: { answer: "confirmed" } } });
    expect(await (await pending).json()).toMatchObject({ ok: true, output: expect.stringContaining("confirmed") });
    const roots = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "roots" } });
    expect(await roots.json()).toMatchObject({ ok: true, output: expect.stringContaining(e2eWorkspace) });
  });

  test("supports completion, subscriptions, progress and changing catalogs", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: serverConfig } } });
    const completion = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "complete", reference: { type: "ref/prompt", name: "greeting" }, argument: { name: "person", value: "El" } } });
    expect(await completion.json()).toMatchObject({ ok: true, output: expect.stringContaining("Elva") });
    for (const operation of ["subscribe_resource", "unsubscribe_resource"]) {
      const result = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation, uri: "fixture://readme" } });
      expect(await result.json()).toMatchObject({ ok: true });
    }
    const changed = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "change_catalog" } });
    const changedResult = await changed.json();
    expect(changedResult.ok, JSON.stringify(changedResult)).toBe(true);
    const catalog = await request.post("/api/tools/mcp_list", { data: { server: "fixture" } });
    expect(await catalog.json()).toMatchObject({ ok: true, output: expect.stringContaining("new_tool") });
    const status = await (await request.get("/api/mcp/status")).json();
    expect(status.events.some((event: { message: string }) => event.message.startsWith("Progress:")), JSON.stringify(status.events)).toBe(true);
  });

  test("does not let unrelated resource discovery break tool execution", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: { ...serverConfig, env: { MCP_FIXTURE_BAD_RESOURCES: "yes" } } } } });
    const result = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "echo", arguments: { message: "independent" } } });
    expect(await result.json()).toMatchObject({ ok: true, output: expect.stringContaining("independent") });
  });

  test("times out slow tools without automatically retrying writes", async ({ request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: { ...serverConfig, timeoutMs: 1000 } } } });
    const result = await request.post("/api/tools/mcp_call", { data: { server: "fixture", operation: "tool", name: "slow" } });
    expect(await result.json()).toMatchObject({ ok: false, output: expect.stringContaining("verify before retrying") });
  });

  test("Elva executes configured MCP tools in a connected Realtime session", async ({ page, request }) => {
    await request.put("/api/mcp/config", { data: { mcpServers: { fixture: serverConfig } } });
    await installRealtimeBrowserFakes(page);
    await page.route("**/api/realtime/call", (route) => route.fulfill({ status: 200, contentType: "application/sdp", body: "e2e-answer" }));
    await page.goto("/");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.locator(".status-pill")).toHaveText("Connected");
    await emitInvitedRealtimeReply(page, "Elva, echo through my MCP server", [{
      type: "function_call", id: "mcp-echo-item", name: "mcp_call", call_id: "mcp-echo-call",
      arguments: JSON.stringify({ server: "fixture", operation: "tool", name: "echo", arguments: { message: "Realtime MCP result" } })
    }]);
    await expect.poll(async () => page.evaluate(() => {
      const events = (window as unknown as { __e2eRealtimeEvents: { item?: { type?: string; call_id?: string; output?: string } }[] }).__e2eRealtimeEvents;
      return events.find((event) => event.item?.type === "function_call_output" && event.item.call_id === "mcp-echo-call")?.item?.output;
    })).toContain("Realtime MCP result");
  });
});
