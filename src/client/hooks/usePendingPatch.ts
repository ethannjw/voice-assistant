import { useCallback, useEffect, useState } from "react";
import type { PendingPatch, ToolResult } from "../../shared/contracts";

type Logger = (message: string) => void;

export function usePendingPatch(onSystemLog: Logger) {
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const fetchPendingPatch = useCallback(async () => {
    const response = await fetch("/api/patch/pending");
    const data = (await response.json()) as { patch: PendingPatch | null };
    setPendingPatch(data.patch);
  }, []);

  useEffect(() => {
    void fetchPendingPatch();
  }, [fetchPendingPatch]);

  const applyPendingPatch = useCallback(async () => {
    if (!pendingPatch) return;
    setIsApplying(true);
    try {
      const response = await fetch(`/api/patch/${pendingPatch.id}/apply`, { method: "POST" });
      const result = (await response.json()) as ToolResult;
      onSystemLog(result.output || (result.ok ? "Patch applied." : "Patch failed."));
      if (result.ok) {
        setPendingPatch(null);
      }
    } finally {
      setIsApplying(false);
    }
  }, [onSystemLog, pendingPatch]);

  const discardPendingPatch = useCallback(async () => {
    if (!pendingPatch) return;
    await fetch(`/api/patch/${pendingPatch.id}`, { method: "DELETE" });
    setPendingPatch(null);
  }, [pendingPatch]);

  return {
    pendingPatch,
    setPendingPatch,
    isApplying,
    applyPendingPatch,
    discardPendingPatch
  };
}
