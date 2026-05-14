import type { Express } from "express";
import type { CodexAppServer } from "../codex";
import type { ProjectStore } from "../projectStore";
import type { WorkspaceTools } from "../tools";
import { mountConfigRoutes } from "./config";
import { mountProjectRoutes } from "./projects";
import { mountRealtimeRoutes } from "./realtime";
import { mountCodexRoutes } from "./codex";
import { mountToolRoutes } from "./tools";
import { mountPatchRoutes } from "./patch";

export type RouteDeps = {
  projectStore: ProjectStore;
  tools: WorkspaceTools;
  codexAppServer: CodexAppServer;
  realtimeModel: string;
  voice: string;
};

export function mountRoutes(app: Express, deps: RouteDeps) {
  mountConfigRoutes(app, deps);
  mountProjectRoutes(app, deps);
  mountRealtimeRoutes(app, deps);
  mountCodexRoutes(app, deps);
  mountToolRoutes(app, deps);
  mountPatchRoutes(app, deps);
}
