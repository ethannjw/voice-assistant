export type LogRole = "system" | "user" | "assistant" | "tool";

export type LogEntry = {
  id: string;
  role: LogRole;
  text: string;
};

export type RealtimeEvent = {
  type: string;
  response?: {
    status?: string;
    output?: Array<{
      type: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
  session?: {
    tools?: Array<{ name?: string }>;
  };
  transcript?: string;
  delta?: string;
  item?: {
    role?: string;
    content?: Array<{ transcript?: string; text?: string }>;
  };
  error?: {
    message?: string;
  };
};

export type VoiceStyleId = "natural" | "console_ai" | "starship" | "synthetic" | "low_orbit";

export type VoiceStyle = {
  id: VoiceStyleId;
  name: string;
  detail: string;
};

export type ProjectCandidate = {
  name: string;
  path: string;
};

export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type CodexHeaderState = "running" | "done" | "error" | "interrupted";

export type ToastLevel = "info" | "error";

export type Toast = {
  id: string;
  level: ToastLevel;
  title: string;
  body: string;
};

export type ConfirmDialogState = {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
};
