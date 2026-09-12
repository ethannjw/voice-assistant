import { useCallback, useRef } from "react";
import { CODING_TASK_HEARTBEAT_MS } from "../constants";
import { formatCodingTaskHeader } from "../lib/format";
import type { CodingTaskHeaderState, LogRole } from "../types";
import type { CodingAgentName, PendingPatch, ToolResult } from "../../shared/contracts";
import type { RealtimeChannel } from "../lib/realtimeChannel";

type RefCell<T> = {
  current: T;
};

type Options = {
  addLog: (role: LogRole, text: string) => string;
  updateLog: (id: string, text: string) => void;
  onPendingPatch: (patch: PendingPatch) => void;
  codingAgentRef: RefCell<CodingAgentName | null>;
  dataChannelRef: RefCell<RealtimeChannel | null>;
  conversationRevisionRef: RefCell<number>;
  onRealtimeResult: (channel: RealtimeChannel, callId: string, result: ToolResult, interrupted: boolean) => void;
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
  codingAgentRef,
  dataChannelRef,
  conversationRevisionRef,
  onRealtimeResult
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
      const isCodingTask = name === "coding_task" || name === "codex_task";
      const taskSummary = isCodingTask && typeof args.task === "string" ? args.task.trim() : "";
      const startedAt = Date.now();

      const headerLogId = isCodingTask
        ? addLog(
            "tool",
            formatCodingTaskHeader(codingAgentRef.current, taskSummary, 0, "running")
          )
        : addLog("tool", `${name}(${rawArgs})`);

      let heartbeat: number | null = null;
      if (isCodingTask) {
        heartbeat = window.setInterval(() => {
          updateLog(
            headerLogId,
            formatCodingTaskHeader(
              codingAgentRef.current,
              taskSummary,
              Date.now() - startedAt,
              "running"
            )
          );
        }, CODING_TASK_HEARTBEAT_MS);
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
              toolAbortReasonsRef.current.get(abortController) ?? "Coding agent task was interrupted."
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

      if (isCodingTask) {
        const finalState: CodingTaskHeaderState = interrupted
          ? "interrupted"
          : result.ok
            ? "done"
            : "error";
        updateLog(
          headerLogId,
          formatCodingTaskHeader(
            codingAgentRef.current,
            taskSummary,
            Date.now() - startedAt,
            finalState
          )
        );
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
          onRealtimeResult(originChannel, callId, result, interrupted);
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
    [addLog, codingAgentRef, conversationRevisionRef, dataChannelRef, onPendingPatch, onRealtimeResult, updateLog]
  );

  return {
    abortCodexTasks,
    clearAbortControllers,
    executeToolCall
  };
}
