# Cursor Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute this plan task-by-task.

**Goal:** Add Cursor Agent as the default coding backend while retaining Codex as an environment-selectable alternative.

**Architecture:** Introduce a provider-neutral coding-agent contract used by routes and Realtime tools. Keep the existing Codex app-server implementation behind an adapter-compatible interface and add a persistent Cursor ACP client over stdio with the same turn, cancellation, streaming, and approval semantics.

**Tech Stack:** TypeScript, Express, Agent Client Protocol, Cursor Agent CLI, Codex app-server, Playwright.

**Spec:** Approved conversation requirements from September 7, 2026.

## Global Constraints

- Select the coding backend only through environment variables; no browser selector.
- Default `CODING_AGENT` to `cursor`.
- Keep `search_workspace` and `read_file` available for fast repository questions.
- Delegate implementation, commands, tests, Git operations, and complex investigation through `coding_task`.
- Never silently fall back between Cursor and Codex.
- Preserve the existing approval UI and abort behavior.
- Do not use live Cursor, Codex, OpenAI, or Firecrawl services in E2E tests.

---

### Task 1: Provider Contract and Environment Selection

**Files:**
- Create: `src/server/codingAgent.ts`
- Modify: `src/server/env.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/routes/index.ts`
- Test: `e2e/coding-agent.spec.ts`

- [x] Write failing tests for Cursor default, explicit Codex selection, invalid provider rejection, and provider-specific model selection.
- [x] Add the `CodingAgent` contract and factory.
- [x] Parse `CODING_AGENT`, `CURSOR_MODEL`, and `CURSOR_AGENT_COMMAND`.
- [x] Run focused tests and typecheck.

### Task 2: Cursor ACP Client

**Files:**
- Create: `src/server/cursor/index.ts`
- Create: `src/server/cursor/process.ts`
- Create: `src/server/cursor/types.ts`
- Create: `e2e/fixtures/bin/agent`
- Test: `e2e/coding-agent.spec.ts`

- [x] Write failing tests for initialization, session reuse, model configuration, streaming output, cancellation, and missing binary errors.
- [x] Spawn `<cursor command> acp` lazily and connect with the official ACP TypeScript SDK.
- [x] Maintain one ACP session per absolute workspace path.
- [x] Map session updates into the existing text-turn result.
- [x] Run focused tests and typecheck.

### Task 3: Generic Coding Tool and Approvals

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/server/routes/tools.ts`
- Modify: `src/server/routes/codex.ts`
- Modify: `src/server/realtime.ts`
- Modify: `src/client/hooks/useCodexApprovals.ts`
- Modify: `src/client/components/ApprovalPanel.tsx`
- Test: `e2e/coding-agent.spec.ts`
- Test: `e2e/realtime.spec.ts`
- Test: `e2e/tools.spec.ts`

- [x] Write failing tests for `coding_task`, generic approvals, Cursor permission decisions, and the legacy Codex route alias.
- [x] Route `coding_task` through the selected provider.
- [x] Keep `codex_task` as a compatibility alias.
- [x] Map ACP permission options to approve, session, and decline.
- [x] Update Realtime instructions to name the configured provider without letting the model choose it.
- [x] Run focused tests and typecheck.

### Task 4: Documentation and Verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `.claude/skills/voice-pair-programmer-e2e/SKILL.md`

- [x] Document Cursor installation/authentication, environment selection, models, and restart behavior.
- [x] Run `npm test`.
- [x] Run `npm run test:e2e:typecheck`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run `git diff --check`.
