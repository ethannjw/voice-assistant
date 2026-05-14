import type { Express } from "express";
import type { CodexApprovalDecision } from "../../shared/contracts";
import type { RouteDeps } from "./index";

export function mountCodexRoutes(app: Express, { codexAppServer, projectStore }: RouteDeps) {
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
    res.set("Cache-Control", "no-store");
    res.json({ approvals: codexAppServer.listPendingApprovals() });
  });

  app.post("/api/codex/approvals/:id", (req, res) => {
    const body = req.body;
    const decision = body && typeof body === "object" && "decision" in body ? body.decision : undefined;
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
}

function isApprovalDecision(value: unknown): value is CodexApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline";
}
