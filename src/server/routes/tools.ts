import type { Express } from "express";
import type { ProjectConfig, ToolName } from "../../shared/contracts";
import { createRequestAbortController } from "../lib/abortController";
import type { RouteDeps } from "./index";

export function mountToolRoutes(app: Express, { tools, codexAppServer, projectStore }: RouteDeps) {
  app.post("/api/tools/:name", async (req, res) => {
    if (req.params.name === "codex_task") {
      const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
      if (!task) {
        res.status(400).json({ ok: false, output: "codex_task requires a task string." });
        return;
      }

      const activeProject = projectStore.getActiveProject();
      const abortController = createRequestAbortController(req, res);
      try {
        const result = await codexAppServer.runTextTurn(
          activeProject?.path ?? null,
          task,
          abortController.signal
        );
        res.json({
          ok: true,
          output: formatCodexTaskOutput(activeProject, result.text),
          metadata: {
            project: activeProject
              ? { id: activeProject.id, name: activeProject.name, path: activeProject.path }
              : null,
            threadId: result.threadId,
            turnId: result.turnId,
            status: result.status
          }
        });
      } catch (error) {
        if (abortController.signal.aborted || res.writableEnded) return;
        res.status(500).json({ ok: false, output: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const result = await tools.call(req.params.name as ToolName, req.body ?? {});
    res.status(result.ok ? 200 : 400).json(result);
  });
}

function formatCodexTaskOutput(project: ProjectConfig | null, text: string) {
  const projectLine = project
    ? `Selected project: ${project.name} (${project.path})`
    : "Selected project: none";
  const body = text.trim() || "Codex completed without a text summary.";
  return `${projectLine}\n\n${body}`;
}
