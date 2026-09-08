import { Check, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { formatApprovalKind } from "../lib/format";
import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  PendingPatch
} from "../../shared/contracts";

type Props = {
  approvals: CodexApprovalRequest[];
  activeApprovalIndex: number;
  pendingPatch: PendingPatch | null;
  isApplying: boolean;
  isResolvingApprovalId: string | null;
  isConnected: boolean;
  hasProject: boolean;
  onSelectApproval: (index: number) => void;
  onResolveApproval: (approval: CodexApprovalRequest, decision: CodexApprovalDecision) => void;
  onApplyPatch: () => void;
  onDiscardPatch: () => void;
};

export function ApprovalPanel({
  approvals,
  activeApprovalIndex,
  pendingPatch,
  isApplying,
  isResolvingApprovalId,
  isConnected,
  hasProject,
  onSelectApproval,
  onResolveApproval,
  onApplyPatch,
  onDiscardPatch
}: Props) {
  const activeApproval = approvals[activeApprovalIndex] ?? null;

  return (
    <aside className="patch-panel">
      <header>
        <div>
          <p className="eyebrow">Human approval required</p>
          <h2>{activeApproval ? "Coding approval" : pendingPatch ? "Legacy patch" : "Approval queue"}</h2>
        </div>
        {activeApproval ? (
          <span className="patch-id">
            {activeApprovalIndex + 1}/{approvals.length}
          </span>
        ) : pendingPatch ? (
          <span className="patch-id">{pendingPatch.id.slice(0, 8)}</span>
        ) : null}
      </header>

      {activeApproval ? (
        <ApprovalView
          approval={activeApproval}
          approvalsCount={approvals.length}
          activeIndex={activeApprovalIndex}
          isResolving={isResolvingApprovalId === activeApproval.id}
          onSelect={onSelectApproval}
          onResolve={(decision) => onResolveApproval(activeApproval, decision)}
        />
      ) : pendingPatch ? (
        <LegacyPatchView
          patch={pendingPatch}
          isApplying={isApplying}
          onApply={onApplyPatch}
          onDiscard={onDiscardPatch}
        />
      ) : (
        <ApprovalEmptyState isConnected={isConnected} hasProject={hasProject} />
      )}
    </aside>
  );
}

function ApprovalView({
  approval,
  approvalsCount,
  activeIndex,
  isResolving,
  onSelect,
  onResolve
}: {
  approval: CodexApprovalRequest;
  approvalsCount: number;
  activeIndex: number;
  isResolving: boolean;
  onSelect: (index: number) => void;
  onResolve: (decision: CodexApprovalDecision) => void;
}) {
  return (
    <>
      <div className="approval-card">
        <div className="approval-meta">
          <span>{formatApprovalKind(approval.kind)}</span>
          <time>{new Date(approval.createdAt).toLocaleTimeString()}</time>
        </div>
        {approvalsCount > 1 ? (
          <div className="approval-queue-nav" aria-label="Approval queue">
            <button
              type="button"
              onClick={() => onSelect(Math.max(activeIndex - 1, 0))}
              disabled={activeIndex === 0}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              Request {activeIndex + 1} of {approvalsCount}
            </span>
            <button
              type="button"
              onClick={() => onSelect(Math.min(activeIndex + 1, approvalsCount - 1))}
              disabled={activeIndex >= approvalsCount - 1}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        ) : null}
        <h3>{approval.title}</h3>
        {approval.reason ? <p>{approval.reason}</p> : null}
        {approval.cwd ? (
          <div className="approval-field">
            <span>cwd</span>
            <code>{approval.cwd}</code>
          </div>
        ) : null}
        {approval.grantRoot ? (
          <div className="approval-field">
            <span>root</span>
            <code>{approval.grantRoot}</code>
          </div>
        ) : null}
        {approval.command ? <pre className="approval-command">{approval.command}</pre> : null}
      </div>
      {approval.diff ? (
        <div className="diff-frame">
          <pre className="diff-view">{approval.diff}</pre>
        </div>
      ) : null}
      <div className="patch-actions">
        {approval.availableDecisions.includes("accept") ? (
          <button
            className="primary"
            type="button"
            onClick={() => onResolve("accept")}
            disabled={isResolving}
          >
            <Check size={18} />
            Approve
          </button>
        ) : null}
        {approval.availableDecisions.includes("acceptForSession") ? (
          <button
            type="button"
            onClick={() => onResolve("acceptForSession")}
            disabled={isResolving}
          >
            <Check size={18} />
            Session
          </button>
        ) : null}
        <button
          className="danger"
          type="button"
          onClick={() => onResolve("decline")}
          disabled={isResolving}
        >
          <Trash2 size={18} />
          Decline
        </button>
      </div>
    </>
  );
}

function LegacyPatchView({
  patch,
  isApplying,
  onApply,
  onDiscard
}: {
  patch: PendingPatch;
  isApplying: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  return (
    <>
      <div className="diff-frame">
        <pre className="diff-view">{patch.diff}</pre>
      </div>
      <div className="patch-actions">
        <button className="primary" type="button" onClick={onApply} disabled={isApplying}>
          <Check size={18} />
          Apply
        </button>
        <button type="button" onClick={onDiscard}>
          <Trash2 size={18} />
          Discard
        </button>
      </div>
    </>
  );
}

function ApprovalEmptyState({
  isConnected,
  hasProject
}: {
  isConnected: boolean;
  hasProject: boolean;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-pulse">◇ ◇ ◇</span>
      <span className="empty-state-title">Approval queue clear</span>
      <p className="empty-state-subtitle">
        {isConnected
          ? hasProject
            ? "The coding agent will surface command and file-change requests here. Approve / Session / Decline to control execution."
            : "Select a project to let the coding agent inspect or modify a repository."
          : "Connect a session to begin. Coding requests will appear here once a task starts."}
      </p>
    </div>
  );
}
