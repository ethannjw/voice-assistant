# Conversation Attention Implementation Plan

> Execute inline with test-driven development and verification before completion. The user approved the conversational behavior and requested implementation after committing the existing changes.

**Goal:** Prevent unsolicited replies and actions while preserving natural follow-ups.

**Architecture:** A client-side conversation controller serializes silent Realtime attention checks, authorizes response/tool chains, and owns the inactivity window. The existing session hook retains transport and audio responsibilities. A compact UI indicator exposes the attention state.

**Tech Stack:** Existing TypeScript, React, OpenAI Realtime WebRTC, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-conversation-attention-design.md`

## Global Constraints

- Keep the configured Realtime model. No new dependencies or credentials.
- 30-second inactivity window; ambiguous and invalid decisions remain silent.
- No Zoom/Teams audio capture or output routing in this change.
- Default tests use synthetic events and fake coding agents, never paid services.
- Preserve the baseline commit `3f88d1c` on main. Leave new implementation changes uncommitted for review.

## Task 1: Attention controller and session contract

**Files:** `src/client/lib/conversationAttention.ts`, `src/client/types.ts`, `src/server/realtime.ts`, `src/server/prompts/elva.md`, `e2e/attention.spec.ts`.

**Interface:** `ConversationAttention` accepts callbacks for sending Realtime events, executing/cancelling tools, reporting state, and logging. It exposes `handleEvent`, `sendText`, `finishToolCall`, and `dispose`. Decisions use `action: direct | follow_up | ignore | dismiss` and `cancel_task: boolean`.

- [x] Add a regression expecting `audio.input.turn_detection.create_response` and `interrupt_response` to be false, and watch it fail against the baseline.
- [x] Add deterministic controller tests for admission, timeout/dismissal, correlation, and tool isolation.
- [x] Implement the controller with executable tools disabled for out-of-band checks, a forced private decision function, and strict argument parsing.
- [x] Disable automatic responses/interruption and replace the permissive attention prompt.
- [x] Run `npm run test:e2e -- e2e/attention.spec.ts` and verify the regression suite passes.

## Task 2: Browser and tool integration

**Files:** `src/client/hooks/useRealtimeSession.ts`, `src/client/hooks/useCodexToolExecution.ts`, `src/client/App.tsx`, `src/client/components/Topbar.tsx`, `e2e/support/realtime-browser.ts`, `e2e/realtime.spec.ts`, `e2e/cursor-browser.spec.ts`.

**Interface:** The session hook forwards correlated events and tool completions to the controller and exposes `attentionState`. Explicit disconnected tools remain unchanged; connected tool completions no longer generate arbitrary responses.

- [x] Add browser regressions for silent connect, ignored audio, invited audio, natural follow-ups, and idle expiry.
- [x] Integrate the controller and route all Realtime tool execution through authorized reply chains.
- [x] Make test responses carry the same metadata/request correlation as actual Realtime responses.
- [x] Expose a visible, accessible Waiting for Elva / In conversation indicator.
- [x] Run focused attention, Realtime, and Cursor browser specs.

## Task 3: Documentation and verification

**Files:** `README.md`, attention test/evaluation documentation.

- [x] Document the behavior, cost/latency implications, configuration boundaries, and lack of Zoom/Teams routing.
- [x] Document live checks using synthetic invitations, name mentions, side conversations, and related/unrelated follow-ups; do not describe mocked classifications as model-quality evidence.
- [x] Run `npm test` and `git diff --check`, inspect the final diff, and report limitations separately from verified behavior.

## Verification Results — 2026-09-08

- `npm test`: both TypeScript checks, the production build, and all 133 deterministic tests passed.
- `npm run test:attention:live`: 11/11 synthetic text cases passed against the configured Realtime model, including controller admission and cancellation checks.
- `npm run test:attention:live -- --tool-cycle`: reproduced the missing-tool-call error before the fix; now completes tool-result acknowledgement, a spoken fixture reply, and two consecutive name-free follow-ups, including a simulated idle-boundary crossing, without Realtime errors. This uses the real endpoint with synthetic input and a harmless fixture tool, not real microphone input or live Firecrawl/Cursor execution.
- Follow-up timing regressions reproduce expiry during speech/classification and verify speech-start eligibility, queued invitation/follow-up sequences, and invalidation after dismissal or replacement typed invitations. Background speech still cannot renew attention. Prompt-state assertions now match the exact state sentence.
- The browser fake now rejects unknown call/item IDs, and deterministic regressions cover default-conversation replies, result acknowledgement, rejected-result isolation, and a complete search-result continuation. The test server has a separate HMR port so verification does not require stopping the user's running app.
- Real microphone/acoustic accuracy and multi-person call acceptance remain unverified. Zoom/Teams routing is deferred.
- Baseline commit remains `3f88d1c` on main; attention implementation and follow-up fixes remain uncommitted on `feat/elva-conversation-attention` for review. Nothing pushed.
