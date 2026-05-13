import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../shared/contracts";

type RpcId = number;

type RpcMessage = {
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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingApproval = {
  messageId: RpcId;
  request: CodexApprovalRequest;
};

type ThreadSession = {
  threadId: string;
  cwd: string;
  hasProject: boolean;
};

type TextTurnResult = {
  text: string;
  threadId: string;
  turnId: string | null;
  status: string | null;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_REALTIME_TIMEOUT_MS = 30_000;

export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private initializePromise: Promise<void> | null = null;
  private readonly pendingRequests = new Map<RpcId, PendingRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingFileDiffs = new Map<string, string>();
  private readonly notificationListeners = new Set<(message: RpcMessage) => void>();
  private readonly threadSessions = new Map<string, Promise<ThreadSession>>();
  private activeRealtimeThreadId: string | null = null;

  constructor(
    private readonly options: {
      noProjectWorkspace?: string;
      voice?: string;
    } = {}
  ) {}

  async startRealtimeSession(projectPath: string | null, sdp: string) {
    const session = await this.getThreadSession(projectPath);
    const sdpNotification = this.waitForNotification(
      "thread/realtime/sdp",
      (params) => params.threadId === session.threadId,
      DEFAULT_REALTIME_TIMEOUT_MS
    );

    await this.request("thread/realtime/start", {
      threadId: session.threadId,
      outputModality: "audio",
      prompt: buildRealtimePrompt(session.hasProject),
      transport: {
        type: "webrtc",
        sdp
      },
      voice: this.options.voice ?? "marin"
    });

    const notification = await sdpNotification;
    this.activeRealtimeThreadId = session.threadId;
    return String(notification.sdp ?? "");
  }

  async stopRealtimeSession() {
    if (!this.activeRealtimeThreadId) {
      return;
    }

    const threadId = this.activeRealtimeThreadId;
    this.activeRealtimeThreadId = null;
    await this.request("thread/realtime/stop", { threadId }, 10_000).catch(() => undefined);
  }

  async runTextTurn(projectPath: string | null, text: string): Promise<TextTurnResult> {
    const session = await this.getThreadSession(projectPath);
    const chunks: string[] = [];
    let turnId: string | null = null;

    const unsubscribe = this.onNotification((message) => {
      if (message.method !== "item/agentMessage/delta") {
        return;
      }

      const params = message.params ?? {};
      if (params.threadId === session.threadId) {
        chunks.push(String(params.delta ?? ""));
      }
    });

    try {
      const response = (await this.request(
        "turn/start",
        {
          threadId: session.threadId,
          input: [
            {
              type: "text",
              text,
              text_elements: []
            }
          ],
          cwd: session.cwd
        },
        DEFAULT_REQUEST_TIMEOUT_MS
      )) as { turn?: { id?: string } };

      turnId = response.turn?.id ?? null;
      const completed = await this.waitForNotification(
        "turn/completed",
        (params) =>
          params.threadId === session.threadId && (!turnId || (params.turn as { id?: string } | undefined)?.id === turnId),
        DEFAULT_TURN_TIMEOUT_MS
      );
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
      unsubscribe();
    }
  }

  listPendingApprovals() {
    return [...this.pendingApprovals.values()].map((approval) => approval.request);
  }

  resolveApproval(id: string, decision: CodexApprovalDecision) {
    const approval = this.pendingApprovals.get(id);
    if (!approval) {
      return false;
    }

    this.pendingApprovals.delete(id);
    this.writeApprovalResponse(approval, decision);
    return true;
  }

  private async getThreadSession(projectPath: string | null) {
    const hasProject = Boolean(projectPath);
    const cwd = projectPath ? path.resolve(projectPath) : await ensureNoProjectWorkspace(this.options.noProjectWorkspace);
    const key = `${hasProject ? "project" : "none"}:${cwd}`;
    const existing = this.threadSessions.get(key);

    if (existing) {
      return existing;
    }

    const created = this.startThread(cwd, hasProject);
    this.threadSessions.set(key, created);
    return created;
  }

  private async startThread(cwd: string, hasProject: boolean): Promise<ThreadSession> {
    await this.ensureInitialized();
    const response = (await this.request("thread/start", {
      cwd,
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
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.initialize();
    return this.initializePromise;
  }

  private async initialize() {
    this.startProcess();
    await this.request("initialize", {
      clientInfo: {
        name: "voice_pair_programmer",
        title: "Voice Pair Programmer",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized");
  }

  private startProcess() {
    if (this.child) {
      return;
    }

    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4000);
    });
    child.on("exit", (code, signal) => {
      const reason = `Codex App Server exited${code === null ? "" : ` with code ${code}`}${
        signal ? ` (${signal})` : ""
      }.${this.stderrBuffer ? `\n${this.stderrBuffer.trim()}` : ""}`;
      this.child = null;
      this.initializePromise = null;
      this.threadSessions.clear();
      this.rejectPending(new Error(reason));
    });

    this.child = child;
  }

  private request(method: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.startProcess();

    const id = this.nextId++;
    const message: RpcMessage = { id, method };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.write(message);
    });
  }

  private notify(method: string, params?: Record<string, unknown>) {
    const message: RpcMessage = { method };
    if (params !== undefined) {
      message.params = params;
    }
    this.write(message);
  }

  private write(message: RpcMessage) {
    if (!this.child?.stdin.writable) {
      throw new Error("Codex App Server is not running.");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;

    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const raw = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!raw) {
        continue;
      }

      try {
        this.handleMessage(JSON.parse(raw) as RpcMessage);
      } catch (error) {
        console.warn("Failed to parse Codex App Server message:", error);
      }
    }
  }

  private handleMessage(message: RpcMessage) {
    if (message.id !== undefined && !message.method) {
      this.handleResponse(message);
      return;
    }

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

  private handleResponse(message: RpcMessage) {
    if (message.id === undefined) {
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Codex App Server error ${message.error.code ?? ""}`));
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(message: RpcMessage) {
    if (message.id === undefined) {
      return;
    }

    if (message.method === "item/commandExecution/requestApproval") {
      this.queueApproval(message, buildCommandApproval(message));
      return;
    }

    if (message.method === "item/fileChange/requestApproval") {
      this.queueApproval(message, buildFileChangeApproval(message, this.pendingFileDiffs));
      return;
    }

    if (message.method === "execCommandApproval") {
      this.queueApproval(message, buildLegacyCommandApproval(message));
      return;
    }

    if (message.method === "applyPatchApproval") {
      this.queueApproval(message, buildLegacyFileApproval(message));
      return;
    }

    if (message.method === "item/tool/requestUserInput") {
      this.write({ id: message.id, result: { answers: {} } });
      return;
    }

    this.write({
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported Codex App Server request: ${message.method}`
      }
    });
  }

  private captureNotification(message: RpcMessage) {
    if (message.method !== "item/fileChange/patchUpdated") {
      return;
    }

    const params = message.params ?? {};
    const itemId = typeof params.itemId === "string" ? params.itemId : "";
    const changes = Array.isArray(params.changes) ? params.changes : [];
    if (!itemId || !changes.length) {
      return;
    }

    const diff = changes
      .map((change) => {
        if (!change || typeof change !== "object") {
          return "";
        }

        const pathLabel = "path" in change && typeof change.path === "string" ? `# ${change.path}\n` : "";
        const content = "diff" in change && typeof change.diff === "string" ? change.diff : "";
        return `${pathLabel}${content}`.trim();
      })
      .filter(Boolean)
      .join("\n\n");

    if (!diff) {
      return;
    }

    this.pendingFileDiffs.set(itemId, diff);
    for (const approval of this.pendingApprovals.values()) {
      if (approval.request.kind === "file_change" && approval.request.id.startsWith(`file_change:${itemId}:`)) {
        approval.request.diff = diff;
      }
    }
  }

  private queueApproval(message: RpcMessage, request: CodexApprovalRequest) {
    if (message.id === undefined) {
      return;
    }

    this.pendingApprovals.set(request.id, {
      messageId: message.id,
      request
    });
  }

  private writeApprovalResponse(approval: PendingApproval, decision: CodexApprovalDecision) {
    if (approval.request.kind === "legacy_command" || approval.request.kind === "legacy_file_change") {
      this.write({
        id: approval.messageId,
        result: {
          decision: decision === "decline" ? "denied" : decision === "acceptForSession" ? "approved_for_session" : "approved"
        }
      });
      return;
    }

    this.write({
      id: approval.messageId,
      result: { decision }
    });
  }

  private onNotification(listener: (message: RpcMessage) => void) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  private waitForNotification(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
    timeoutMs: number
  ) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for Codex App Server notification: ${method}`));
      }, timeoutMs);

      const unsubscribe = this.onNotification((message) => {
        if (message.method !== method || !predicate(message.params ?? {})) {
          return;
        }

        clearTimeout(timer);
        unsubscribe();
        resolve(message.params ?? {});
      });
    });
  }

  private rejectPending(error: Error) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }

    this.pendingApprovals.clear();
    this.pendingFileDiffs.clear();
  }
}

function buildCommandApproval(message: RpcMessage): CodexApprovalRequest {
  const params = message.params ?? {};
  const command = typeof params.command === "string" ? params.command : null;
  const cwd = typeof params.cwd === "string" ? params.cwd : null;
  const itemId = typeof params.itemId === "string" ? params.itemId : String(message.id ?? "");
  const approvalId = typeof params.approvalId === "string" ? params.approvalId : null;

  return {
    id: `command:${approvalId ?? itemId}:${message.id}`,
    kind: "command",
    title: "Command execution",
    reason: typeof params.reason === "string" ? params.reason : null,
    command,
    cwd,
    grantRoot: null,
    diff: null,
    availableDecisions: getAvailableDecisions(params.availableDecisions),
    createdAt: new Date().toISOString()
  };
}

function buildFileChangeApproval(message: RpcMessage, pendingFileDiffs: Map<string, string>): CodexApprovalRequest {
  const params = message.params ?? {};
  const itemId = typeof params.itemId === "string" ? params.itemId : String(message.id ?? "");
  const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : null;

  return {
    id: `file_change:${itemId}:${message.id}`,
    kind: "file_change",
    title: "File change",
    reason: typeof params.reason === "string" ? params.reason : null,
    command: null,
    cwd: null,
    grantRoot,
    diff: pendingFileDiffs.get(itemId) ?? null,
    availableDecisions: ["accept", "acceptForSession", "decline"],
    createdAt: new Date().toISOString()
  };
}

function buildLegacyCommandApproval(message: RpcMessage): CodexApprovalRequest {
  const params = message.params ?? {};
  return {
    id: `legacy_command:${message.id}`,
    kind: "legacy_command",
    title: "Command execution",
    reason: typeof params.reason === "string" ? params.reason : null,
    command: typeof params.command === "string" ? params.command : null,
    cwd: typeof params.cwd === "string" ? params.cwd : null,
    grantRoot: null,
    diff: null,
    availableDecisions: ["accept", "decline"],
    createdAt: new Date().toISOString()
  };
}

function buildLegacyFileApproval(message: RpcMessage): CodexApprovalRequest {
  const params = message.params ?? {};
  return {
    id: `legacy_file_change:${message.id}`,
    kind: "legacy_file_change",
    title: "Patch application",
    reason: typeof params.reason === "string" ? params.reason : null,
    command: null,
    cwd: null,
    grantRoot: null,
    diff: typeof params.patch === "string" ? params.patch : null,
    availableDecisions: ["accept", "decline"],
    createdAt: new Date().toISOString()
  };
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

async function ensureNoProjectWorkspace(configuredPath?: string) {
  const workspace = path.resolve(configuredPath ?? path.join(os.tmpdir(), "voice-pair-programmer", "no-project"));
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function buildDeveloperInstructions(hasProject: boolean) {
  if (hasProject) {
    return [
      "You are the coding agent behind Voice Pair Programmer.",
      "Use the selected repository as the working directory.",
      "Investigate first, keep edits focused, and explain behavior in concise language.",
      "Do not ask the user to type local paths; repository selection is managed by the application UI."
    ].join("\n");
  }

  return [
    "You are the coding agent behind Voice Pair Programmer.",
    "No project is selected. You may answer general questions and help the user try the app.",
    "Do not inspect or modify a real repository until the user selects a project in the application UI."
  ].join("\n");
}

function buildRealtimePrompt(hasProject: boolean) {
  if (hasProject) {
    return "You are Voice Pair Programmer. Help with the selected local repository through Codex App Server. Keep spoken answers concise.";
  }

  return "You are Voice Pair Programmer. No project is selected, so answer general questions and explain that implementation requires selecting or creating a project first.";
}
