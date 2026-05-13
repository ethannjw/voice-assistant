import "dotenv/config";
import express from "express";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import type { AppConfig, CodexApprovalDecision, ToolName } from "../shared/contracts";
import { CodexAppServer } from "./codexAppServer";
import { ProjectStore } from "./projectStore";
import { WorkspaceTools } from "./tools";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT ?? 8787);
const defaultWorkspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
const projectStorePath = path.resolve(
  process.env.PROJECTS_FILE ?? path.join(process.cwd(), ".voice-pair-programmer", "projects.json")
);
const voice = process.env.OPENAI_REALTIME_VOICE ?? "marin";
const projectStore = new ProjectStore(projectStorePath, defaultWorkspaceRoot);
await projectStore.load();
const tools = new WorkspaceTools(projectStore.getActiveProject()?.path ?? null);
const codexAppServer = new CodexAppServer({
  noProjectWorkspace: process.env.NO_PROJECT_WORKSPACE,
  voice
});
const isProduction = process.env.NODE_ENV === "production";

app.use("/api/codex/realtime/call", express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/config", (_req, res) => {
  const config: AppConfig = {
    activeProject: projectStore.getActiveProject(),
    projects: projectStore.listProjects(),
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

app.post("/api/projects/discover", async (_req, res) => {
  try {
    res.json({ projects: await discoverRepositories() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/projects/deselect", async (_req, res) => {
  await projectStore.clearActiveProject();
  tools.setWorkspaceRoot(null);
  res.json({
    activeProject: null,
    projects: projectStore.listProjects()
  });
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

app.post("/api/codex/realtime/call", async (req, res) => {
  try {
    const sdp = await codexAppServer.startRealtimeSession(projectStore.getActiveProject()?.path ?? null, req.body);
    res.status(200).type("application/sdp").send(sdp);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : String(error));
  }
});

app.post("/api/codex/realtime/stop", async (_req, res) => {
  await codexAppServer.stopRealtimeSession();
  res.status(204).end();
});

app.post("/api/codex/message", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Text is required." });
    return;
  }

  try {
    res.json(await codexAppServer.runTextTurn(projectStore.getActiveProject()?.path ?? null, text));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/codex/approvals", (_req, res) => {
  res.json({ approvals: codexAppServer.listPendingApprovals() });
});

app.post("/api/codex/approvals/:id", (req, res) => {
  const decision = req.body?.decision;
  if (!isApprovalDecision(decision)) {
    res.status(400).json({ error: "Unsupported approval decision." });
    return;
  }

  if (!codexAppServer.resolveApproval(req.params.id, decision)) {
    res.status(404).json({ error: "Approval request not found." });
    return;
  }

  res.json({ ok: true });
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
  console.log(`Workspace root: ${tools.getWorkspaceRoot() ?? "(none selected)"}`);
  console.log(`Realtime voice: ${voice}`);
  console.log("Codex App Server: enabled");
});

async function discoverRepositories() {
  const configuredRoots = String(process.env.PROJECT_SEARCH_ROOTS ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const roots = uniquePaths(configuredRoots.length ? configuredRoots : [path.dirname(process.cwd())]);
  const found = new Map<string, { name: string; path: string }>();

  for (const root of roots) {
    await collectGitRepositories(root, 4, found);
    if (found.size >= 100) {
      break;
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function collectGitRepositories(
  directory: string,
  depth: number,
  found: Map<string, { name: string; path: string }>
) {
  if (depth < 0 || found.size >= 100) {
    return;
  }

  let info;
  try {
    info = await stat(directory);
  } catch {
    return;
  }

  if (!info.isDirectory()) {
    return;
  }

  const resolved = path.resolve(directory);
  try {
    if ((await stat(path.join(resolved, ".git"))).isDirectory()) {
      found.set(resolved, { name: path.basename(resolved), path: resolved });
      return;
    }
  } catch {
    // Continue scanning descendants.
  }

  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !shouldSkipDirectory(entry.name))
      .slice(0, 80)
      .map((entry) => collectGitRepositories(path.join(resolved, entry.name), depth - 1, found))
  );
}

function shouldSkipDirectory(name: string) {
  return [".git", "node_modules", "dist", "build", "Library"].includes(name);
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}

function isApprovalDecision(value: unknown): value is CodexApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline";
}
