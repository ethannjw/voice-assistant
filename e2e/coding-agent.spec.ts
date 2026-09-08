import path from "node:path";
import { access, rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  createCodingAgent,
  parseCodingAgentName,
  type CodingAgent
} from "../src/server/codingAgent";
import { CursorAgent } from "../src/server/cursor";
import { isExplicitCodingInterruptionRequest } from "../src/client/lib/intent";
import {
  cursorPromptMarkerPath,
  cursorSessionMarkerPath,
  e2eRoot,
  e2eWorkspace,
  fakeCodexBinDirectory,
  fakeCursorAgentPath
} from "./support/paths";
import { selectE2eWorkspace } from "./support/workspace";

const agents: CodingAgent[] = [];

test.afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  delete process.env.E2E_CURSOR_PROMPT_MARKER;
  delete process.env.E2E_CURSOR_BLOCK_SESSION;
  delete process.env.E2E_CURSOR_SESSION_MARKER;
  await rm(cursorPromptMarkerPath, { force: true });
  await rm(cursorSessionMarkerPath, { force: true });
});

test("defaults the coding provider to Cursor and validates explicit choices", () => {
  expect(parseCodingAgentName(undefined)).toBe("cursor");
  expect(parseCodingAgentName("")).toBe("cursor");
  expect(parseCodingAgentName("cursor")).toBe("cursor");
  expect(parseCodingAgentName("codex")).toBe("codex");
  expect(() => parseCodingAgentName("other")).toThrow("CODING_AGENT must be cursor or codex");
});

test("recognizes explicit interruption requests for Cursor coding tasks", () => {
  expect(isExplicitCodingInterruptionRequest("Elva, stop the Cursor task")).toBe(true);
  expect(isExplicitCodingInterruptionRequest("Elva, keep the Cursor task running")).toBe(false);
});

test("creates the selected provider without starting the unselected process", async () => {
  const cursor = createCodingAgent({
    provider: "cursor",
    cursorCommand: fakeCursorAgentPath,
    cursorModel: "cursor-e2e-model",
    noProjectWorkspace: path.join(e2eRoot, "no-project")
  });
  agents.push(cursor);
  expect(cursor.name).toBe("cursor");

  const codex = createCodingAgent({ provider: "codex" });
  agents.push(codex);
  expect(codex.name).toBe("codex");
});

