import { SPINNER_FRAMES } from "../constants";
import type { CodingTaskHeaderState } from "../types";
import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodingAgentName
} from "../../shared/contracts";

export function formatElapsed(totalSeconds: number) {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function formatCodingTaskHeader(
  codingAgent: CodingAgentName | null,
  task: string,
  elapsedMs: number,
  state: CodingTaskHeaderState
) {
  const codingAgentName = formatCodingAgentName(codingAgent);
  const trimmed = task.length > 96 ? `${task.slice(0, 93)}...` : task;
  const taskPart = trimmed ? ` — ${trimmed}` : "";
  const seconds = Math.floor(elapsedMs / 1000);
  const elapsed = formatElapsed(seconds);

  if (state === "running") {
    const spinner = SPINNER_FRAMES[Math.floor(elapsedMs / 100) % SPINNER_FRAMES.length];
    return `${spinner} ${codingAgentName} · coding_task · running ${elapsed}${taskPart}`;
  }

  if (state === "done") {
    return `✓ ${codingAgentName} · coding_task · finished in ${elapsed}${taskPart}`;
  }

  if (state === "interrupted") {
    return `⏸ ${codingAgentName} · coding_task · interrupted at ${elapsed}${taskPart}`;
  }

  return `✗ ${codingAgentName} · coding_task · failed after ${elapsed}${taskPart}`;
}

export function formatCodingAgentName(codingAgent: CodingAgentName | null) {
  if (codingAgent === "cursor") return "Cursor";
  if (codingAgent === "codex") return "Codex";
  return "Loading";
}

export function metaShortcutLabel(key: string) {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/.test(navigator.platform || "");
  return `${isMac ? "⌘" : "Ctrl+"}${key}`;
}

export function formatApprovalKind(kind: CodexApprovalRequest["kind"]) {
  if (kind === "cursor_tool") {
    return "Cursor tool";
  }

  if (kind === "legacy_command") {
    return "command legacy";
  }

  if (kind === "command") {
    return "command";
  }

  if (kind === "legacy_file_change") {
    return "file change legacy";
  }

  return "file change";
}

export function formatApprovalDecision(decision: CodexApprovalDecision) {
  if (decision === "decline") {
    return "declined";
  }

  if (decision === "acceptForSession") {
    return "approved for this session";
  }

  return "approved";
}
