import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { createCodingAgent, type CodingAgent } from "../src/server/codingAgent";
import { CursorAgent } from "../src/server/cursor";
import { e2eRoot, fakeCodexBinDirectory, fakeCursorAgentPath, repositoryRoot } from "./support/paths";

const execFileAsync = promisify(execFile);

for (const provider of ["cursor", "codex"] as const) {
  test.describe(`${provider} provider contract`, () => {
    let agent: CodingAgent;
    let workspace: string;
    let logPath: string;
    let previousEnv: NodeJS.ProcessEnv;

    test.beforeEach(async () => {
      previousEnv = { ...process.env };
      workspace = path.join(e2eRoot, "contracts", randomUUID());
      await mkdir(workspace, { recursive: true });
      logPath = path.join(workspace, "protocol.jsonl");
      await writeFile(logPath, "");
      process.env.E2E_AGENT_LOG = logPath;
      process.env.PATH = `${fakeCodexBinDirectory}${path.delimiter}${process.env.PATH}`;
      agent = createCodingAgent({ provider, cursorCommand: fakeCursorAgentPath });
    });

    test.afterEach(async () => {
      await agent?.dispose();
      for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
    });

    async function messages() {
      return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }

    test("keeps overlapping task responses separate", async () => {
      const results = await Promise.all([
        agent.runTextTurn(workspace, "FIRST_TASK"),
        agent.runTextTurn(workspace, "SECOND_TASK")
      ]);
      expect(results[0].text).toContain("FIRST_TASK");
      expect(results[0].text).not.toContain("SECOND_TASK");
      expect(results[1].text).toContain("SECOND_TASK");
      expect(results[1].text).not.toContain("FIRST_TASK");
    });

    test("disposal rejects queued tasks without spawning another process", async () => {
      const active = agent.runTextTurn(workspace, "needs approval").catch((error: Error) => error);
      await expect.poll(() => agent.listPendingApprovals().length).toBe(1);
      const queued = agent.runTextTurn(workspace, "MUST_NOT_RUN_AFTER_DISPOSE").catch((error: Error) => error);
      await agent.dispose();
      expect(await active).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
      await expect(agent.runTextTurn(workspace, "AFTER_DISPOSE")).rejects.toThrow();
      expect((await messages()).filter((message) => message.method === "initialize")).toHaveLength(1);
    });

    test("never starts a cancelled task after session initialization", async () => {
      const gate = path.join(workspace, "release-session");
      process.env.E2E_AGENT_GATE = gate;
      const controller = new AbortController();
      const result = agent.runTextTurn(workspace, "CANCELLED_TASK", controller.signal).catch((error: Error) => error);
      await expect.poll(async () => (await messages()).some((message) =>
        message.method === (provider === "cursor" ? "session/new" : "thread/start")
      )).toBe(true);
      controller.abort();
      await writeFile(gate, "release");
      expect(await result).toMatchObject({ name: "AbortError" });
      await agent.runTextTurn(workspace, "FOLLOWUP_TASK");
      const started = (await messages()).filter((message) =>
        message.method === (provider === "cursor" ? "session/prompt" : "turn/start")
      );
      expect(started).toHaveLength(1);
      expect(JSON.stringify(started[0])).toContain("FOLLOWUP_TASK");
    });

    test("fails promptly after process death and recovers on the next task", async () => {
      test.setTimeout(5000);
      await expect(agent.runTextTurn(workspace, "e2e:crash")).rejects.toThrow();
      const result = await agent.runTextTurn(workspace, "RECOVERED_TASK");
      expect(result.text).toContain("RECOVERED_TASK");
    });

    test("a failed turn does not poison the next task", async () => {
      await expect(agent.runTextTurn(workspace, "e2e:fail")).rejects.toThrow("E2E turn failed");
      expect((await agent.runTextTurn(workspace, "RECOVERED_TASK")).text).toContain("RECOVERED_TASK");
    });

    for (const decision of ["accept", "decline"] as const) {
      test(`${decision} controls the actual file side effect`, async () => {
        const result = agent.runTextTurn(workspace, "e2e:edit");
        await expect.poll(() => agent.listPendingApprovals().length).toBe(1);
        await expect(readFile(path.join(workspace, "agent-result.txt"))).rejects.toThrow();
        const [approval] = agent.listPendingApprovals();
        expect(agent.resolveApproval(approval.id, decision)).toBe(true);
        await result;
        expect(agent.listPendingApprovals()).toHaveLength(0);
        expect(agent.resolveApproval(approval.id, decision)).toBe(false);
        if (decision === "accept") {
          expect(await readFile(path.join(workspace, "agent-result.txt"), "utf8")).toBe(`implemented by ${provider}\n`);
        } else {
          await expect(readFile(path.join(workspace, "agent-result.txt"))).rejects.toThrow();
        }
      });
    }

    test("cancelling an approval leaves no stale permission or file change", async () => {
      const controller = new AbortController();
      const result = agent.runTextTurn(workspace, "e2e:edit", controller.signal).catch((error: Error) => error);
      await expect.poll(() => agent.listPendingApprovals().length).toBe(1);
      const [approval] = agent.listPendingApprovals();
      controller.abort();
      expect(await result).toMatchObject({ name: "AbortError" });
      await expect.poll(() => agent.listPendingApprovals().length).toBe(0);
      expect(agent.resolveApproval(approval.id, "accept")).toBe(false);
      await expect(readFile(path.join(workspace, "agent-result.txt"))).rejects.toThrow();
    });

    if (provider === "cursor") {
      for (const grouped of [false, true]) {
        test(`resolves a bare model name to its advertised variant with ${grouped ? "grouped" : "flat"} options`, async () => {
          if (grouped) process.env.E2E_CURSOR_GROUP_MODELS = "1";
          await agent.dispose();
          agent = new CursorAgent({ command: fakeCursorAgentPath, model: "composer-2.5" });
          const result = await agent.runTextTurn(workspace, "MODEL_VARIANT_TASK");
          expect(result.text).toContain("Fake Cursor (composer-2.5[fast=true],");
        });
      }

      test("requires an exact model value when a bare name has multiple variants", async () => {
        await agent.dispose();
        agent = new CursorAgent({ command: fakeCursorAgentPath, model: "ambiguous-model" });
        await expect(agent.runTextTurn(workspace, "AMBIGUOUS_MODEL")).rejects.toThrow(/multiple.*exact/i);
        expect((await messages()).some((message) => message.method === "session/prompt")).toBe(false);
      });

      test("preserves an explicitly selected model variant", async () => {
        await agent.dispose();
        agent = new CursorAgent({ command: fakeCursorAgentPath, model: "ambiguous-model[fast=false]" });
        expect((await agent.runTextTurn(workspace, "EXACT_MODEL")).text).toContain("Fake Cursor (ambiguous-model[fast=false],");
      });

      test("a cancelled queued task never reaches Cursor", async () => {
        const first = agent.runTextTurn(workspace, "needs approval");
        await expect.poll(() => agent.listPendingApprovals().length).toBe(1);
        const controller = new AbortController();
        const queued = agent.runTextTurn(workspace, "MUST_NOT_RUN", controller.signal).catch((error: Error) => error);
        controller.abort();
        expect(await queued).toMatchObject({ name: "AbortError" });
        agent.resolveApproval(agent.listPendingApprovals()[0].id, "decline");
        await first;
        await agent.runTextTurn(workspace, "AFTER_CANCEL");
        expect(JSON.stringify(await messages())).not.toContain("MUST_NOT_RUN");
      });

      test("an unsupported configured model fails instead of silently using another model", async () => {
        await agent.dispose();
        agent = new CursorAgent({ command: fakeCursorAgentPath, model: "unavailable-model" });
        await expect(agent.runTextTurn(workspace, "MODEL_TASK")).rejects.toThrow("Unsupported model configuration");
        expect((await messages()).some((message) => message.method === "session/prompt")).toBe(false);
      });

      test("a stalled Cursor session times out and the next task can recover", async () => {
        test.setTimeout(5000);
        process.env.E2E_AGENT_GATE = path.join(workspace, "never-released");
        await agent.dispose();
        agent = createCodingAgent({ provider: "cursor", cursorCommand: fakeCursorAgentPath, cursorRequestTimeoutMs: 400 });
        await expect(agent.runTextTurn(workspace, "STALLED_TASK")).rejects.toThrow(/timed out.*session/i);
        delete process.env.E2E_AGENT_GATE;
        expect((await agent.runTextTurn(workspace, "RECOVERED_TASK")).text).toContain("RECOVERED_TASK");
      });

      test("a stalled Cursor prompt times out and releases the workspace queue", async () => {
        test.setTimeout(5000);
        await agent.dispose();
        agent = createCodingAgent({ provider: "cursor", cursorCommand: fakeCursorAgentPath, cursorTurnTimeoutMs: 400 });
        await expect(agent.runTextTurn(workspace, "wait for cancellation")).rejects.toThrow(/timed out.*turn/i);
        expect((await agent.runTextTurn(workspace, "AFTER_TIMEOUT")).text).toContain("AFTER_TIMEOUT");
      });

      test("does not turn one-time approval into persistent permission", async () => {
        const result = agent.runTextTurn(workspace, "needs approval persistent-only");
        await expect.poll(() => agent.listPendingApprovals().length).toBe(1);
        const [approval] = agent.listPendingApprovals();
        expect(approval.availableDecisions).toEqual(["acceptForSession", "decline"]);
        expect(agent.resolveApproval(approval.id, "accept")).toBe(false);
        expect(agent.listPendingApprovals()).toHaveLength(1);
        expect(agent.resolveApproval(approval.id, "decline")).toBe(true);
        await result;
      });
    }

    if (provider === "codex") {
      test("a broken stdin pipe terminates the old process", async () => {
        const controller = new AbortController();
        const result = agent.runTextTurn(workspace, "e2e:close-stdin", controller.signal).catch((error: Error) => error);
        await expect.poll(async () => (await messages()).some((message) => message.event === "stdin-closed")).toBe(true);
        const started = (await messages()).find((message) => message.event === "process-start");
        const pid = started.pid as number;
        try {
          controller.abort();
          expect(await result).toBeInstanceOf(Error);
          await expect.poll(() => {
            try { process.kill(pid, 0); return true; }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
              throw error;
            }
          }, { timeout: 2000 }).toBe(false);
          await agent.dispose();
        } finally {
          try { process.kill(pid, "SIGTERM"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      });
    }
  });
}

test("missing Codex is a handled error, not a process crash", async () => {
  const result = await execFileAsync(process.execPath, ["--import", "tsx", "e2e/fixtures/missing-codex.ts"], {
    cwd: repositoryRoot, timeout: 5000
  });
  expect(result.stdout).toContain("Handled startup failure");
  expect(result.stderr).not.toContain("Unhandled");
});

test("Cursor timeout configuration reaches the application environment", async () => {
  const result = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    'import { env } from "./src/server/env.ts"; console.log(JSON.stringify([env.cursorRequestTimeoutMs, env.cursorTurnTimeoutMs]));'
  ], { cwd: repositoryRoot, env: { ...process.env, CURSOR_REQUEST_TIMEOUT_MS: "15000", CURSOR_TURN_TIMEOUT_MS: "1800000" } });
  expect(JSON.parse(result.stdout.trim())).toEqual([15000, 1800000]);
});

test("invalid Cursor timeout configuration fails on startup", async () => {
  await expect(execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    'await import("./src/server/env.ts");'
  ], { cwd: repositoryRoot, env: { ...process.env, CURSOR_TURN_TIMEOUT_MS: "not-a-duration" } })).rejects.toThrow("CURSOR_TURN_TIMEOUT_MS");
});
