import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexApprovalDecision } from "../../shared/contracts";
import {
  buildCommandApproval,
  buildFileChangeApproval,
  buildLegacyCommandApproval,
  buildLegacyFileApproval
} from "./approvals";
import { CodexProcess } from "./process";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  type ApprovalBuild,
  type PendingApproval,
  type RpcMessage,
  type TextTurnResult,
  type ThreadSession
} from "./types";

type Options = {
  model?: string;
  /** Codex `model_provider` name from ~/.codex/config.toml (e.g. a local bridge provider). */
  modelProvider?: string;
  noProjectWorkspace?: string;
};

/**
 * Orchestrates a Codex App Server session over JSON-RPC stdio.
 *
 * Responsibilities:
 *  - Initialize once and reuse threads keyed by working directory
 *  - Run text turns and stream agentMessage deltas back to the caller
 *  - Hold pending approval / file diff state and surface them to the UI
 *  - Handle server-initiated approval requests by queueing them
 */
export class CodexAppServer {
  readonly name = "codex" as const;
  private readonly process: CodexProcess;
  private initializePromise: Promise<void> | null = null;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingFileDiffs = new Map<string, string>();
  private readonly pendingTurnDiffs = new Map<string, string>();
  private readonly notificationListeners = new Set<(message: RpcMessage) => void>();
  private readonly threadSessions = new Map<string, Promise<ThreadSession>>();

  constructor(private readonly options: Options = {}) {
    this.process = new CodexProcess(
      {
        onMessage: (message) => this.handleIncoming(message),
        onProcessExit: () => {
          this.initializePromise = null;
          this.threadSessions.clear();
          this.pendingApprovals.clear();
          this.pendingFileDiffs.clear();
          this.pendingTurnDiffs.clear();
        }
      },
      { modelProvider: options.modelProvider }
    );
  }

  // ---------- Public API used by routes ----------

  async runTextTurn(projectPath: string | null, text: string, signal?: AbortSignal): Promise<TextTurnResult> {
    try {
      return await this.runTextTurnOnce(projectPath, text, signal);
    } catch (error) {
      if (!isStaleCodexVersionError(error)) {
        throw error;
      }
      this.restartProcess();
      return await this.runTextTurnOnce(projectPath, text, signal);
    }
  }

  listPendingApprovals() {
    return [...this.pendingApprovals.values()].map((approval) => approval.request);
  }

  resolveApproval(id: string, decision: CodexApprovalDecision) {
    const approval = this.pendingApprovals.get(id);
    if (!approval) return false;

    this.pendingApprovals.delete(id);
    if (approval.itemId) this.pendingFileDiffs.delete(approval.itemId);
    if (approval.turnId) this.pendingTurnDiffs.delete(approval.turnId);

    this.writeApprovalResponse(approval, decision);
    return true;
  }

  async dispose() {
    this.process.stop();
  }

  // ---------- Turn lifecycle ----------

