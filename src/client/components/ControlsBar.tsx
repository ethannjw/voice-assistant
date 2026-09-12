import { GitPullRequest, Mic, MicOff, Phone, PhoneOff, Play } from "lucide-react";

type Props = {
  meeting?: boolean;
  connecting?: boolean;
  isConnected: boolean;
  muted: boolean;
  hasProject: boolean;
  micLevel: number;
  micPermissionError: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleMute: () => void;
  onInspect: () => void;
  onRunTests: () => void;
};

export function ControlsBar({
  meeting = false,
  connecting = false,
  isConnected,
  muted,
  hasProject,
  micLevel,
  micPermissionError,
  onConnect,
  onDisconnect,
  onToggleMute,
  onInspect,
  onRunTests
}: Props) {
  return (
    <>
      <div className="controls">
        {!isConnected && !connecting ? (
          <button className="primary" type="button" onClick={onConnect} title="Connect (⌘D)">
            <Phone size={18} />
            {meeting ? "Join meeting" : "Connect"}
          </button>
        ) : (
          <button className="danger" type="button" onClick={onDisconnect} title="Disconnect (⌘D)">
            <PhoneOff size={18} />
            {meeting ? "Leave meeting" : "Disconnect"}
          </button>
        )}
        <button type="button" onClick={onToggleMute} disabled={!isConnected} title="Mute (Space)">
          {muted ? <MicOff size={18} /> : <Mic size={18} />}
          {muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" onClick={onInspect} disabled={!hasProject}>
          <GitPullRequest size={18} />
          Inspect
        </button>
        <button type="button" onClick={onRunTests} disabled={!hasProject}>
          <Play size={18} />
          Tests
        </button>
        {isConnected && !meeting ? <MicMeter micLevel={micLevel} muted={muted} /> : null}
      </div>
      {muted && isConnected ? (
        <div className="mic-banner">
          <MicOff size={12} /> {meeting ? "MEETING INPUT MUTED" : "MIC MUTED"} — press Space to unmute
        </div>
      ) : null}
      {micPermissionError ? <div className="mic-banner">⚠ MIC ERROR: {micPermissionError}</div> : null}
    </>
  );
}

function MicMeter({ micLevel, muted }: { micLevel: number; muted: boolean }) {
  return (
    <div className={`mic-meter ${muted ? "muted" : ""}`} aria-label="Microphone level">
      {Array.from({ length: 8 }, (_, index) => {
        const threshold = (index + 1) / 8;
        const active = !muted && micLevel >= threshold * 0.6;
        const height = active ? 4 + Math.round(micLevel * 14) : 4;
        return (
          <span
            key={index}
            className="mic-meter-bar"
            style={{ height: `${height}px`, opacity: active ? 0.95 : 0.25 }}
          />
        );
      })}
    </div>
  );
}
