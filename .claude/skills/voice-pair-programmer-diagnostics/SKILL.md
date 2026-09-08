---
name: voice-pair-programmer-diagnostics
description: Diagnose and verify Voice Pair Programmer conversation continuation, attention gating, and web retrieval quality using deterministic regressions and opt-in live checks. Use when Elva stops early, requires repeated invitations, or returns generic search answers.
---

# Voice Pair Programmer Diagnostics

Follow the layered procedure in `docs/testing/diagnostics.md`. Use `docs/testing/conversation-attention.md` for audio acceptance and the existing `voice-pair-programmer-e2e` skill for ordinary browser/tool tests.

## Establish the failure boundary

1. Record the exact invitation, search query, expected facts, actual response, and any error. Distinguish ignored speech, rejected tool output, missing source data, and a completed response that offers to continue.
2. Check the current branch and dirty files. Prefer graph discovery, check coverage/freshness, and verify stale or unindexed evidence against current source. Preserve unrelated work and the user's running app.
3. Trace the actual payload across provider, server parser, tool output, and Realtime continuation. HTTP 200 or a nonempty string does not mean the user's question was answered.

## Reproduce and regress

- Start with a focused failing test at the affected boundary; then fix it and run `npm test`.
- Keep the default suite offline: disposable `.e2e/` workspaces, strict protocol fakes, and local Firecrawl fixtures. Do not add live credentials or services to default tests.
- For search, put the needed values only in page Markdown, not the snippet. Include partial scrape failure, missing content, truncation, incorrect dates/units, and bounded follow-through when relevant. Assert what the real parser and app deliver, not just fixture configuration.
- For continuation, preserve the actual controller and tool-result acknowledgement. Mocked `response.done` events prove orchestration only; they do not prove the model chooses a second lookup instead of asking permission.
- After permission for live services, compare the exact query through local Firecrawl and the app. Change one retrieval option at a time. Use public, non-sensitive queries and inspect source/date/unit evidence without dumping secrets or entire pages.
- Run `npm run test:attention:live` and `npm run test:attention:live -- --tool-cycle` when changing attention/protocol behavior. They use real API credits but synthetic inputs. They do not test real Firecrawl or acoustic recognition.
- Evaluate changed conversational policy against the configured live model without forcing the desired tool choice or replacing the production prompt. Use bounded fixture tools for reproducibility, followed by a separate real-retrieval smoke check.

## Report evidence honestly

Report the command, result, real versus simulated layers, and remaining gaps. Keep real microphone/call acceptance distinct from synthetic text and speech-start events. Record failures as well as successes; do not label canned forecasts as live weather evidence. Never claim a commit, full-suite pass, or live-service success without fresh verification.

Keep `.env`, credentials, call audio, `.e2e/`, traces, reports, and temporary response dumps out of commits. Commit or push only when requested. No tool installation is needed for this workflow when the project's existing dependencies are available.