  private async runTextTurnOnce(
    projectPath: string | null,
    text: string,
    signal?: AbortSignal
  ): Promise<TextTurnResult> {
    throwIfAborted(signal);
    const session = await this.getThreadSession(projectPath);
    const chunks: string[] = [];
    let turnId: string | null = null;
    let removeAbortListener: (() => void) | null = null;
    const completionAbortController = new AbortController();
    const abortCompletionWait = () => completionAbortController.abort();
    signal?.addEventListener("abort", abortCompletionWait, { once: true });

    const unsubscribe = this.onNotification((message) => {
      if (message.method !== "item/agentMessage/delta") return;
      const params = message.params ?? {};
      if (params.threadId === session.threadId) {
        chunks.push(String(params.delta ?? ""));
      }
    });

    const completedPromise = this.waitForNotification(
      "turn/completed",
      (params) =>
        params.threadId === session.threadId &&
        (!turnId || (params.turn as { id?: string } | undefined)?.id === turnId),
      DEFAULT_TURN_TIMEOUT_MS,
      completionAbortController.signal
    );
    completedPromise.catch(() => {});

    try {
      const response = (await this.process.request(
        "turn/start",
        {
          threadId: session.threadId,
          input: [{ type: "text", text, text_elements: [] }],
          cwd: session.cwd
        },
        DEFAULT_REQUEST_TIMEOUT_MS
      )) as { turn?: { id?: string } };

      turnId = response.turn?.id ?? null;
      if (signal && turnId) {
        const interruptTurn = () => {
          void this.process
            .request("turn/interrupt", { threadId: session.threadId, turnId }, DEFAULT_REQUEST_TIMEOUT_MS)
            .catch(() => {});
        };
        signal.addEventListener("abort", interruptTurn, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", interruptTurn);

        if (signal.aborted) {
          interruptTurn();
          throw createAbortError();
        }
      }

      const completed = await completedPromise;
      const turn = completed.turn as { status?: string; error?: { message?: string } } | undefined;

      if (turn?.status === "failed") {
        throw new Error(turn.error?.message ?? "Codex turn failed.");
      }

      return {
        text: chunks.join("").trim(),
        threadId: session.threadId,
        turnId,
        status: turn?.status ?? null
      };
    } finally {
      removeAbortListener?.();
      signal?.removeEventListener("abort", abortCompletionWait);
      completionAbortController.abort();
      unsubscribe();
    }
  }

  // ---------- Thread management ----------

  private async getThreadSession(projectPath: string | null) {
    const hasProject = Boolean(projectPath);
    const cwd = projectPath
      ? path.resolve(projectPath)
      : await ensureNoProjectWorkspace(this.options.noProjectWorkspace);
    const key = `${hasProject ? "project" : "none"}:${cwd}`;
    const existing = this.threadSessions.get(key);
    if (existing) return existing;

    const created = this.startThread(cwd, hasProject);
    this.threadSessions.set(key, created);
    return created;
  }

  private async startThread(cwd: string, hasProject: boolean): Promise<ThreadSession> {
    await this.ensureInitialized();
    const response = (await this.process.request("thread/start", {
      cwd,
      model: this.options.model,
      approvalPolicy: hasProject ? "on-request" : "never",
      approvalsReviewer: "user",
      sandbox: hasProject ? "workspace-write" : "read-only",
      developerInstructions: buildDeveloperInstructions(hasProject)
    })) as { thread?: { id?: string } };

    const threadId = response.thread?.id;
    if (!threadId) {
      throw new Error("Codex App Server did not return a thread id.");
    }
    return { threadId, cwd, hasProject };
  }

  private async ensureInitialized() {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initialize();
    return this.initializePromise;
  }

  private async initialize() {
    this.process.ensureSpawned();
    await this.process.request("initialize", {
      clientInfo: {
        name: "voice_pair_programmer",
        title: "Voice Pair Programmer",
        version: "0.1.0"
      },
      capabilities: { experimentalApi: true }
    });
    this.process.notify("initialized");
  }

  private restartProcess() {
    this.process.restart();
    this.initializePromise = null;
    this.threadSessions.clear();
  }

  // ---------- Incoming message routing ----------

  private handleIncoming(message: RpcMessage) {
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.captureNotification(message);
      for (const listener of this.notificationListeners) {
        listener(message);
      }
    }
  }

  private handleServerRequest(message: RpcMessage) {
    if (message.id === undefined) return;

    switch (message.method) {
      case "item/commandExecution/requestApproval":
        this.queueApproval(message, buildCommandApproval(message));
        return;
      case "item/fileChange/requestApproval":
        this.queueApproval(
          message,
          buildFileChangeApproval(message, this.pendingFileDiffs, this.pendingTurnDiffs)
        );
        return;
      case "execCommandApproval":
        this.queueApproval(message, buildLegacyCommandApproval(message));
        return;
      case "applyPatchApproval":
        this.queueApproval(message, buildLegacyFileApproval(message));
        return;
      case "item/tool/requestUserInput":
        this.process.write({ id: message.id, result: { answers: {} } });
        return;
      default:
        this.process.write({
          id: message.id,
          error: {
            code: -32601,
            message: `Unsupported Codex App Server request: ${message.method}`
          }
        });
    }
  }

  // ---------- Approval bookkeeping ----------

  private captureNotification(message: RpcMessage) {
    if (message.method === "turn/diff/updated") {
      this.captureTurnDiff(message);
      return;
    }
    if (message.method === "item/started") {
      this.captureStartedFileChange(message);
      return;
    }
    if (message.method === "item/fileChange/patchUpdated") {
      this.captureFileChangeDiff(message);
    }
  }

  private captureTurnDiff(message: RpcMessage) {
    const params = message.params ?? {};
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const diff = typeof params.diff === "string" ? params.diff : "";
    if (!turnId || !diff.trim()) return;

    this.pendingTurnDiffs.set(turnId, diff);
    for (const approval of this.pendingApprovals.values()) {
      if (approval.request.kind === "file_change" && approval.turnId === turnId && !approval.request.diff) {
        approval.request.diff = diff;
      }
    }
  }

