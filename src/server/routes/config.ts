import type { Express } from "express";
import type { AppConfig } from "../../shared/contracts";
import type { RouteDeps } from "./index";
import { env } from "../env";

export function mountConfigRoutes(
  app: Express,
  { projectStore, realtimeModel, voice, codingAgentName, codingModel }: RouteDeps
) {
  app.get("/api/config", (_req, res) => {
    const config: AppConfig = {
      meeting: {mode: env.mode, url: env.meetingUrl, name: env.meetingName, durationMinutes: env.meetingDurationMinutes},
      activeProject: projectStore.getActiveProject(),
      projects: projectStore.listProjects(),
      realtimeModel,
      voice,
      codingAgent: codingAgentName,
      codingModel: codingModel ?? null
    };
    res.json(config);
  });
}
