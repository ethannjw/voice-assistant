import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const STDERR_BUFFER_LIMIT = 4_000;

type Listeners = {
  onPermission: (
    params: acp.RequestPermissionRequest,
    signal: AbortSignal
  ) => Promise<acp.RequestPermissionResponse>;
  onSessionUpdate: (params: acp.SessionNotification) => void;
  onProcessExit: (reason: Error) => void;
};

export class CursorProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientConnection | null = null;
  private contextPromise: Promise<acp.ClientContext> | null = null;
  private stderrBuffer = "";
  private disposed = false;

  constructor(
    private readonly command: string,
    private readonly listeners: Listeners
  ) {}

  getContext() {
    if (!this.contextPromise) {
      this.contextPromise = this.spawnAndInitialize().catch((error) => {
        this.contextPromise = null;
        throw error;
      });
    }
    return this.contextPromise;
  }

  async dispose() {
    this.disposed = true;
    this.connection?.close();
    this.connection = null;
    this.contextPromise = null;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }

  private async spawnAndInitialize() {
    const child = spawn(this.command, ["acp"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    await waitForSpawn(child, this.command);
    this.child = child;
    this.stderrBuffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-STDERR_BUFFER_LIMIT);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      const reason = new Error(
        `Cursor Agent exited${code === null ? "" : ` with code ${code}`}${
          signal ? ` (${signal})` : ""
        }.${this.stderrBuffer ? `\n${this.stderrBuffer.trim()}` : ""}`
      );
      this.child = null;
      this.connection = null;
      this.contextPromise = null;
      if (!this.disposed) {
        this.listeners.onProcessExit(reason);
      }
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const app = acp
      .client({ name: "voice-pair-programmer" })
      .onRequest(acp.methods.client.session.requestPermission, (context) =>
        this.listeners.onPermission(context.params, context.signal)
      )
      .onNotification(acp.methods.client.session.update, (context) => {
        this.listeners.onSessionUpdate(context.params);
      });
    const connection = app.connect(stream);
    this.connection = connection;

    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { configOptions: {} }
        },
        clientInfo: { name: "voice-pair-programmer", version: "0.1.0" }
      });
    } catch (error) {
      connection.close(error);
      child.kill();
      throw new Error(
        `Could not initialize Cursor Agent through \`${this.command} acp\`: ${formatError(error)}`
      );
    }

    return connection.agent;
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams, command: string) {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(
        new Error(
          `Could not start Cursor Agent with \`${command} acp\`. Install or authenticate Cursor Agent, or set CURSOR_AGENT_COMMAND. ${error.message}`
        )
      );
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
