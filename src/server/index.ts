import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createCodingAgent } from "./codingAgent";
import { env } from "./env";
import { ProjectStore } from "./projectStore";
import { mountRoutes } from "./routes";
import { WorkspaceTools } from "./tools";
import { McpManager } from "./mcp/manager";
import { McpConfigStore } from "./mcp/config";
import { MeetingManager } from "./meeting/manager";
import { buildSessionConfig } from "./realtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// ---------- Bootstrap dependencies ----------

const projectStore = new ProjectStore(env.projectStorePath, env.defaultWorkspaceRoot);
await projectStore.load();
if (env.initialWorkspace) await projectStore.addProject({path: env.initialWorkspace});
const mcp = new McpManager(new McpConfigStore(env.mcpConfigPath), `http://localhost:${env.port}/api/mcp/oauth/callback`, () => projectStore.getActiveProject());
await mcp.load();
const tools = new WorkspaceTools(projectStore.getActiveProject()?.path ?? null);
const codingAgent = createCodingAgent({
  provider: env.codingAgent,
  cursorCommand: env.cursorAgentCommand,
  cursorModel: env.cursorModel,
  cursorRequestTimeoutMs: env.cursorRequestTimeoutMs,
  cursorTurnTimeoutMs: env.cursorTurnTimeoutMs,
  codexModel: env.codexModel,
  codexModelProvider: env.codexModelProvider,
  noProjectWorkspace: env.noProjectWorkspace
});

// ---------- Middleware ----------

// SDP offers come in as raw text; everything else is JSON.
app.use("/api/realtime/call", express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json({ limit: "1mb" }));
const meeting = new MeetingManager({
  session: () => buildSessionConfig(env.realtimeModel, env.voice, projectStore.getActiveProject(), env.codingAgent),
  providerUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
  apiKey: process.env.OPENAI_API_KEY,
  name: env.meetingName,
  durationMinutes: env.meetingDurationMinutes
});
meeting.mount(app, server);

// ---------- API routes ----------

mountRoutes(app, {
  mcp,
  projectStore,
  tools,
  codingAgent,
  codingAgentName: env.codingAgent,
  codingModel: env.codingAgent === "cursor" ? env.cursorModel : env.codexModel,
  realtimeModel: env.realtimeModel,
  firecrawlBaseUrl: env.firecrawlBaseUrl,
  voice: env.voice
});

// ---------- Static / dev server ----------

if (env.isProduction) {
  const clientDir = path.resolve(__dirname, "../../dist/client");
  app.use(express.static(clientDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

// ---------- Start ----------

server.listen(env.port, "127.0.0.1", () => {
  console.log(`Voice Pair Programmer server listening on http://localhost:${env.port}`);
  console.log(`Workspace root: ${tools.getWorkspaceRoot() ?? "(none selected)"}`);
  console.log(`Realtime model: ${env.realtimeModel}`);
  console.log(`Realtime voice: ${env.voice}`);
  console.log(`Session mode: ${env.mode}${env.mode === "teams" ? " — open the UI and choose Join meeting" : ""}`);
  console.log(`Firecrawl URL: ${env.firecrawlBaseUrl}`);
  console.log(`Coding agent: ${env.codingAgent}`);
  console.log(
    `Coding model: ${env.codingAgent === "cursor" ? env.cursorModel ?? "(Cursor default)" : env.codexModel ?? "(Codex default)"}`
  );
  if (env.codingAgent === "cursor") {
    console.log(`Cursor Agent command: ${env.cursorAgentCommand} acp`);
  } else {
    console.log(`Codex model provider: ${env.codexModelProvider ?? "(default from config.toml)"}`);
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await Promise.allSettled([meeting.stop(), mcp.dispose(), codingAgent.dispose()]);
  process.exit(0);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
