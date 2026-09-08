import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Conversation } from "./components/Conversation";
import { ControlsBar } from "./components/ControlsBar";
import { ProjectPanel } from "./components/ProjectPanel";
import { PromptRow } from "./components/PromptRow";
import { ToastStack } from "./components/ToastStack";
import { Topbar } from "./components/Topbar";
import { VoicePanel } from "./components/VoicePanel";
import { useCodexApprovals } from "./hooks/useCodexApprovals";
import { useConfirmDialog } from "./hooks/useConfirmDialog";
import { useConversationLogs } from "./hooks/useConversationLogs";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useMicrophoneLevel } from "./hooks/useMicrophoneLevel";
import { usePendingPatch } from "./hooks/usePendingPatch";
import { useProjectManager } from "./hooks/useProjectManager";
import { useRealtimeSession } from "./hooks/useRealtimeSession";
import { useToasts } from "./hooks/useToasts";
import { isVoiceStyleId } from "./lib/intent";
import type { CodingAgentName } from "../shared/contracts";
import type { VoiceStyleId } from "./types";

export function App() {
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyleId>(() => {
    const saved = localStorage.getItem("voice-style");
    return isVoiceStyleId(saved) ? saved : "natural";
  });
  const [input, setInput] = useState("");
  const [micPermissionError, setMicPermissionError] = useState("");
  const codingAgentRef = useRef<CodingAgentName | null>(null);

  const { toasts, pushToast } = useToasts();
  const { confirmDialog, requestConfirm, closeDialog } = useConfirmDialog();
  const {
    logs,
    addLog,
    updateLog,
    clearLogs,
    autoScroll,
    unreadCount,
    conversationRef,
    jumpToBottom
  } = useConversationLogs();

  const onSystemLog = useCallback((message: string) => addLog("system", message), [addLog]);

  const { micLevel, start: startMicMonitor, stop: stopMicMonitor } = useMicrophoneLevel();
  const { pendingPatch, setPendingPatch, isApplying, applyPendingPatch, discardPendingPatch } =
    usePendingPatch(onSystemLog);

  const realtime = useRealtimeSession({
    voiceStyle,
    codingAgentRef,
    addLog,
    updateLog,
    onSystemLog,
    onRealtimeError: (message) => pushToast("error", "REALTIME ERROR", message),
    onMicError: (message) => {
      setMicPermissionError(message);
      pushToast(
        "error",
        "MIC ACCESS DENIED",
        "Allow microphone access from the browser address bar, then retry."
      );
    },
    onMicStreamReady: (stream) => {
      setMicPermissionError("");
      startMicMonitor(stream);
    },
    onMicStreamEnded: stopMicMonitor,
    onPendingPatch: setPendingPatch
  });

  const approvals = useCodexApprovals({ onSystemLog });

  const projects = useProjectManager({
    isConnected: realtime.isConnected,
    disconnect: realtime.disconnect,
    requestConfirm,
    onSystemLog,
    onAfterChange: () => {
      setPendingPatch(null);
      approvals.clearApprovals();
    }
  });

  useEffect(() => {
    codingAgentRef.current = projects.config?.codingAgent ?? null;
  }, [projects.config?.codingAgent]);

  useKeyboardShortcuts({
    status: realtime.status,
    approvals: approvals.approvals,
    activeApprovalIndex: approvals.activeIndex,
    setActiveApprovalIndex: approvals.setActiveIndex,
    onConnect: () => void realtime.connect(),
    onDisconnect: realtime.disconnect,
    onClearLogs: clearLogs,
    onSendText: () => {
      void realtime.sendText(input);
      setInput("");
    },
    onResolveApproval: approvals.resolveApproval,
    onToggleMute: realtime.toggleMute
  });

  const hasProject = Boolean(projects.config?.activeProject);
  const canSendText = input.trim().length > 0 && !realtime.isTextSubmitting;

  const copyMessage = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        pushToast("info", "COPIED", "Message copied to clipboard.");
      } catch (error) {
        pushToast("error", "COPY FAILED", error instanceof Error ? error.message : String(error));
      }
    },
    [pushToast]
  );

  const submitText = () => {
    void realtime.sendText(input);
    setInput("");
  };

  return (
    <main className="app-shell">
      <section className="workspace-panel">
        <Topbar
          status={realtime.status}
          attentionState={realtime.attentionState}
          codingAgent={projects.config?.codingAgent ?? null}
          codingModel={projects.config?.codingModel ?? null}
        />

        <ProjectPanel
          config={projects.config}
          projectError={projects.projectError}
          isDiscovering={projects.isDiscovering}
          candidates={projects.candidates}
          onSelect={projects.selectProject}
          onDelete={projects.deleteProject}
          onDiscover={() => void projects.discoverProjects()}
          onAddCandidate={projects.addCandidate}
        />

        <ControlsBar
          isConnected={realtime.isConnected}
          muted={realtime.muted}
          hasProject={hasProject}
          micLevel={micLevel}
          micPermissionError={micPermissionError}
          onConnect={() => void realtime.connect()}
          onDisconnect={realtime.disconnect}
          onToggleMute={realtime.toggleMute}
          onInspect={() => void realtime.executeToolCall("workspace_status", null, "{}")}
          onRunTests={() => void realtime.executeToolCall("run_tests", null, "{}")}
        />

        <VoicePanel voiceStyle={voiceStyle} onChange={setVoiceStyle} />

        <PromptRow
          value={input}
          onChange={setInput}
          onSubmit={submitText}
          canSubmit={canSendText}
          isSubmitting={realtime.isTextSubmitting}
        />

        <Conversation
          logs={logs}
          conversationRef={conversationRef}
          hasProject={hasProject}
          activeProject={projects.config?.activeProject ?? null}
          unreadCount={unreadCount}
          showJumpToBottom={!autoScroll}
          onClear={clearLogs}
          onJumpToBottom={jumpToBottom}
          onCopy={copyMessage}
        />
      </section>

      <ApprovalPanel
        approvals={approvals.approvals}
        activeApprovalIndex={approvals.activeIndex}
        pendingPatch={pendingPatch}
        isApplying={isApplying}
        isResolvingApprovalId={approvals.isResolvingId}
        isConnected={realtime.isConnected}
        hasProject={hasProject}
        onSelectApproval={(index) => approvals.setActiveIndex(() => index)}
        onResolveApproval={approvals.resolveApproval}
        onApplyPatch={() => void applyPendingPatch()}
        onDiscardPatch={() => void discardPendingPatch()}
      />

      <ToastStack toasts={toasts} />
      <ConfirmDialog dialog={confirmDialog} onCancel={closeDialog} />
    </main>
  );
}
