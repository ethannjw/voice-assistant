import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import type { AppConfig, ToolName } from "../shared/contracts";
import { ProjectStore } from "./projectStore";
import { buildSessionConfig } from "./realtime";
import { WorkspaceTools } from "./tools";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT ?? 8787);
const defaultWorkspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
const projectStorePath = path.resolve(
  process.env.PROJECTS_FILE ?? path.join(process.cwd(), ".voice-pair-programmer", "projects.json")
);
const realtimeModel = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2";
const voice = process.env.OPENAI_REALTIME_VOICE ?? "marin";
const projectStore = new ProjectStore(projectStorePath, defaultWorkspaceRoot);
await projectStore.load();
const tools = new WorkspaceTools(projectStore.getActiveProject().path);
const isProduction = process.env.NODE_ENV === "production";

app.use("/api/realtime/call", express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/config", (_req, res) => {
  const config: AppConfig = {
    activeProject: projectStore.getActiveProject(),
    projects: projectStore.listProjects(),
    realtimeModel,
    voice
  };
  res.json(config);
});

app.get("/api/projects", (_req, res) => {
  res.json({
    activeProject: projectStore.getActiveProject(),
    projects: projectStore.listProjects()
  });
});

app.post("/api/projects", async (req, res) => {
  try {
    const project = await projectStore.addProject(req.body ?? {});
    tools.setWorkspaceRoot(project.path);
    res.status(201).json({
      activeProject: project,
      projects: projectStore.listProjects()
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/projects/:id/select", async (req, res) => {
  try {
    const project = await projectStore.selectProject(req.params.id);
    tools.setWorkspaceRoot(project.path);
    res.json({
      activeProject: project,
      projects: projectStore.listProjects()
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/realtime/call", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    res.status(500).send("OPENAI_API_KEY is required.");
    return;
  }

  const fd = new FormData();
  fd.set("sdp", req.body);
  fd.set("session", JSON.stringify(buildSessionConfig(realtimeModel, voice)));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Safety-Identifier": "local-dev-user"
    },
    body: fd
  });

  const text = await response.text();
  if (!response.ok) {
    res
      .status(response.status)
      .type(response.headers.get("content-type") ?? "application/json")
      .send(text);
    return;
  }

  res.status(response.status).type("application/sdp").send(text);
});

app.post("/api/tools/:name", async (req, res) => {
  const result = await tools.call(req.params.name as ToolName, req.body ?? {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.get("/api/patch/pending", (_req, res) => {
  res.json({ patch: tools.getPendingPatch() });
});

app.post("/api/patch/:id/apply", async (req, res) => {
  const result = await tools.applyPatch(req.params.id);
  res.status(result.ok ? 200 : 400).json(result);
});

app.delete("/api/patch/:id", (req, res) => {
  tools.clearPendingPatch(req.params.id);
  res.status(204).end();
});

if (isProduction) {
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

app.listen(port, () => {
  console.log(`Voice Pair Programmer server listening on http://localhost:${port}`);
  console.log(`Workspace root: ${tools.getWorkspaceRoot()}`);
  console.log(`Realtime model: ${realtimeModel}`);
});
