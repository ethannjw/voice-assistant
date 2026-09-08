import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodingAgentName
} from "../shared/contracts";
import { CodexAppServer } from "./codex";
import type { TextTurnResult } from "./codex/types";
import { CursorAgent } from "./cursor";

export interface CodingAgent {
  readonly name: CodingAgentName;
  runTextTurn(projectPath: string | null, text: string, signal?: AbortSignal): Promise<TextTurnResult>;
  listPendingApprovals(): CodexApprovalRequest[];
  resolveApproval(id: string, decision: CodexApprovalDecision): boolean;
  dispose(): Promise<void>;
}

type CreateCodingAgentOptions = {
  provider: CodingAgentName;
  cursorCommand?: string;
  cursorModel?: string;
  codexModel?: string;
  codexModelProvider?: string;
  noProjectWorkspace?: string;
};

export function parseCodingAgentName(value: string | undefined): CodingAgentName {
  const normalized = value?.trim().toLowerCase() || "cursor";
  if (normalized === "cursor" || normalized === "codex") {
    return normalized;
  }
  throw new Error(`CODING_AGENT must be cursor or codex, received: ${value}`);
}

export function createCodingAgent(options: CreateCodingAgentOptions): CodingAgent {
  if (options.provider === "cursor") {
    return new CursorAgent({
      command: options.cursorCommand,
      model: options.cursorModel,
      noProjectWorkspace: options.noProjectWorkspace
    });
  }

  return new CodexAppServer({
    model: options.codexModel,
    modelProvider: options.codexModelProvider,
    noProjectWorkspace: options.noProjectWorkspace
  });
}
