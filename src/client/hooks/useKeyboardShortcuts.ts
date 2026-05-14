import { useEffect } from "react";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../../shared/contracts";
import type { ConnectionStatus } from "../types";

type Options = {
  status: ConnectionStatus;
  approvals: CodexApprovalRequest[];
  activeApprovalIndex: number;
  setActiveApprovalIndex: (updater: (current: number) => number) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onClearLogs: () => void;
  onSendText: () => void;
  onResolveApproval: (approval: CodexApprovalRequest, decision: CodexApprovalDecision) => void;
  onToggleMute: () => void;
};

export function useKeyboardShortcuts({
  status,
  approvals,
  activeApprovalIndex,
  setActiveApprovalIndex,
  onConnect,
  onDisconnect,
  onClearLogs,
  onSendText,
  onResolveApproval,
  onToggleMute
}: Options) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      const meta = event.metaKey || event.ctrlKey;

      // ⌘D — Connect/Disconnect toggle
      if (meta && event.key.toLowerCase() === "d") {
        event.preventDefault();
        if (status === "connected") {
          onDisconnect();
        } else if (status === "idle" || status === "disconnected" || status === "error") {
          onConnect();
        }
        return;
      }

      // ⌘L — Clear log
      if (meta && event.key.toLowerCase() === "l") {
        event.preventDefault();
        onClearLogs();
        return;
      }

      // ⌘Enter — Send text
      if (meta && event.key === "Enter") {
        event.preventDefault();
        onSendText();
        return;
      }

      // Esc — Decline current approval
      const activeApproval = approvals[activeApprovalIndex];
      if (event.key === "Escape" && activeApproval) {
        event.preventDefault();
        onResolveApproval(activeApproval, "decline");
        return;
      }

      // Arrow keys — Approval queue navigation
      if (approvals.length > 1 && !isEditable) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setActiveApprovalIndex((current) => Math.max(current - 1, 0));
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          setActiveApprovalIndex((current) => Math.min(current + 1, approvals.length - 1));
          return;
        }
      }

      // Space — Toggle mute (when not in an input)
      if (event.code === "Space" && !isEditable && status === "connected") {
        event.preventDefault();
        onToggleMute();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeApprovalIndex,
    approvals,
    onClearLogs,
    onConnect,
    onDisconnect,
    onResolveApproval,
    onSendText,
    onToggleMute,
    setActiveApprovalIndex,
    status
  ]);
}
