import { useCallback, useRef } from "react";
import { CODEX_TASK_HEARTBEAT_MS } from "../constants";
import { formatCodexHeader } from "../lib/format";
import type { CodexHeaderState, LogRole } from "../types";
import type { PendingPatch, ToolResult } from "../../shared/contracts";

type RefCell<T> = {
  current: T;
};

type Options = {
  addLog: (role: LogRole, text: string) => string;
  updateLog: (id: string, text: string) => void;
  onPendingPatch: (patch: PendingPatch) => void;
  dataChannelRef: RefCell<RTCDataChannel | null>;
  conversationRevisionRef: RefCell<number>;
};

function parseToolArguments(rawArgs: string): Record<string, unknown> {
  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function useCodexToolExecution({
  addLog,
  updateLog,
  onPendingPatch,
  dataChannelRef,
  conversationRevisionRef
}: Options) {
  const toolAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const toolAbortReasonsRef = useRef<Map<AbortController, string>>(new Map());

  const abortCodexTasks = useCallback(
    (reason: string) => {
      conversationRevisionRef.current += 1;
      const hadActiveTasks = toolAbortControllersRef.current.size > 0;
      for (const controller of toolAbortControllersRef.current) {
        toolAbortReasonsRef.current.set(controller, reason);
        controller.abort();
      }
      return hadActiveTasks;
    },
    [conversationRevisionRef]
  );

  const clearAbortControllers = useCallback(() => {
    toolAbortControllersRef.current.clear();
  }, []);

  const executeToolCall = useCallback(
    async (name: string, callId: string | null, rawArgs: string) => {
      const args = parseToolArguments(rawArgs);
      const isCodexTask = name === "codex_task";
      const taskSummary = isCodexTask && typeof args.task === "string" ? args.task.trim() : "";
      const startedAt = Date.now();

      const headerLogId = isCodexTask
        ? addLog("tool", formatCodexHeader(taskSummary, 0, "running"))
        : addLog("tool", `${name}(${rawArgs})`);

      let heartbeat: number | null = null;
      if (isCodexTask) {
        heartbeat = window.setInterval(() => {
          updateLog(headerLogId, formatCodexHeader(taskSummary, Date.now() - startedAt, "running"));
        }, CODEX_TASK_HEARTBEAT_MS);
      }

      const revisionAtStart = conversationRevisionRef.current;
      const originChannel = dataChannelRef.current;
      const abortController = callId ? new AbortController() : null;
      if (abortController) {
        toolAbortControllersRef.current.add(abortController);
      }

      let result: ToolResult;
      try {
        const response = await fetch(`/api/tools/${name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
          signal: abortController?.signal
        });
        result = (await response.json()) as ToolResult;
      } catch (error) {
        if (abortController?.signal.aborted) {
          result = {
            ok: false,
            output:
              toolAbortReasonsRef.current.get(abortController) ?? "Codex App Server task was interrupted."
          };
        } else {
          result = { ok: false, output: error instanceof Error ? error.message : String(error) };
        }
      } finally {
        if (abortController) {
          toolAbortControllersRef.current.delete(abortController);
          toolAbortReasonsRef.current.delete(abortController);
        }
        if (heartbeat !== null) {
          window.clearInterval(heartbeat);
        }
      }

      const interrupted =
        abortController?.signal.aborted || conversationRevisionRef.current !== revisionAtStart;

      if (isCodexTask) {
        const finalState: CodexHeaderState = interrupted
          ? "interrupted"
          : result.ok
            ? "done"
            : "error";
        updateLog(headerLogId, formatCodexHeader(taskSummary, Date.now() - startedAt, finalState));
      }

      if (!interrupted && result.metadata?.pendingPatch) {
        onPendingPatch(result.metadata.pendingPatch as PendingPatch);
      }

      addLog("tool", result.output || "(no output)");

      if (
        callId &&
        originChannel &&
        dataChannelRef.current === originChannel &&
        originChannel.readyState === "open"
      ) {
        try {
          originChannel.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify(result)
              }
            })
          );
          if (!interrupted && originChannel.readyState === "open") {
            originChannel.send(JSON.stringify({ type: "response.create" }));
          }
        } catch (error) {
          addLog(
            "system",
            `Could not return tool output to the realtime session: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    },
    [addLog, conversationRevisionRef, dataChannelRef, onPendingPatch, updateLog]
  );

  return {
    abortCodexTasks,
    clearAbortControllers,
    executeToolCall
  };
}
