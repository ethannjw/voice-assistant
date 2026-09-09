# Layered testing and incident reproduction

Use this procedure when Elva misses a follow-up, stops with an offer to continue, or reports generic web results. The reusable agent skill is `.claude/skills/voice-pair-programmer-diagnostics/SKILL.md`, with discovery aliases under `.agents/skills/` and `.codex/skills/`.

## 1. Capture the actual failure

Record the exact user request, generated tool query, source URLs, tool output, assistant response, and protocol errors. For relative dates, record the local date and timezone. Separate these failure modes before editing prompts:

| Symptom | Boundary to inspect |
| --- | --- |
| No response to an invitation or nameless follow-up | Speech-start/commit events, attention classification, idle eligibility |
| Tool result rejected or never followed by a reply | Call/item IDs, output acknowledgement, reply-chain validity |
| Search returns links but no requested values | Provider request, scraped page content, parser and output limits |
| Elva says she could do more and waits | Available tools and task-completion policy, not necessarily attention |

Check the current branch and worktree. Use graph discovery and coverage checks, then current source for stale/unindexed files. Keep the development app running; the deterministic app uses port 38787 and HMR port 38788, separate from normal development.

## 2. Deterministic regression loop

Write a focused regression that fails for the observed behavior, verify the failure, implement the fix, and rerun it before the full gate:

```bash
npm run test:e2e -- e2e/tools.spec.ts
npm run test:e2e -- e2e/web-search.spec.ts
npm run test:e2e -- e2e/attention.spec.ts e2e/attention-controller.spec.ts
npm run test:cursor
npm test
git diff --check
```

`npm test` runs application and E2E typechecks, the production build, and all deterministic Playwright tests. Run E2E commands sequentially because they share disposable `.e2e/` state and ports. No paid APIs, real coding workspaces, or live Firecrawl are required.

Tests should assert user-visible data and side effects. A useful search fixture has a generic description and numerical values only in Markdown: disabling scraping or dropping Markdown must fail the test. Add partial failures, empty results, upstream errors, bounded output, and cancellation where applicable. A continuation fixture should require another lookup without another user message. Browser fakes alone cannot establish whether the real model chooses that lookup.

Inspect retained failures in `test-results/` and `playwright-report/`; open a trace with `npx playwright show-trace <trace.zip>`. These directories and `.e2e/` are ignored and must not be committed.

## 3. Opt-in live Firecrawl comparison

This sends public queries and page requests through the configured provider. Obtain permission before live diagnostics; do not print `.env`, authorization headers, or full container environments. Verify the actual local app and Firecrawl addresses rather than assuming defaults.

With the default local services running, compare these three requests using the exact same query:

```bash
curl --connect-timeout 3 --max-time 75 -sS http://localhost:3002/v2/search \
  -H 'Content-Type: application/json' \
  --data '{"query":"Singapore weather forecast tomorrow high low temperature","limit":5,"sources":["web"],"timeout":60000}'

curl --connect-timeout 3 --max-time 75 -sS http://localhost:3002/v2/search \
  -H 'Content-Type: application/json' \
  --data '{"query":"Singapore weather forecast tomorrow high low temperature","limit":5,"sources":["web"],"timeout":60000,"scrapeOptions":{"formats":["markdown"],"onlyMainContent":true}}'

curl --connect-timeout 3 --max-time 75 -sS http://127.0.0.1:8787/api/tools/web_search \
  -H 'Content-Type: application/json' \
  --data '{"query":"Singapore weather forecast tomorrow high low temperature"}'
```

Compare `data.web[].description`, `markdown`, per-page metadata/status, and the app's `output`/`metadata`. Check that values, units, and the requested date survive formatting. Do not confuse current conditions, historical averages, or different providers' forecasts with the requested daily high/low. Never hard-code a live forecast into a deterministic assertion.

A provider can return HTTP 200 while individual pages fail. If snippets lack values but Markdown has them, query wording is not the main failure; inspect whether the app requests and preserves that content. If Markdown also lacks data, inspect page errors, blocked content, dates, and alternative sources before blaming the model.

The September 8, 2026 investigation reproduced snippet-only output from the app. Enabling Markdown retrieval in a direct Firecrawl call produced numerical data from four results and a failure on one. A separate parser probe confirmed that the app discarded Markdown even when supplied. These are incident observations, not guarantees of future site availability.

## 4. Opt-in live Realtime checks

Use the configured model; do not silently substitute another provider or model. With the development app running:

```bash
npm run test:attention:live
npm run test:attention:live -- --tool-cycle
```

These commands use real Realtime API credits and a silent synthetic microphone. The first checks text-based attention decisions; the second checks actual conversation storage, tool-result acceptance, spoken fixture output, and nameless follow-ups. The clock-boundary case is simulated. Neither command tests live web retrieval or acoustic wake-word recognition.

For a search-policy change, also evaluate the production prompt against insufficient tool results, without forcing a second tool call or scripting the final answer. Require an automatic bounded refinement, an answer grounded in the supplied values, and no request to say “continue.” Test unavailable data separately: Elva should stop honestly rather than loop or invent a forecast.

The implemented search-policy checks are:

```bash
npm run test:search:live
npm run test:search:live -- --case content
npm run test:search:live -- --case unavailable
npm run test:search:live -- --live-search
```

Run these sequentially. Each invocation opens a fresh session to prevent earlier fixture answers leaking into the unavailable-data case. The first three use a local ephemeral Firecrawl fixture server but the production `runWebSearch` parser, tool schema, instructions, and attention controller. Only `web_search` is exposed; coding tasks cannot execute. Tool selection remains automatic, and no final answer is inserted into the instructions. Default mode returns generic snippets first and page-only values after a distinct refinement. Content mode requires one lookup; unavailable mode requires three bounded attempts and a specific limitation without fabricated temperatures.

The final mode instead executes the app's real `/api/tools/web_search` route against its configured Firecrawl. It checks that scraped content reaches the model and that the final reply includes high/low values and Celsius units. This is a live smoke check, not an independent meteorological truth oracle: inspect source/date/unit alignment and provider differences separately. A provider outage should fail this check, not be silently converted to a passing fixture result.

The app now requests fresh Markdown and includes per-source `contentStatus`, `statusCode` when available, `truncated`, and a retrieval timestamp. Query-matched excerpts limit large pages to 12,000 characters per source. Snippet-only or failed pages remain explicitly labeled so the model can refine rather than confuse a successful search with an answered question. The controller, not just the prompt, limits web searches to three per accepted request.

## 5. Real-audio acceptance and handoff

Follow `docs/testing/conversation-attention.md` for microphone checks. Make participants aware of audio transmission. Do not infer Zoom/Teams routing support from browser microphone tests.

Report the exact commands and fresh outcomes, which layers were real or simulated, failures still open, and checks not run. Before a requested commit, inspect the staged diff for unrelated work, credentials, fixtures outside disposable storage, or generated reports. Never present a deterministic pass as proof of real-provider retrieval quality or human-call behavior.
