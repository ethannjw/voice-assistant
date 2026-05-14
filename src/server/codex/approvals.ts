import { randomUUID } from "node:crypto";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../../shared/contracts";
import type { ApprovalBuild, RpcMessage } from "./types";

export function buildCommandApproval(message: RpcMessage): ApprovalBuild {
  const params = message.params ?? {};
  const command = typeof params.command === "string" ? params.command : null;
  const cwd = typeof params.cwd === "string" ? params.cwd : null;
  const itemId = typeof params.itemId === "string" ? params.itemId : String(message.id ?? "");

  return {
    itemId,
    turnId: typeof params.turnId === "string" ? params.turnId : null,
    request: {
      id: makeApprovalId("command"),
      kind: "command",
      title: "Command execution",
      reason: typeof params.reason === "string" ? params.reason : null,
      command,
      cwd,
      grantRoot: null,
      diff: null,
      availableDecisions: getAvailableDecisions(params.availableDecisions),
      createdAt: new Date().toISOString()
    }
  };
}

export function buildFileChangeApproval(
  message: RpcMessage,
  pendingFileDiffs: Map<string, string>,
  pendingTurnDiffs: Map<string, string>
): ApprovalBuild {
  const params = message.params ?? {};
  const itemId = typeof params.itemId === "string" ? params.itemId : String(message.id ?? "");
  const turnId = typeof params.turnId === "string" ? params.turnId : null;
  const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : null;

  return {
    itemId,
    turnId,
    request: {
      id: makeApprovalId("file_change"),
      kind: "file_change",
      title: "File change",
      reason: typeof params.reason === "string" ? params.reason : null,
      command: null,
      cwd: null,
      grantRoot,
      diff: pendingFileDiffs.get(itemId) ?? (turnId ? pendingTurnDiffs.get(turnId) : null) ?? null,
      availableDecisions: ["accept", "acceptForSession", "decline"],
      createdAt: new Date().toISOString()
    }
  };
}

export function buildLegacyCommandApproval(message: RpcMessage): ApprovalBuild {
  const params = message.params ?? {};
  return {
    itemId: null,
    turnId: null,
    request: {
      id: makeApprovalId("legacy_command"),
      kind: "legacy_command",
      title: "Command execution (legacy)",
      reason: typeof params.reason === "string" ? params.reason : null,
      command: typeof params.command === "string" ? params.command : null,
      cwd: typeof params.cwd === "string" ? params.cwd : null,
      grantRoot: null,
      diff: null,
      availableDecisions: ["accept", "decline"],
      createdAt: new Date().toISOString()
    }
  };
}

export function buildLegacyFileApproval(message: RpcMessage): ApprovalBuild {
  const params = message.params ?? {};
  return {
    itemId: null,
    turnId: null,
    request: {
      id: makeApprovalId("legacy_file_change"),
      kind: "legacy_file_change",
      title: "Patch application (legacy)",
      reason: typeof params.reason === "string" ? params.reason : null,
      command: null,
      cwd: null,
      grantRoot: null,
      diff: typeof params.patch === "string" ? params.patch : null,
      availableDecisions: ["accept", "decline"],
      createdAt: new Date().toISOString()
    }
  };
}

function makeApprovalId(kind: CodexApprovalRequest["kind"]) {
  return `${kind}:${randomUUID()}`;
}

function getAvailableDecisions(value: unknown): CodexApprovalDecision[] {
  if (!Array.isArray(value)) {
    return ["accept", "acceptForSession", "decline"];
  }

  const decisions = value.filter(isSupportedDecision);
  return decisions.length ? decisions : ["accept", "decline"];
}

function isSupportedDecision(value: unknown): value is CodexApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline";
}
