import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { CodexAppServer } from "./codex";
import { env } from "./env";
import { ProjectStore } from "./projectStore";
import { mountRoutes } from "./routes";
import { WorkspaceTools } from "./tools";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------- Bootstrap dependencies ----------

const projectStore = new ProjectStore(env.projectStorePath, env.defaultWorkspaceRoot);
await projectStore.load();
const tools = new WorkspaceTools(projectStore.getActiveProject()?.path ?? null);
const codexAppServer = new CodexAppServer({
  model: env.codexModel,
  noProjectWorkspace: env.noProjectWorkspace
});

// ---------- Middleware ----------

// SDP offers come in as raw text; everything else is JSON.
app.use("/api/realtime/call", express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json({ limit: "1mb" }));

// ---------- API routes ----------

mountRoutes(app, {
  projectStore,
  tools,
  codexAppServer,
  realtimeModel: env.realtimeModel,
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

app.listen(env.port, () => {
  console.log(`Voice Pair Programmer server listening on http://localhost:${env.port}`);
  console.log(`Workspace root: ${tools.getWorkspaceRoot() ?? "(none selected)"}`);
  console.log(`Realtime model: ${env.realtimeModel}`);
  console.log(`Realtime voice: ${env.voice}`);
  console.log(`Codex model: ${env.codexModel}`);
  console.log("Codex App Server: enabled");
});
