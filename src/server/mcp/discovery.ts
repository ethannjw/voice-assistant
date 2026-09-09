import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export async function collectPages<Entry>(page: (cursor?: string) => Promise<{ entries: Entry[]; nextCursor?: string }>) {
  const entries: Entry[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    entries.push(...result.entries);
    cursor = result.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("MCP server returned a repeated pagination cursor.");
    if (cursor) cursors.add(cursor);
    if (cursors.size > 1000 || entries.length > 20_000) throw new Error("MCP catalog exceeds the discovery safety limit.");
  } while (cursor);
  return entries;
}

export function discoverTools(client: Client, options: RequestOptions) {
  if (!client.getServerCapabilities()?.tools) return Promise.resolve([]);
  return collectPages(async (cursor) => {
    const page = await client.listTools({ cursor }, options);
    return { entries: page.tools, nextCursor: page.nextCursor };
  });
}

export async function discoverCatalog(client: Client, options: RequestOptions) {
  const capabilities = client.getServerCapabilities();
  const tools = await discoverTools(client, options);
  const resources = capabilities?.resources ? await collectPages(async (cursor) => {
    const page = await client.listResources({ cursor }, options); return { entries: page.resources, nextCursor: page.nextCursor };
  }) : [];
  const resourceTemplates = capabilities?.resources ? await collectPages(async (cursor) => {
    try {
      const page = await client.listResourceTemplates({ cursor }, options); return { entries: page.resourceTemplates, nextCursor: page.nextCursor };
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return { entries: [] };
      throw error;
    }
  }) : [];
  const prompts = capabilities?.prompts ? await collectPages(async (cursor) => {
    const page = await client.listPrompts({ cursor }, options); return { entries: page.prompts, nextCursor: page.nextCursor };
  }) : [];
  return { tools, resources, resourceTemplates, prompts };
}
