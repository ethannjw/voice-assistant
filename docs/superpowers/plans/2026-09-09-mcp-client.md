# Configurable MCP Client Implementation Plan

> **For agentic workers:** Execute task-by-task with test-driven development and verification before completion. Work remains local; no commits or branches are requested.

**Goal:** Let users configure and use arbitrary standards-compatible MCP servers directly through Elva.

**Architecture:** An SDK-backed connection manager owns server configuration, transports, discovery, execution, and permission checks. A stable Realtime gateway and browser management panel consume this manager. Existing coding backends and GitHub commands are unchanged.

**Tech Stack:** TypeScript, Express, React, official MCP SDK, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-mcp-client.md`

## Global Constraints

- No service-specific integrations or GitHub CLI implementation.
- No automatic execution of repository-supplied MCP configurations.
- Owner-only credential/configuration files; no secrets in model-visible metadata.
- Explicit allow/ask/deny controls; no automatic mutation retries.
- No commits, branch switches, or tool installations.

## Tasks

- [x] Add failing deterministic MCP tests and an isolated configuration path in Playwright.
- [x] Implement shared contracts and validated atomic configuration persistence, including standard JSON import/export and environment references.
- [x] Add SDK clients, transport lifecycle, paginated capability discovery, permissions, cancellation, and OAuth credential persistence.
- [x] Mount guarded configuration/authentication/execution routes and stable Realtime MCP gateway functions.
- [x] Build the MCP management panel, capability browser, permission controls, and pending-request interaction UI.
- [x] Extend protocol, browser, authentication, and regression tests; run typechecks/build/full deterministic suite.
- [x] Document configuration format, transport/authentication support, trust boundaries, and unsupported optional capabilities.

## File boundaries

- `src/shared/mcp.ts`: serialized configuration/status/capability contracts.
- `src/server/mcp/config.ts`: validation, environment expansion, atomic persistence.
- `src/server/mcp/oauth.ts`: SDK OAuth provider and credential/state lifecycle.
- `src/server/mcp/manager.ts`: connections, discovery, policy and requests.
- `src/server/mcp/discovery.ts`: bounded protocol pagination and independent capability discovery.
- `src/server/mcp/transportFetch.ts`: request deadlines and resource-only credential injection.
- `src/server/mcp/gateway.ts`: Realtime tool definitions and dispatch.
- `src/server/routes/mcp.ts`: trusted local management and authentication routes.
- `src/client/components/McpPanel.tsx`: user configuration and interaction UI.
- `e2e/mcp*.spec.ts`, `e2e/fixtures/mcp-server.mjs`: deterministic protocol and UI coverage.

## Execution sequence

For each task, add the focused assertion first, observe its failure, implement the smallest working slice, and rerun it. Then run `npm run typecheck`, `npm run test:e2e:typecheck`, `npm run build`, and `npm run test:e2e`. Live third-party authentication requires a separately configured user server and is not part of deterministic verification.

## Verification result — September 9, 2026

- `npm test` passed: application/E2E typechecks, production build, and all 171 deterministic tests (25 MCP tests).
- Visually inspected the browser configuration panel screenshot and corrected checkbox sizing.
- Bounded independent review findings were fixed and re-reviewed: OAuth header isolation, distinct permission namespaces, bounded SSE startup, and HTTP session termination. Regression tests cover each.
- Additional tests cover credential cleanup after restart, late OAuth callbacks, Realtime execution, cancellation, pagination, resources/prompts/completion, subscriptions, progress, and dynamic catalogs.
- `git diff --check` passed. No commits or branches were created. Existing user README roadmap additions were retained.
- Dependency audit reports nine vulnerabilities in packages whose versions already existed in the baseline lockfile; no unrelated dependency updates were made.
- Graph tools were unavailable; implementation and review used exact source/SDK inspection instead. No live third-party credentials or paid model calls were used.
