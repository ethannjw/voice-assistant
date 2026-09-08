import type { Express } from "express";
import type { CodexApprovalDecision } from "../../shared/contracts";
import type { RouteDeps } from "./index";

export function mountCodexRoutes(app: Express, { codingAgent, projectStore }: RouteDeps) {
  const mountMessageRoute = (route: string) => app.post(route, async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "Text is required." });
      return;
    }

    try {
      res.json(await codingAgent.runTextTurn(projectStore.getActiveProject()?.path ?? null, text));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const mountApprovalsRoute = (route: string) => app.get(route, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ approvals: codingAgent.listPendingApprovals() });
  });

  const mountApprovalDecisionRoute = (route: string) => app.post(route, (req, res) => {
    const body = req.body;
    const decision = body && typeof body === "object" && "decision" in body ? body.decision : undefined;
    const approvalId = req.params.id;
    if (!isApprovalDecision(decision)) {
      res.status(400).json({ error: "Unsupported approval decision." });
      return;
    }

    if (typeof approvalId !== "string" || !codingAgent.resolveApproval(approvalId, decision)) {
      res.status(404).json({ error: "Approval request not found." });
      return;
    }

    res.json({ ok: true });
  });

  mountMessageRoute("/api/coding-agent/message");
  mountMessageRoute("/api/codex/message");
  mountApprovalsRoute("/api/coding-agent/approvals");
  mountApprovalsRoute("/api/codex/approvals");
  mountApprovalDecisionRoute("/api/coding-agent/approvals/:id");
  mountApprovalDecisionRoute("/api/codex/approvals/:id");
}

function isApprovalDecision(value: unknown): value is CodexApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline";
}
