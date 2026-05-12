import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PendingPatch, ToolName, ToolResult } from "../shared/contracts";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 24_000;
const MAX_FILE_BYTES = 80_000;

export class WorkspaceTools {
  private pendingPatch: PendingPatch | null = null;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  getWorkspaceRoot() {
    return this.workspaceRoot;
  }

  setWorkspaceRoot(workspaceRoot: string) {
    if (this.workspaceRoot !== workspaceRoot) {
      this.pendingPatch = null;
      this.workspaceRoot = workspaceRoot;
    }
  }

  getPendingPatch() {
    return this.pendingPatch;
  }

  clearPendingPatch(id: string) {
    if (this.pendingPatch?.id === id) {
      this.pendingPatch = null;
    }
  }

  async call(name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case "workspace_status":
          return await this.workspaceStatus();
        case "search_workspace":
          return await this.searchWorkspace(String(args.query ?? ""));
        case "read_file":
          return await this.readWorkspaceFile(String(args.path ?? ""));
        case "git_diff":
          return await this.gitDiff();
        case "run_tests":
          return await this.runTests();
        case "propose_patch":
          return this.proposePatch(String(args.diff ?? ""));
      }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async applyPatch(id: string): Promise<ToolResult> {
    if (!this.pendingPatch || this.pendingPatch.id !== id) {
      return { ok: false, output: `No pending patch found for id ${id}.` };
    }

    const result = await this.exec("git", ["apply", "--whitespace=fix", "-"], {
      input: this.pendingPatch.diff
    });

    if (result.ok) {
      this.pendingPatch = null;
    }

    return result;
  }

  private async workspaceStatus(): Promise<ToolResult> {
    const [status, files] = await Promise.all([
      this.exec("git", ["status", "--short"]),
      this.exec("git", ["ls-files"])
    ]);

    return {
      ok: status.ok && files.ok,
      output: [
        `Workspace: ${this.workspaceRoot}`,
        "",
        "Git status:",
        status.output || "(clean or not a git repository)",
        "",
        "Tracked files:",
        files.output || "(none)"
      ].join("\n")
    };
  }

  private async searchWorkspace(query: string): Promise<ToolResult> {
    if (!query.trim()) {
      return { ok: false, output: "query is required." };
    }

    return this.exec("rg", [
      "--line-number",
      "--hidden",
      "--glob",
      "!.git",
      "--glob",
      "!node_modules",
      "--glob",
      "!dist",
      query,
      "."
    ]);
  }

  private async readWorkspaceFile(relativePath: string): Promise<ToolResult> {
    const safePath = this.resolveInsideWorkspace(relativePath);
    await access(safePath);
    const content = await readFile(safePath);

    if (content.byteLength > MAX_FILE_BYTES) {
      return {
        ok: false,
        output: `File is too large (${content.byteLength} bytes). Narrow the request first.`
      };
    }

    return {
      ok: true,
      output: content.toString("utf8")
    };
  }

  private async gitDiff(): Promise<ToolResult> {
    return this.exec("git", ["diff", "--", "."]);
  }

  private async runTests(): Promise<ToolResult> {
    const command = process.env.TEST_COMMAND?.trim() || "npm test";
    const [bin, ...args] = splitCommand(command);

    if (!bin) {
      return { ok: false, output: "TEST_COMMAND is empty." };
    }

    return this.exec(bin, args);
  }

  private proposePatch(diff: string): ToolResult {
    if (!diff.trim()) {
      return { ok: false, output: "diff is required." };
    }

    this.pendingPatch = {
      id: randomUUID(),
      diff,
      createdAt: new Date().toISOString()
    };

    return {
      ok: true,
      output: `Patch staged for human approval: ${this.pendingPatch.id}`,
      metadata: { pendingPatch: this.pendingPatch }
    };
  }

  private resolveInsideWorkspace(relativePath: string) {
    const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const fullPath = path.resolve(this.workspaceRoot, normalized);

    if (!fullPath.startsWith(this.workspaceRoot + path.sep) && fullPath !== this.workspaceRoot) {
      throw new Error("Path escapes WORKSPACE_ROOT.");
    }

    return fullPath;
  }

  private async exec(
    file: string,
    args: string[],
    options: { input?: string } = {}
  ): Promise<ToolResult> {
    try {
      const { stdout, stderr } = options.input
        ? await execFileWithInput(file, args, this.workspaceRoot, options.input)
        : await execFileAsync(file, args, {
            cwd: this.workspaceRoot,
            timeout: 30_000,
            maxBuffer: MAX_OUTPUT * 2
          });

      return {
        ok: true,
        output: trimOutput([stdout, stderr].filter(Boolean).join("\n"))
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      return {
        ok: false,
        output: trimOutput([err.stdout, err.stderr, err.message].filter(Boolean).join("\n"))
      };
    }
  }
}

function trimOutput(value: string) {
  if (value.length <= MAX_OUTPUT) {
    return value.trim();
  }

  return `${value.slice(0, MAX_OUTPUT)}\n\n[output truncated at ${MAX_OUTPUT} chars]`;
}

function splitCommand(command: string) {
  return command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function execFileWithInput(
  file: string,
  args: string[],
  cwd: string,
  input: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Command timed out after 30000ms."));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Command exited with code ${code}`) as Error & {
        stdout: string;
        stderr: string;
      };
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    child.stdin.end(input);
  });
}
