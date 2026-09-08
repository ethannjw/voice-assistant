import { STATUS_LABELS } from "../constants";
import { formatCodingAgentName } from "../lib/format";
import type { CodingAgentName } from "../../shared/contracts";
import type { AttentionState, ConnectionStatus } from "../types";

type Props = {
  status: ConnectionStatus;
  attentionState: AttentionState;
  codingAgent: CodingAgentName | null;
  codingModel: string | null;
};

export function Topbar({ status, attentionState, codingAgent, codingModel }: Props) {
  const codingAgentName = formatCodingAgentName(codingAgent);

  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Coding Agent // Realtime Voice Link</p>
        <h1>Voice Pair Programmer</h1>
      </div>
      <div className="topbar-statuses">
        {status === "connected" && (
          <span className="agent-pill" role="status" aria-label="Conversation attention"
            title="Address Elva to begin. Clear follow-ups work without her name for 30 seconds after an exchange.">
            {attentionState === "engaged" ? "In conversation" : "Waiting for Elva"}
          </span>
        )}
        <span
          className={`agent-pill ${codingAgent ?? "loading"}`}
          aria-label={`Coding harness: ${codingAgentName}`}
          title={codingModel ? `Model: ${codingModel}` : "Using the harness default model"}
        >
          {codingAgentName}
        </span>
        <div className={`status-pill ${status}`}>{STATUS_LABELS[status]}</div>
      </div>
    </header>
  );
}
