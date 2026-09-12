# User-configurable MCP client

## Approved direction

Elva is a local, single-user harness. Users configure arbitrary MCP servers rather than selecting hard-coded Jira or Splunk integrations. GitHub command execution is a separate feature and is not part of this change. Connecting a server explicitly trusts its executable or endpoint; users control tool execution with allow, ask, and deny policies.

## Design

Use the official MCP TypeScript SDK for protocol negotiation and transports. Store a familiar `mcpServers` configuration in the existing ignored application data directory. Support stdio, Streamable HTTP, and explicitly configured legacy SSE. Persist OAuth credentials separately with owner-only file permissions. Do not send connection secrets to the model or include them in status responses.

A connection manager owns clients, discovery, lifecycle, authentication, and permission checks. Realtime receives a small stable set of MCP discovery/execution functions, avoiding tool-count limits and requiring no reconnect when a server catalog changes. Full server tool schemas are discoverable on demand. Resources, resource templates, and prompts are available through the same MCP gateway. Advertise only implemented client capabilities; unsupported optional server-initiated capabilities must fail clearly rather than be silently acknowledged.

Configuration is managed through a browser panel, including JSON import/export, connection state, reconnect, disable, delete, authentication, capability inspection, and permission policies. Import is an explicit trust action because local server commands can run arbitrary code. No repository configuration is executed automatically.

## Safety and reliability

Validate configuration, tool arguments, request origins, and bounded request lifetimes. Preserve structured MCP results and application-level errors. Do not automatically retry tools after ambiguous failures. Close child processes on disable/remove/shutdown. Keep OAuth redirect state and PKCE on the server, bind credentials to the configured endpoint, and redact status errors. Recheck permissions at execution time. Treat tool results and server metadata as untrusted content.

## Verification

Use deterministic local MCP fixtures, never user credentials or production services. Cover persistence, validation, stdio/HTTP/SSE discovery, tools/resources/prompts, denied and approved execution, cancellation, failures, UI configuration, OAuth, and regressions in existing Realtime/workspace tools. Document exact supported capabilities and limitations rather than claim compatibility with every possible optional extension.
