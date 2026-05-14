import { SPINNER_FRAMES } from "../constants";
import type { CodexHeaderState } from "../types";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../../shared/contracts";

export function formatElapsed(totalSeconds: number) {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function formatCodexHeader(task: string, elapsedMs: number, state: CodexHeaderState) {
  const trimmed = task.length > 96 ? `${task.slice(0, 93)}...` : task;
  const taskPart = trimmed ? ` — ${trimmed}` : "";
  const seconds = Math.floor(elapsedMs / 1000);
  const elapsed = formatElapsed(seconds);

  if (state === "running") {
    const spinner = SPINNER_FRAMES[Math.floor(elapsedMs / 100) % SPINNER_FRAMES.length];
    return `${spinner} codex_task · running ${elapsed}${taskPart}`;
  }

  if (state === "done") {
    return `✓ codex_task · finished in ${elapsed}${taskPart}`;
  }

  if (state === "interrupted") {
    return `⏸ codex_task · interrupted at ${elapsed}${taskPart}`;
  }

  return `✗ codex_task · failed after ${elapsed}${taskPart}`;
}

export function metaShortcutLabel(key: string) {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/.test(navigator.platform || "");
  return `${isMac ? "⌘" : "Ctrl+"}${key}`;
}

export function formatApprovalKind(kind: CodexApprovalRequest["kind"]) {
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