test("keeps the Codex provider operational when selected", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = [fakeCodexBinDirectory, previousPath].filter(Boolean).join(path.delimiter);
  try {
    const codex = createCodingAgent({ provider: "codex" });
    agents.push(codex);
    const result = await codex.runTextTurn(e2eWorkspace, "codex compatibility task");
    expect(result.text).toContain("Fake Codex completed: codex compatibility task");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("runs Cursor ACP turns, applies the configured model, and reuses workspace sessions", async () => {
  const cursor = new CursorAgent({
    command: fakeCursorAgentPath,
    model: "cursor-e2e-model",
    noProjectWorkspace: path.join(e2eRoot, "no-project")
  });
  agents.push(cursor);

  const first = await cursor.runTextTurn(e2eWorkspace, "first task");
  const second = await cursor.runTextTurn(e2eWorkspace, "second task");

  expect(first.text).toContain("Fake Cursor (cursor-e2e-model, cursor-e2e-session-1)");
  expect(second.text).toContain("Fake Cursor (cursor-e2e-model, cursor-e2e-session-1)");
  expect(first.threadId).toBe("cursor-e2e-session-1");
  expect(first.status).toBe("end_turn");
});

test("creates a separate Cursor session for a different workspace", async () => {
  const cursor = new CursorAgent({ command: fakeCursorAgentPath });
  agents.push(cursor);

  const projectTurn = await cursor.runTextTurn(e2eWorkspace, "project task");
  const scratchTurn = await cursor.runTextTurn(path.join(e2eRoot, "no-project"), "scratch task");

  expect(projectTurn.threadId).toBe("cursor-e2e-session-1");
  expect(scratchTurn.threadId).toBe("cursor-e2e-session-2");
});

test("maps Cursor permission requests onto the existing approval decisions", async () => {
  const cursor = new CursorAgent({ command: fakeCursorAgentPath });
  agents.push(cursor);

  const turn = cursor.runTextTurn(e2eWorkspace, "task needs approval");
  await expect.poll(() => cursor.listPendingApprovals().length).toBe(1);

  const [approval] = cursor.listPendingApprovals();
  expect(approval).toMatchObject({
    kind: "cursor_tool",
    title: "Run npm test",
    command: "npm test",
    availableDecisions: ["accept", "acceptForSession", "decline"]
  });
  expect(cursor.resolveApproval(approval.id, "acceptForSession")).toBe(true);

  await expect(turn).resolves.toMatchObject({
    text: expect.stringContaining("permission=allow-session"),
    status: "end_turn"
  });
});

test("cancels the active Cursor prompt through ACP", async () => {
  process.env.E2E_CURSOR_PROMPT_MARKER = cursorPromptMarkerPath;
  const cursor = new CursorAgent({ command: fakeCursorAgentPath });
  agents.push(cursor);
  const controller = new AbortController();

  const turn = cursor.runTextTurn(e2eWorkspace, "wait for cancellation", controller.signal);
  await expect
    .poll(async () => {
      try {
        await access(cursorPromptMarkerPath);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  controller.abort();

  await expect(turn).rejects.toMatchObject({ name: "AbortError" });
});

test("does not start a Cursor prompt after cancellation during session creation", async () => {
  process.env.E2E_CURSOR_PROMPT_MARKER = cursorPromptMarkerPath;
  process.env.E2E_CURSOR_SESSION_MARKER = cursorSessionMarkerPath;
  process.env.E2E_CURSOR_BLOCK_SESSION = "1";
  const cursor = new CursorAgent({ command: fakeCursorAgentPath });
  agents.push(cursor);
  const controller = new AbortController();

  const turn = cursor.runTextTurn(e2eWorkspace, "cancel during session creation", controller.signal);
  await expect
    .poll(async () => {
      try {
        await access(cursorSessionMarkerPath);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  controller.abort();

  await expect(turn).rejects.toMatchObject({ name: "AbortError" });
  await expect(access(cursorPromptMarkerPath)).rejects.toThrow();
});

test("reports an actionable error when the Cursor executable is missing", async () => {
  const cursor = new CursorAgent({ command: path.join(e2eRoot, "missing-cursor-agent") });
  agents.push(cursor);

  await expect(cursor.runTextTurn(e2eWorkspace, "task")).rejects.toThrow(
    /Cursor Agent.*not available|Could not start Cursor Agent/i
  );
});

test("reports Cursor as the configured default coding agent", async ({ request }) => {
  const response = await request.get("/api/config");
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    codingAgent: "cursor",
    codingModel: "cursor-e2e-model"
  });
});

test("routes coding_task through the configured Cursor agent", async ({ request }) => {
  await selectE2eWorkspace(request);
  const response = await request.post("/api/tools/coding_task", {
    data: { task: "implement through cursor" }
  });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    output: expect.stringContaining("Fake Cursor (cursor-e2e-model"),
    metadata: expect.objectContaining({ provider: "cursor", status: "end_turn" })
  });
});

test("surfaces and resolves Cursor permissions through generic approval routes", async ({ request }) => {
  await selectE2eWorkspace(request);
  const turn = request.post("/api/tools/coding_task", {
    data: { task: "task needs approval" }
  });

  await expect
    .poll(async () => {
      const response = await request.get("/api/coding-agent/approvals");
      const payload = (await response.json()) as { approvals: { id: string }[] };
      return payload.approvals.length;
    })
    .toBe(1);

  const approvalsResponse = await request.get("/api/coding-agent/approvals");
  const approvalsPayload = (await approvalsResponse.json()) as { approvals: { id: string }[] };
  const approvalId = approvalsPayload.approvals[0].id;
  const resolveResponse = await request.post(`/api/coding-agent/approvals/${approvalId}`, {
    data: { decision: "acceptForSession" }
  });
  expect(resolveResponse.status()).toBe(200);

  const response = await turn;
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    output: expect.stringContaining("permission=allow-session")
  });
});

test("routes generic coding-agent messages through the selected agent", async ({ request }) => {
  await selectE2eWorkspace(request);
  const response = await request.post("/api/coding-agent/message", {
    data: { text: "generic route task" }
  });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    text: expect.stringContaining("Fake Cursor (cursor-e2e-model")
  });
});

test("keeps the legacy Codex message route as a selected-agent alias", async ({ request }) => {
  await selectE2eWorkspace(request);
  const response = await request.post("/api/codex/message", {
    data: { text: "legacy route task" }
  });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    text: expect.stringContaining("Fake Cursor (cursor-e2e-model")
  });
});
