import type { Express } from "express";
import { discoverRepositories } from "../lib/discoverRepositories";
import type { RouteDeps } from "./index";

export function mountProjectRoutes(app: Express, { projectStore, tools, mcp }: RouteDeps) {
  app.use("/api/projects", (req, res, next) => {
    if (req.method !== "GET") res.once("finish", () => { if (res.statusCode < 400) void mcp.rootsChanged(); });
    next();
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

  app.delete("/api/projects/:id", async (req, res) => {
    try {
      await projectStore.removeProject(req.params.id);
      if (!projectStore.getActiveProject()) {
        tools.setWorkspaceRoot(null);
      }
      res.json({
        activeProject: projectStore.getActiveProject(),
        projects: projectStore.listProjects()
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
