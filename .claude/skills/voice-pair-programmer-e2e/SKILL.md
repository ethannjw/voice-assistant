---
name: voice-pair-programmer-e2e
description: Run, extend, and debug the Voice Pair Programmer Playwright E2E suite when changing browser UI, Realtime connection behavior, project handling, Codex delegation, Firecrawl search, or workspace tools.
---

# Voice Pair Programmer E2E

Use the repository's deterministic Playwright suite before and after changing user-visible behavior or any registered tool.

## Commands

| Task | Command |
| --- | --- |
| Install the pinned Chromium build | `npm run test:e2e:install` |
| Run all E2E tests | `npm run test:e2e` |
| Run in a visible browser | `npm run test:e2e:headed` |
| Open Playwright UI mode | `npm run test:e2e:ui` |
| Debug interactively | `npm run test:e2e:debug` |
| Type-check E2E files | `npm run test:e2e:typecheck` |

The default suite launches the real Express/Vite application and a real Chromium browser. It uses only `.e2e/` as a disposable workspace and replaces external dependencies with a fake Codex app-server executable, a local Firecrawl stub, and browser-level microphone/WebRTC fakes.

Do not use live API keys, a real repository, or paid external services for the default E2E run.

## Adding Or Changing A Tool

1. Add or update a focused test in `e2e/tools.spec.ts` for the tool's successful response.
2. Include required arguments and verify meaningful output and metadata, not only the HTTP status.
3. Use `e2e/support/prepare.ts` for disposable workspace state.
4. Add a deterministic local stub when the tool depends on an external service.
5. Run the focused spec, then `npm run test:e2e`.

The suite must retain coverage for:

- `workspace_status`
- `search_workspace`
- `read_file`
- `git_diff`
- `run_tests`
- `propose_patch`
- `codex_task`
- `web_search`

## Failure Artifacts

Inspect `test-results/` for retained traces, screenshots, and videos. Open an individual trace with `npx playwright show-trace <trace.zip>`. The HTML report is generated under `playwright-report/`.

Never commit `.e2e/`, `test-results/`, or `playwright-report/`.
