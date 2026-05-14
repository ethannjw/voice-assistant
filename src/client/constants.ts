import type { ConnectionStatus, VoiceStyle } from "./types";

export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error"
};

export const VOICE_STYLES: VoiceStyle[] = [
  { id: "natural", name: "Natural", detail: "Clean Codex voice" },
  { id: "console_ai", name: "Console AI", detail: "Tight radio band" },
  { id: "starship", name: "Starship", detail: "Wide command deck" },
  { id: "synthetic", name: "Synthetic", detail: "Crisp machine tone" },
  { id: "low_orbit", name: "Low Orbit", detail: "Deep filtered comms" }
];

export const COLLAPSED_LINE_THRESHOLD = 14;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const APPROVAL_POLL_INTERVAL_MS = 1500;

export const CODEX_TASK_HEARTBEAT_MS = 120;

export const SCROLL_BOTTOM_THRESHOLD_PX = 80;
