# Playwright E2E Test Harness Implementation Plan

> **For agentic workers:** Implement this plan task-by-task without committing or pushing. Preserve existing uncommitted documentation changes.

**Goal:** Add deterministic Playwright end-to-end coverage for the browser application and every registered server tool before further feature work.

**Architecture:** Run the real Express/Vite application and a real Chromium browser. Isolate external dependencies with a fake Codex app-server executable, a local Firecrawl stub, browser-level WebRTC/media fakes, and a disposable Git workspace under `.e2e/`.

**Tech Stack:** Playwright Test, Chromium, TypeScript, Express, Node.js child processes.

**Spec:** Approved conversation design from September 7, 2026.

## Global Constraints

- Do not call live OpenAI, Codex, or Firecrawl services in the default E2E suite.
- Do not touch a real project workspace; use only `.e2e/workspace`.
- Cover `workspace_status`, `search_workspace`, `read_file`, `git_diff`, `run_tests`, `propose_patch`, `codex_task`, and `web_search`.
- Keep the canonical reusable skill under `.claude/skills` and link it into Cursor and Codex discovery folders.
- Do not commit or push.

---

### Task 1: Test Runtime and Fixtures

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.ts`
- Create: `e2e/support/firecrawl-stub.ts`
- Create: `e2e/fixtures/fake-codex`
- Create: `e2e/fixtures/tool-test-command.cjs`
- Modify: `.gitignore`

- [ ] Add Playwright dependency and npm scripts.
- [ ] Configure the app and Firecrawl web servers.
- [ ] Create deterministic external-service fixtures.

### Task 2: Browser and Realtime Coverage

**Files:**
- Create: `e2e/app.spec.ts`
- Create: `e2e/realtime.spec.ts`
- Create: `e2e/support/realtime-browser.ts`

- [ ] Verify the application loads in Chromium.
- [ ] Verify microphone errors are shown.
- [ ] Verify connection state and the ordered Elva greeting event.
- [ ] Verify disconnected text rendering with an intercepted response.

### Task 3: Tool Coverage

**Files:**
- Create: `e2e/tools.spec.ts`
- Create: `e2e/support/workspace.ts`

- [ ] Create and register an isolated Git workspace.
- [ ] Exercise every workspace tool through HTTP.
- [ ] Exercise `codex_task` through the fake app-server process.
- [ ] Exercise `web_search` through the local Firecrawl stub.

### Task 4: Shared Harness Skill and Documentation

**Files:**
- Create: `.claude/skills/voice-pair-programmer-e2e/SKILL.md`
- Create symlink: `.cursor/skills/voice-pair-programmer-e2e`
- Create symlink: `.codex/skills/voice-pair-programmer-e2e`
- Create symlink: `.agents/skills/voice-pair-programmer-e2e`
- Modify: `README.md`
- Modify: `/Users/nge1/myapps/set-mac-up/setup.sh`

- [ ] Document the deterministic E2E workflow and artifact locations.
- [ ] Validate the skill and all symlink targets.
- [ ] Add Playwright browser setup to the machine bootstrap script.

### Task 5: Verification

- [ ] Run `npm run test:e2e:install`.
- [ ] Run `npm run test:e2e`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
