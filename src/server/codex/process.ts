import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./types";
import type { PendingRequest, RpcId, RpcMessage } from "./types";

const STDERR_BUFFER_LIMIT = 4000;

type Listeners = {
  onMessage: (message: RpcMessage) => void;
  onProcessExit: (reason: Error) => void;
};

type Options = {
  /** Codex `model_provider` key from ~/.codex/config.toml, passed as `-c model_provider=<name>`. */
  modelProvider?: string;
};

/**
 * Codex CLI restricts `--profile` to runtime commands (`codex`, `codex exec`, `codex mcp`, ...).
 * As of codex-cli 0.153 `codex --profile <name> app-server` exits immediately with:
 *   "--profile only applies to runtime commands and `codex mcp`"
 * and `-c profile=<name>` is rejected as legacy config. So a custom provider has to be selected
 * with an explicit `-c model_provider=<name>` override instead.
 */
function buildCodexArgs(modelProvider?: string) {
  return [
    "app-server",
    ...(modelProvider ? ["-c", `model_provider=${modelProvider}`] : []),
    "--listen",
    "stdio://"
  ];
}

/**
 * Owns the codex app-server child process and the JSON-RPC framing.
 *
 * - Spawn / kill / restart the child process
 * - Buffer stdout, parse line-delimited JSON-RPC messages
 * - Track pending requests by id and resolve on response
 * - Surface notifications + server-initiated requests through onMessage
 */
export class CodexProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly pendingRequests = new Map<RpcId, PendingRequest>();

  constructor(
    private readonly listeners: Listeners,
    private readonly options: Options = {}
  ) {}

  ensureSpawned() {
    if (this.child) return;

    const child = spawn("codex", buildCodexArgs(this.options.modelProvider), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-STDERR_BUFFER_LIMIT);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      const reason = `Codex App Server exited${code === null ? "" : ` with code ${code}`}${
        signal ? ` (${signal})` : ""
      }.${this.stderrBuffer ? `\n${this.stderrBuffer.trim()}` : ""}`;
      this.child = null;
      this.rejectAllPending(new Error(reason));
      this.listeners.onProcessExit(new Error(reason));
    });

    this.child = child;
  }

  restart() {
    this.child?.kill();
    this.child = null;
    this.rejectAllPending(new Error("Codex App Server was restarted."));
  }

  /** Send a JSON-RPC request and return a promise resolving with the result. */
  request(method: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.ensureSpawned();

    const id = this.nextId++;
    const message: RpcMessage = { id, method };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.write(message);
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: Record<string, unknown>) {
    const message: RpcMessage = { method };
    if (params !== undefined) {
      message.params = params;
    }
    this.write(message);
  }

  /** Write a raw JSON-RPC message (used when responding to server-initiated requests). */
  write(message: RpcMessage) {
    if (!this.child?.stdin.writable) {
      throw new Error("Codex App Server is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rejectAllPending(error: Error) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;

      const raw = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!raw) continue;

      try {
        const message = JSON.parse(raw) as RpcMessage;
        if (message.id !== undefined && !message.method) {
          this.handleResponse(message);
        } else {
          this.listeners.onMessage(message);
        }
      } catch (error) {
        console.warn("Failed to parse Codex App Server message:", error);
      }
    }
  }

  private handleResponse(message: RpcMessage) {
    if (message.id === undefined) return;
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Codex App Server error ${message.error.code ?? ""}`));
      return;
    }

    pending.resolve(message.result);
  }
}
