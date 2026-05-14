import type { CodexApprovalRequest } from "../../shared/contracts";

export type RpcId = number;

export type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type PendingApproval = {
  messageId: RpcId;
  itemId: string | null;
  turnId: string | null;
  request: CodexApprovalRequest;
};

export type ApprovalBuild = {
  itemId: string | null;
  turnId: string | null;
  request: CodexApprovalRequest;
};

export type ThreadSession = {
  threadId: string;
  cwd: string;
  hasProject: boolean;
};

export type TextTurnResult = {
  text: string;
  threadId: string;
  turnId: string | null;
  status: string | null;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_TURN_TIMEOUT_MS = 300_000;
