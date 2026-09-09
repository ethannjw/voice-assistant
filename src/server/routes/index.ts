import type { Express } from "express";
import type { CodingAgent } from "../codingAgent";
import type { CodingAgentName } from "../../shared/contracts";
import type { ProjectStore } from "../projectStore";
import type { WorkspaceTools } from "../tools";
import { mountConfigRoutes } from "./config";
import { mountProjectRoutes } from "./projects";
import { mountRealtimeRoutes } from "./realtime";
import { mountCodexRoutes } from "./codex";
import { mountToolRoutes } from "./tools";
import { mountPatchRoutes } from "./patch";
import { mountMcpRoutes } from "./mcp";
import type { McpManager } from "../mcp/manager";

export type RouteDeps = {
  mcp: McpManager;
  projectStore: ProjectStore;
  tools: WorkspaceTools;
  codingAgent: CodingAgent;
  codingAgentName: CodingAgentName;
  codingModel?: string;
  realtimeModel: string;
  firecrawlBaseUrl: string;
  voice: string;
};

export function mountRoutes(app: Express, deps: RouteDeps) {
  mountMcpRoutes(app, deps.mcp);
  mountConfigRoutes(app, deps);
  mountProjectRoutes(app, deps);
  mountRealtimeRoutes(app, deps);
  mountCodexRoutes(app, deps);
  mountToolRoutes(app, deps);
  mountPatchRoutes(app, deps);
}
