import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  CompleteRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1.0.0" }, {
  capabilities: { tools: { listChanged: true }, resources: { subscribe: true }, prompts: {}, completions: {} }
});
let changedCatalog = false;
server.setRequestHandler(ListToolsRequestSchema, async (request) => ({ tools: request.params?.cursor ? [
  { name: "page_two", inputSchema: { type: "object" } }
] : [
  { name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "fail", description: "Return a tool error", inputSchema: { type: "object" } },
  { name: "elicit", description: "Ask for input", inputSchema: { type: "object" } },
  { name: "roots", description: "List client roots", inputSchema: { type: "object" } },
  { name: "slow", description: "Slow tool", inputSchema: { type: "object" } },
  { name: "change_catalog", description: "Update tools with progress", inputSchema: { type: "object" } },
  ...(changedCatalog ? [{ name: "new_tool", inputSchema: { type: "object" } }] : []),
  { name: "toString", description: "Prototype name test", inputSchema: { type: "object" } },
  { name: "read_resource", description: "Operation name collision test", inputSchema: { type: "object" } }
], ...(process.env.MCP_FIXTURE_PAGINATION && (!request.params?.cursor || process.env.MCP_FIXTURE_PAGINATION === "loop") ? { nextCursor: "second" } : {}) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "change_catalog") {
    changedCatalog = true;
    await server.sendToolListChanged();
    if (request.params._meta?.progressToken !== undefined) await server.notification({ method: "notifications/progress", params: { progressToken: request.params._meta.progressToken, progress: 1, total: 1 } });
  }
  if (request.params.name === "slow") await new Promise((resolve) => setTimeout(resolve, 5000));
  if (request.params.name === "elicit") {
    const response = await server.elicitInput({ mode: "form", message: "Confirm input", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } });
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  }
  if (request.params.name === "roots") return { content: [{ type: "text", text: JSON.stringify(await server.listRoots()) }] };
  return {
  content: [{ type: "text", text: request.params.name === "fail" ? "fixture failure" : String(request.params.arguments?.message) }],
  isError: request.params.name === "fail"
}; });
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  if (process.env.MCP_FIXTURE_BAD_RESOURCES) throw new Error("Resource listing unavailable");
  return { resources: [{ uri: "fixture://readme", name: "readme", mimeType: "text/plain" }] };
});
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({ contents: [{ uri: request.params.uri, text: "fixture resource", mimeType: "text/plain" }] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "greeting", arguments: [{ name: "person", required: true }] }] }));
server.setRequestHandler(GetPromptRequestSchema, async (request) => ({ messages: [{ role: "user", content: { type: "text", text: `Hello ${request.params.arguments?.person}` } }] }));
server.setRequestHandler(CompleteRequestSchema, async () => ({ completion: { values: ["Elva"], total: 1, hasMore: false } }));
server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
await server.connect(new StdioServerTransport());
