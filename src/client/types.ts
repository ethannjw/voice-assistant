export type LogRole = "system" | "user" | "assistant" | "tool";

export type LogEntry = {
  id: string;
  role: LogRole;
  text: string;
};

export type AttentionState = "waiting" | "engaged";

export type RealtimeItem = {
  id?: string;
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ type?: string; transcript?: string; text?: string }>;
};

export type RealtimeEvent = {
  type: string;
  item_id?: string;
  response_id?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: Record<string, string>;
    output?: RealtimeItem[];
  };
  session?: {
    instructions?: string;
    tools?: Array<{ name?: string }>;
    audio?: { input?: { turn_detection?: { create_response?: boolean; interrupt_response?: boolean } } };
  };
  transcript?: string;
  delta?: string;
  item?: RealtimeItem;
  error?: {
    message?: string;
    event_id?: string;
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

export type CodingTaskHeaderState = "running" | "done" | "error" | "interrupted";

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