  private captureFileChangeDiff(message: RpcMessage) {
    const params = message.params ?? {};
    const itemId = getString(params.itemId);
    const turnId = getString(params.turnId);
    const changes = Array.isArray(params.changes) ? params.changes : [];
    this.captureFileChangeDiffFromChanges(itemId, turnId, changes);
  }

  private captureStartedFileChange(message: RpcMessage) {
    const params = message.params ?? {};
    const item = isRecord(params.item) ? params.item : null;
    const itemType = getString(item?.type) ?? getString(params.type);
    if (itemType !== "fileChange" && itemType !== "file_change") return;

    const itemId = getString(params.itemId) ?? getString(item?.id);
    const turnId = getString(params.turnId) ?? getString(item?.turnId);
    const changes = getChanges(item?.changes) ?? getChanges(params.changes) ?? [];
    this.captureFileChangeDiffFromChanges(itemId, turnId, changes);
  }

  private captureFileChangeDiffFromChanges(
    itemId: string | null,
    turnId: string | null,
    changes: unknown[]
  ) {
    if (!itemId || !changes.length) return;

    const diff = changes
      .map((change) => {
        if (!isRecord(change)) return "";
        const path = getString(change.path) ?? getString(change.filePath);
        const pathLabel = path ? `# ${path}\n` : "";
        const content =
          getString(change.diff) ??
          getString(change.unifiedDiff) ??
          getString(change.unified_diff) ??
          getString(change.patch) ??
          "";
        return `${pathLabel}${content}`.trim();
      })
      .filter(Boolean)
      .join("\n\n");
    if (!diff) return;

    this.pendingFileDiffs.set(itemId, diff);
    if (turnId) this.pendingTurnDiffs.set(turnId, diff);
    for (const approval of this.pendingApprovals.values()) {
      if (approval.request.kind === "file_change" && approval.itemId === itemId) {
        approval.request.diff = diff;
      }
      if (turnId && approval.request.kind === "file_change" && approval.turnId === turnId && !approval.request.diff) {
        approval.request.diff = diff;
      }
    }
  }

  private queueApproval(message: RpcMessage, approval: ApprovalBuild) {
    if (message.id === undefined) return;
    this.pendingApprovals.set(approval.request.id, {
      messageId: message.id,
      itemId: approval.itemId,
      turnId: approval.turnId,
      request: approval.request
    });
  }

  private writeApprovalResponse(approval: PendingApproval, decision: CodexApprovalDecision) {
    if (approval.request.kind === "legacy_command" || approval.request.kind === "legacy_file_change") {
      this.process.write({
        id: approval.messageId,
        result: {
          decision:
            decision === "decline"
              ? "denied"
              : decision === "acceptForSession"
                ? "approved_for_session"
                : "approved"
        }
      });
      return;
    }
    this.process.write({ id: approval.messageId, result: { decision } });
  }

  // ---------- Notification listeners ----------

  private onNotification(listener: (message: RpcMessage) => void) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  private waitForNotification(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Codex App Server notification: ${method}`));
      }, timeoutMs);

      const abort = () => {
        cleanup();
        reject(createAbortError());
      };

      const unsubscribe = this.onNotification((message) => {
        if (message.method !== method || !predicate(message.params ?? {})) return;
        cleanup();
        resolve(message.params ?? {});
      });

      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
      }

      function cleanup() {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
      }
    });
  }
}

// ---------- Free helpers ----------

function isStaleCodexVersionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("requires a newer version of Codex");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function getChanges(value: unknown) {
  return Array.isArray(value) ? value : null;
}

function createAbortError() {
  return new DOMException("Codex App Server turn interrupted.", "AbortError");
}

async function ensureNoProjectWorkspace(configuredPath?: string) {
  const workspace = path.resolve(
    configuredPath ?? path.join(os.tmpdir(), "voice-pair-programmer", "no-project")
  );
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function buildDeveloperInstructions(hasProject: boolean) {
  if (hasProject) {
    return [
      "You are the coding agent behind Voice Pair Programmer, whose user-facing assistant is named Elva.",
      "Use the selected repository as the working directory.",
      "Investigate first, keep edits focused, and explain behavior in concise language.",
      "Do not ask the user to type local paths; repository selection is managed by the application UI."
    ].join("\n");
  }

  return [
    "You are the coding agent behind Voice Pair Programmer, whose user-facing assistant is named Elva.",
    "No project is selected. You may answer general questions and help the user try the app.",
    "Do not inspect or modify a real repository until the user selects a project in the application UI."
  ].join("\n");
}
