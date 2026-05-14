import { STATUS_LABELS } from "../constants";
import type { ConnectionStatus } from "../types";

type Props = {
  status: ConnectionStatus;
};

export function Topbar({ status }: Props) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Codex App Server // Realtime Voice Link</p>
        <h1>Voice Pair Programmer</h1>
      </div>
      <div className={`status-pill ${status}`}>{STATUS_LABELS[status]}</div>
    </header>
  );
}
