import type { Express } from "express";
import type { ProjectConfig, ToolName } from "../../shared/contracts";
import { createRequestAbortController } from "../lib/abortController";
import { runWebSearch, type WebSearchResult } from "../webSearch";
import type { RouteDeps } from "./index";

export function mountToolRoutes(
  app: Express,
  { tools, codingAgent, projectStore, firecrawlBaseUrl }: RouteDeps
) {
  app.post("/api/tools/:name", async (req, res) => {
    if (req.params.name === "coding_task" || req.params.name === "codex_task") {
      const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
      if (!task) {
        res.status(400).json({ ok: false, output: `${req.params.name} requires a task string.` });
        return;
      }

      const activeProject = projectStore.getActiveProject();
      const abortController = createRequestAbortController(req, res);
      try {
        const result = await codingAgent.runTextTurn(
          activeProject?.path ?? null,
          task,
          abortController.signal
        );
        res.json({
          ok: true,
          output: formatCodingTaskOutput(activeProject, result.text, codingAgent.name),
          metadata: {
            provider: codingAgent.name,
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

    if (req.params.name === "web_search") {
      const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
      if (!query) {
        res.status(400).json({ ok: false, output: "web_search requires a query string." });
        return;
      }

      const abortController = createRequestAbortController(req, res);
      try {
        const result = await runWebSearch(query, firecrawlBaseUrl, abortController.signal);
        res.json({
          ok: true,
          output: formatWebSearchOutput(result),
          metadata: { provider: "firecrawl", sources: result.sources }
        });
      } catch (error) {
        if (abortController.signal.aborted || res.writableEnded) return;
        res.status(500).json({
          ok: false,
          output: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    const result = await tools.call(req.params.name as ToolName, req.body ?? {});
    res.status(result.ok ? 200 : 400).json(result);
  });
}

function formatCodingTaskOutput(
  project: ProjectConfig | null,
  text: string,
  provider: "cursor" | "codex"
) {
  const projectLine = project
    ? `Selected project: ${project.name} (${project.path})`
    : "Selected project: none";
  const displayName = provider === "cursor" ? "Cursor" : "Codex";
  const body = text.trim() || `${displayName} completed without a text summary.`;
  return `${projectLine}\n\n${body}`;
}

function formatWebSearchOutput(result: WebSearchResult) {
  if (result.sources.length === 0) return result.text;
  const sources = result.sources.map((source) => `- ${source.title}: ${source.url}`).join("\n");
  return `${result.text}\n\nSources:\n${sources}`;
}
