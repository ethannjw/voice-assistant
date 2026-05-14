import type { Express } from "express";
import type { RouteDeps } from "./index";

export function mountPatchRoutes(app: Express, { tools }: RouteDeps) {
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
}
