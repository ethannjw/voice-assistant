import { ArrowDown, Copy, Eraser } from "lucide-react";
import { useState, type RefObject } from "react";
import { COLLAPSED_LINE_THRESHOLD } from "../constants";
import { metaShortcutLabel } from "../lib/format";
import { parseMessageSegments } from "../lib/messages";
import type { LogEntry, ProjectCandidate } from "../types";
import type { ProjectConfig } from "../../shared/contracts";

type Props = {
  logs: LogEntry[];
  conversationRef: RefObject<HTMLDivElement | null>;
  hasProject: boolean;
  activeProject: ProjectConfig | null;
  unreadCount: number;
  showJumpToBottom: boolean;
  onClear: () => void;
  onJumpToBottom: () => void;
  onCopy: (text: string) => void;
};

export function Conversation({
  logs,
  conversationRef,
  hasProject,
  activeProject,
  unreadCount,
  showJumpToBottom,
  onClear,
  onJumpToBottom,
  onCopy
}: Props) {
  return (
    <div className="conversation-frame">
      {logs.length > 0 ? (
        <div className="conversation-toolbar">
          <button type="button" className="ghost" onClick={onClear} title="Clear log (⌘L)">
            <Eraser size={12} /> Clear
          </button>
        </div>
      ) : null}
      <div className="conversation" ref={conversationRef}>
        {logs.length === 0 ? (
          <ConversationEmptyState hasProject={hasProject} activeProject={activeProject} />
        ) : (
          logs.map((log) => <MessageView key={log.id} log={log} onCopy={onCopy} />)
        )}
      </div>
      {showJumpToBottom && unreadCount > 0 ? (
        <button type="button" className="scroll-down-fab" onClick={onJumpToBottom}>
          <ArrowDown size={12} /> {unreadCount} new
        </button>
      ) : null}
    </div>
  );
}

function ConversationEmptyState({
  hasProject,
  activeProject
}: {
  hasProject: boolean;
  activeProject: ProjectConfig | null;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-pulse">▮ ▮ ▮</span>
      <span className="empty-state-title">Awaiting transmission</span>
      <p className="empty-state-subtitle">
        GPT-Realtime-2 handles the voice link. The configured coding agent handles implementation.
        Speak or type to start a session.
      </p>
      <ol className="empty-state-steps">
        <li>
          <strong>01</strong>
          <span>
            {hasProject
              ? `Active project: ${activeProject?.name}. Ready when you are.`
              : "Optional: select or add a project to enable repository tools."}
          </span>
        </li>
        <li>
          <strong>02</strong>
          <span>
            Press <code>CONNECT</code> ({metaShortcutLabel("D")}) and grant microphone access.
          </span>
        </li>
        <li>
          <strong>03</strong>
          <span>Speak naturally, or type a request — coding approvals appear here.</span>
        </li>
      </ol>
    </div>
  );
}

type MessageViewProps = {
  log: LogEntry;
  onCopy: (text: string) => void;
};

function MessageView({ log, onCopy }: MessageViewProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = log.text.split("\n");
  const longBody = lines.length > COLLAPSED_LINE_THRESHOLD;
  const visible = expanded || !longBody ? log.text : `${lines.slice(0, COLLAPSED_LINE_THRESHOLD).join("\n")}\n…`;
  const segments = parseMessageSegments(visible);

  return (
    <article className={`message ${log.role}`}>
      <div className="message-head">
        <span className="role">{log.role}</span>
        <button
          type="button"
          className="message-copy"
          onClick={() => onCopy(log.text)}
          title="Copy message"
        >
          <Copy size={11} /> COPY
        </button>
      </div>
      {segments.map((segment, index) =>
        segment.kind === "code" ? (
          <pre key={index} className="message-code">
            {segment.value}
          </pre>
        ) : (
          <p key={index}>{segment.value}</p>
        )
      )}
      {longBody ? (
        <button
          type="button"
          className="message-collapsed-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "▴ Collapse" : `▾ Show ${lines.length - COLLAPSED_LINE_THRESHOLD} more lines`}
        </button>
      ) : null}
    </article>
  );
}
