import type {
  PermissionOption,
  RequestPermissionResponse,
  SessionId
} from "@agentclientprotocol/sdk";
import type { CodexApprovalRequest } from "../../shared/contracts";

export type CursorSession = {
  sessionId: SessionId;
  cwd: string;
};

export type PendingCursorApproval = {
  request: CodexApprovalRequest;
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
};
