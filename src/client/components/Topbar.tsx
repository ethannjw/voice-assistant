import { STATUS_LABELS } from "../constants";
import { formatCodingAgentName } from "../lib/format";
import type { CodingAgentName } from "../../shared/contracts";
import type { ConnectionStatus } from "../types";

type Props = {
  status: ConnectionStatus;
  codingAgent: CodingAgentName | null;
  codingModel: string | null;
};

export function Topbar({ status, codingAgent, codingModel }: Props) {
  const codingAgentName = formatCodingAgentName(codingAgent);

  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Coding Agent // Realtime Voice Link</p>
        <h1>Voice Pair Programmer</h1>
      </div>
      <div className="topbar-statuses">
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
