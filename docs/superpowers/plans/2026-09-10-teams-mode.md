# Teams Mode Implementation Plan

> Implement sequentially with the executing-plans workflow. Use the existing user-selected `feat/meeting-participation` branch. Do not commit or create branches without a new request.

**Goal:** Support normal and Teams audio modes with the same Elva harness.

**Architecture:** Add a server-owned audio relay and packaged local Attendee runtime, while the existing UI retains attention gating, tool execution and approvals through a transport-neutral channel. CLI options configure startup mode and project selection; UI controls join/leave and shows live replies.

**Tech Stack:** Existing TypeScript/Express/React/Playwright, `ws`, Python standard library, Docker Compose, pinned Attendee.

**Spec:** `docs/superpowers/specs/2026-09-10-teams-mode-design.md`.

## Global constraints

No AWS, saved audio, automatic transcript persistence, public Python index fallback, hidden approval bypass, or temporary absolute source paths. Existing provider/model and normal mode remain unchanged. No subagents or new branches.

## Tasks

- [x] CLI and relay: failing tests in `e2e/meeting-unit.spec.ts`; implement `src/server/meeting/options.ts`, `audioRelay.ts` and `src/server/teams.ts`. Validate URLs without echoing secrets, workspace and port arguments, accepted-response PCM forwarding and per-item truncation.
- [x] Packaged runtime: add `integrations/attendee` controller, playback, cloud guard, TLS, Compose and runner. Use private per-session files and unique project names. Verify safety tests and Compose rendering; retain a reproducible pinned build path.
- [x] Session service: implement `src/server/meeting/manager.ts` and `runtime.ts`; authenticated single-owner control and bot sockets, provider/session readiness, failure propagation, watchdogs and cleanup. Register in `src/server/index.ts`; expose startup defaults through config.
- [x] Shared UI channel: make `useCodexToolExecution` transport-neutral; extend `useRealtimeSession` with Teams connection while retaining the same attention controller. Add mode/URL/status controls and keep the project/tool/approval/transcript panels shared.
- [x] Integration tests: deterministic browser Teams transport with no microphone, same tool calls and transcript UI, disconnect behavior and normal mode regression. Add manager transport tests using local fake sockets/runtime rather than real credentials or meetings.
- [x] Run focused tests, type checks, full existing suite and packaged runtime smoke as practical. Update README with startup, folder/project controls, transcript behavior, dependencies, permissions, known limitations and accurate verification results.

## Verification on September 10, 2026

- `npm test`: application/E2E type checks, production build, and all 177 tests passed. Initial normal-mode state regression from Strict Mode effect cleanup was reproduced and fixed without changing the original assertion.
- `npm run meeting:check`: eight container safety checks passed, including meeting controller imports, audio-only pipeline, readable TLS trust, and blocked AWS operations. Compose cleanup returned zero; no meeting projects remained.
- Python build-preparation test and compilation passed. `npm run teams -- --help` passed. Teams browser screenshot inspected for usable controls and shared approval panel.
- Reused the existing built image under `elva-attendee:31ebd91`; did not repeat the full upstream image build. The durable build script's transformations are unit tested.
- No real meeting joined during this integration pass. Integrated live Teams acceptance remains a separate next step with the user's meeting and admission. Prior standalone live results remain in the research notes.
- No commits, pushes, new branches, or host tool installations performed.
