import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpConfigStore } from "../src/server/mcp/config";
import { McpManager } from "../src/server/mcp/manager";
import { McpOAuthProvider } from "../src/server/mcp/oauth";
import { createMcpFetch } from "../src/server/mcp/transportFetch";
import { e2eRoot } from "./support/paths";

test("clears persisted OAuth tokens without first connecting after restart", async () => {
  const store = new McpConfigStore(path.join(e2eRoot, "lifecycle", "mcp.json"));
  await store.save({ mcpServers: { remote: { type: "http", url: "http://127.0.0.1:1/mcp" } } });
  const redirect = "http://localhost:38787/api/mcp/oauth/callback";
  const provider = new McpOAuthProvider(path.join(e2eRoot, "lifecycle", "mcp-credentials"), "remote", store.get().mcpServers.remote, redirect);
  await provider.saveTokens({ access_token: "persisted-token", token_type: "Bearer" });
  const manager = new McpManager(store, redirect, () => null);
  await manager.load();
  await manager.logout("remote");
  expect(await readFile(provider.filePath, "utf8").catch(() => null)).toBeNull();
  await manager.dispose();
});

test("removing an unconnected server also removes its persisted OAuth credentials", async () => {
  const store = new McpConfigStore(path.join(e2eRoot, "removed", "mcp.json"));
  await store.save({ mcpServers: { remote: { type: "http", url: "http://127.0.0.1:1/mcp" } } });
  const redirect = "http://localhost:38787/api/mcp/oauth/callback";
  const provider = new McpOAuthProvider(path.join(e2eRoot, "removed", "mcp-credentials"), "remote", store.get().mcpServers.remote, redirect);
  await provider.saveTokens({ access_token: "persisted-token", token_type: "Bearer" });
  const manager = new McpManager(store, redirect, () => null);
  await manager.load();
  await manager.configure({ mcpServers: {} });
  expect(await readFile(provider.filePath, "utf8").catch(() => null)).toBeNull();
  await manager.dispose();
});

test("late OAuth token responses cannot recreate explicitly cleared credentials", async () => {
  const store = new McpConfigStore(path.join(e2eRoot, "revoked", "mcp.json"));
  await store.save({ mcpServers: { remote: { type: "http", url: "http://127.0.0.1:1/mcp" } } });
  const provider = new McpOAuthProvider(path.join(e2eRoot, "revoked", "mcp-credentials"), "remote", store.get().mcpServers.remote, "http://localhost:38787/api/mcp/oauth/callback");
  await provider.clear();
  await expect(provider.saveTokens({ access_token: "late-token", token_type: "Bearer" })).rejects.toThrow();
});

test("resource credentials stay off other origins and OAuth requests", async () => {
  const requests: { url: string; headers: Headers }[] = [];
  const fetcher = createMcpFetch(new URL("https://mcp.example/sse"), { "x-api-key": "resource-secret" }, new AbortController().signal, 1000,
    async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("{}");
    });
  await fetcher("https://mcp.example/sse");
  await fetcher("https://mcp.example/messages", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }) });
  await fetcher("https://identity.example/.well-known/oauth-authorization-server");
  await fetcher("https://mcp.example/token", { method: "POST", headers: { Authorization: "Basic oauth-client" }, body: "grant_type=authorization_code" });
  expect(requests.map((request) => request.headers.get("x-api-key"))).toEqual(["resource-secret", "resource-secret", null, null]);
  expect(requests[3].headers.get("authorization")).toBe("Basic oauth-client");
});
