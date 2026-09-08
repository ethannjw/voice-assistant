import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../../shared/contracts";
import type { CodingAgent } from "../codingAgent";
import type { TextTurnResult } from "../codex/types";
import { CursorProcess } from "./process";
import type { CursorSession, PendingCursorApproval } from "./types";

type Options = {
  command?: string;
  model?: string;
  noProjectWorkspace?: string;
};

export class CursorAgent implements CodingAgent {
  readonly name = "cursor" as const;
  private readonly process: CursorProcess;
  private readonly sessions = new Map<string, Promise<CursorSession>>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly activeChunks = new Map<string, string[]>();
  private readonly pendingApprovals = new Map<string, PendingCursorApproval>();

  constructor(private readonly options: Options = {}) {
    this.process = new CursorProcess(options.command?.trim() || "agent", {
      onPermission: (params, signal) => this.handlePermission(params, signal),
      onSessionUpdate: (params) => this.handleSessionUpdate(params),
      onProcessExit: () => {
        this.sessions.clear();
        this.sessionCwds.clear();
        this.activeChunks.clear();
        this.cancelPendingApprovals();
      }
    });
  }

  async runTextTurn(
    projectPath: string | null,
    text: string,
    signal?: AbortSignal
  ): Promise<TextTurnResult> {
    throwIfAborted(signal);
    const session = await waitForAbort(this.getSession(projectPath), signal);
    const context = await waitForAbort(this.process.getContext(), signal);
    const chunks: string[] = [];
    this.activeChunks.set(session.sessionId, chunks);

    const cancel = () => {
      void context.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
    };
    try {
      signal?.addEventListener("abort", cancel, { once: true });
      throwIfAborted(signal);
      const response = await context.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text }]
        }
      );
      throwIfAborted(signal);
      return {
        text: chunks.join("").trim(),
        threadId: session.sessionId,
        turnId: null,
        status: response.stopReason
      };
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.activeChunks.delete(session.sessionId);
    }
  }

  listPendingApprovals() {
    return [...this.pendingApprovals.values()].map((approval) => approval.request);
  }

  resolveApproval(id: string, decision: CodexApprovalDecision) {
    const approval = this.pendingApprovals.get(id);
    if (!approval) return false;
    this.pendingApprovals.delete(id);

    const option = selectPermissionOption(approval.options, decision);
    approval.resolve(
      option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } }
    );
    return true;
  }

  async dispose() {
    this.cancelPendingApprovals();
    this.sessions.clear();
    this.sessionCwds.clear();
    this.activeChunks.clear();
    await this.process.dispose();
  }

  private async getSession(projectPath: string | null) {
    const cwd = projectPath ? path.resolve(projectPath) : await ensureNoProjectWorkspace(this.options.noProjectWorkspace);
    let session = this.sessions.get(cwd);
    if (!session) {
      session = this.startSession(cwd).catch((error) => {
        this.sessions.delete(cwd);
        throw error;
      });
      this.sessions.set(cwd, session);
    }
    return session;
  }

  private async startSession(cwd: string): Promise<CursorSession> {
    const context = await this.process.getContext();
    const response = await context.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: []
    });

    if (response.modes && response.modes.currentModeId !== "agent") {
      const agentMode = response.modes.availableModes.find((mode) => mode.id === "agent");
      if (agentMode) {
        await context.request(acp.methods.agent.session.setMode, {
          sessionId: response.sessionId,
          modeId: agentMode.id
        });
      }
    }

    if (this.options.model) {
      const modelOption = response.configOptions?.find(
        (option) => option.type === "select" && (option.category === "model" || option.id === "model")
      );
      if (!modelOption || modelOption.type !== "select") {
        throw new Error(
          `Cursor Agent did not expose a model selector, so CURSOR_MODEL=${this.options.model} could not be applied.`
        );
      }
      await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId: response.sessionId,
        configId: modelOption.id,
        value: this.options.model
      });
    }

    this.sessionCwds.set(response.sessionId, cwd);
    return { sessionId: response.sessionId, cwd };
  }

  private handleSessionUpdate(params: acp.SessionNotification) {
    const chunks = this.activeChunks.get(params.sessionId);
    if (!chunks) return;
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      chunks.push(update.content.text);
    }
  }

  private handlePermission(params: acp.RequestPermissionRequest, signal: AbortSignal) {
    const id = randomUUID();
    const request: CodexApprovalRequest = {
      id,
      kind: "cursor_tool",
      title: params.toolCall.title ?? "Cursor tool request",
      reason: params.toolCall.kind ?? null,
      command: formatRawInput(params.toolCall.rawInput),
      cwd: this.sessionCwds.get(params.sessionId) ?? null,
      grantRoot: null,
      diff: extractDiff(params.toolCall.content),
      availableDecisions: availableDecisions(params.options),
      createdAt: new Date().toISOString()
    };

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const abort = () => {
        this.pendingApprovals.delete(id);
        resolve({ outcome: { outcome: "cancelled" } });
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingApprovals.set(id, {
        request,
        options: params.options,
        resolve: (response) => {
          signal.removeEventListener("abort", abort);
          resolve(response);
        }
      });
    });
  }

  private cancelPendingApprovals() {
    for (const approval of this.pendingApprovals.values()) {
      approval.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingApprovals.clear();
  }
}

function availableDecisions(options: acp.PermissionOption[]): CodexApprovalDecision[] {
  const decisions: CodexApprovalDecision[] = [];
  if (options.some((option) => option.kind === "allow_once" || option.kind === "allow_always")) {
    decisions.push("accept");
  }
  if (options.some((option) => option.kind === "allow_always")) {
    decisions.push("acceptForSession");
  }
  decisions.push("decline");
  return decisions;
}

function selectPermissionOption(
  options: acp.PermissionOption[],
  decision: CodexApprovalDecision
) {
  if (decision === "acceptForSession") {
    return options.find((option) => option.kind === "allow_always") ?? options.find(isAllowOption);
  }
  if (decision === "accept") {
    return options.find((option) => option.kind === "allow_once") ?? options.find(isAllowOption);
  }
  return options.find((option) => option.kind === "reject_once") ?? options.find(isRejectOption);
}

function isAllowOption(option: acp.PermissionOption) {
  return option.kind === "allow_once" || option.kind === "allow_always";
}

function isRejectOption(option: acp.PermissionOption) {
  return option.kind === "reject_once" || option.kind === "reject_always";
}

function formatRawInput(value: unknown) {
  if (!value) return null;
  if (isRecord(value) && typeof value.command === "string") {
    return value.command;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractDiff(content: acp.ToolCallContent[] | null | undefined) {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item.type === "diff") {
      const before = item.oldText
        ? item.oldText
            .split("\n")
            .map((line) => `-${line}`)
            .join("\n")
        : "-(new file)";
      const after = item.newText
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n");
      return [`--- ${item.path}`, `+++ ${item.path}`, before, after].join("\n");
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw cursorAbortError();
  }
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(cursorAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function cursorAbortError() {
  return new DOMException("Cursor Agent turn interrupted.", "AbortError");
}

async function ensureNoProjectWorkspace(configuredPath?: string) {
  const workspace = path.resolve(
    configuredPath ?? path.join(os.tmpdir(), "voice-pair-programmer", "no-project")
  );
  await mkdir(workspace, { recursive: true });
  return workspace;
}
