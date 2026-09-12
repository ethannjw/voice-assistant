import express from "express";
import { randomUUID, createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const sessions = new Map();
const codes = new Map();
let origin;
let redirectUri;
let tokenExchanges = 0;
let leakedOAuthHeader = false;
let terminatedSessions = 0;
app.use((req, _res, next) => {
  if ((req.path.startsWith("/.well-known/") || ["/token", "/register"].includes(req.path)) && req.get("x-fixture-private")) leakedOAuthHeader = true;
  next();
});

function fixture() {
  const server = new Server({ name: "remote-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: `remote:${request.params.arguments.message}` }] }));
  return server;
}

app.get("/.well-known/oauth-protected-resource/protected/mcp", (_req, res) => res.json({ resource: `${origin}/protected/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:tools"] }));
app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({
  issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
  response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["mcp:tools"]
}));
app.post("/register", (req, res) => { redirectUri = req.body.redirect_uris[0]; res.status(201).json({ ...req.body, client_id: "fixture-client" }); });
app.get("/authorize", (req, res) => {
  if (req.query.redirect_uri !== redirectUri || req.query.code_challenge_method !== "S256") return res.status(400).json({ error: "invalid_request" });
  const code = randomUUID();
  codes.set(code, req.query.code_challenge);
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", req.query.state);
  res.json({ callback: callback.href });
});
app.post("/token", (req, res) => {
  if (req.body.grant_type === "authorization_code") {
    const challenge = createHash("sha256").update(req.body.code_verifier ?? "").digest("base64url");
    if (!codes.has(req.body.code) || codes.get(req.body.code) !== challenge || req.body.redirect_uri !== redirectUri) return res.status(400).json({ error: "invalid_grant" });
    codes.delete(req.body.code);
  } else if (req.body.refresh_token !== "fixture-refresh") return res.status(400).json({ error: "invalid_grant" });
  tokenExchanges++;
  res.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" });
});
app.get("/stats", (_req, res) => res.json({ tokenExchanges, leakedOAuthHeader, terminatedSessions }));
app.get("/stalled-sse", (_req, res) => { res.set("Content-Type", "text/event-stream"); res.flushHeaders(); });

app.all(["/mcp", "/protected/mcp", "/header/mcp"], async (req, res) => {
  if (req.path === "/header/mcp" && req.get("x-fixture-key") !== "fixture-secret") return res.status(403).end();
  if (req.path === "/protected/mcp" && req.get("authorization") !== "Bearer fixture-access") {
    return res.status(401).set("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/protected/mcp", scope="mcp:tools"`).json({ error: "unauthorized" });
  }
  const session = req.get("mcp-session-id");
  let transport = sessions.get(session);
  if (!transport && req.method === "POST" && req.body.method === "initialize") {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => sessions.set(id, transport), onsessionclosed: (id) => { sessions.delete(id); terminatedSessions++; } });
    await fixture().connect(transport);
  }
  if (!transport) return res.status(400).end();
  await transport.handleRequest(req, res, req.body);
});

app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);
  res.on("close", () => sessions.delete(transport.sessionId));
  await fixture().connect(transport);
});
app.post("/messages", async (req, res) => {
  const transport = sessions.get(req.query.sessionId);
  if (!transport) return res.status(404).end();
  await transport.handlePostMessage(req, res, req.body);
});

const listener = app.listen(0, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${listener.address().port}`;
  console.log(origin);
});
process.on("SIGTERM", () => { listener.close(); listener.closeAllConnections(); process.exit(0); });
