import { useCallback, useEffect, useState } from "react";
import { APPROVAL_POLL_INTERVAL_MS } from "../constants";
import { formatApprovalDecision } from "../lib/format";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../../shared/contracts";

type Logger = (message: string) => void;

type Options = {
  onSystemLog: Logger;
};

export function useCodexApprovals({ onSystemLog }: Options) {
  const [approvals, setApprovals] = useState<CodexApprovalRequest[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isResolvingId, setIsResolvingId] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      const response = await fetch("/api/coding-agent/approvals");
      const data = (await response.json()) as { approvals?: CodexApprovalRequest[] };
      if (response.ok) {
        setApprovals(data.approvals ?? []);
      }
    } catch {
      // Approval polling should not interrupt the main voice/text flow.
    }
  }, []);

  // Initial load + lightweight polling.
  // TODO: Replace with SSE if approval volume / latency starts to matter.
  useEffect(() => {
    void fetchApprovals();
    const interval = window.setInterval(() => {
      void fetchApprovals();
    }, APPROVAL_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [fetchApprovals]);

  // Keep the active index inside the new bounds when the queue shrinks.
  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(approvals.length - 1, 0)));
  }, [approvals.length]);

  const resolveApproval = useCallback(
    async (approval: CodexApprovalRequest, decision: CodexApprovalDecision) => {
      setIsResolvingId(approval.id);
      try {
        const response = await fetch(
          `/api/coding-agent/approvals/${encodeURIComponent(approval.id)}`,
          {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision })
          }
        );
        const data = (await response.json().catch(() => ({}))) as { error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? "Failed to resolve approval.");
        }

        setApprovals((current) => current.filter((candidate) => candidate.id !== approval.id));
        onSystemLog(`${approval.title} ${formatApprovalDecision(decision)}.`);
      } catch (error) {
        onSystemLog(error instanceof Error ? error.message : String(error));
      } finally {
        setIsResolvingId(null);
      }
    },
    [onSystemLog]
  );

  const clearApprovals = useCallback(() => setApprovals([]), []);

  return {
    approvals,
    activeIndex,
    setActiveIndex,
    isResolvingId,
    resolveApproval,
    clearApprovals
  };
}
