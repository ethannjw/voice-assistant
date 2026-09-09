# Configuring MCP servers

Elva has a general MCP client. Server tools are discovered at runtime; there are no Jira, Splunk, or other service-specific adapters. GitHub command execution is separate from this feature.

## Quick start

1. Open the harness at `http://localhost:8787` (or your configured port).
2. Select **Manage MCP servers**.
3. Paste a configuration with a top-level `mcpServers` object, or import a JSON file. Imported files only populate the editor; they do not execute anything.
4. Review the configuration and choose **Save and trust configuration**.
5. Press **Connect**, or let Elva discover/use the server. An enabled server connects lazily on first use.
6. If the server requires OAuth, follow **Authorize … in browser**, complete authentication, and return to Elva.

Elva uses the stable `mcp_list` and `mcp_call` functions in connected Realtime voice **and text** conversations. Server changes do not require reconnecting Realtime. The disconnected text fallback still goes directly to the coding backend; it does not inherit these MCP connections. This feature does not modify Cursor or Codex's own MCP configuration.

## Configuration format

```json
{
  "mcpServers": {
    "local-service": {
      "command": "npx",
      "args": ["-y", "your-mcp-server-package"],
      "env": { "API_TOKEN": "${MY_SERVICE_TOKEN}" },
      "cwd": "/absolute/working/directory",
      "permission": "allow"
    },
    "remote-service": {
      "type": "http",
      "url": "https://your-server.example/mcp",
      "permission": "ask",
      "permissions": {
        "search": "allow",
        "delete_item": "deny"
      },
      "operationPermissions": { "read_resource": "allow" },
      "timeoutMs": 120000
    },
    "legacy-service": {
      "type": "sse",
      "url": "https://your-server.example/sse",
      "headers": { "Authorization": "Bearer ${LEGACY_SERVICE_TOKEN}" },
      "enabled": false
    }
  }
}
```

Replace the example packages, paths, and endpoints with your server's documented configuration. A server executable must already be available on the harness process's `PATH`, or use an absolute executable path. A command such as `npx` may download and execute software; saving a configuration is an explicit trust decision. The harness does not install server binaries on your behalf.

| Field | Meaning |
| --- | --- |
| `type` | `stdio`, `http` (Streamable HTTP), or `sse` (legacy SSE). Inferred as stdio when `command` exists, otherwise HTTP. |
| `command`, `args`, `cwd`, `env` | Local subprocess configuration. Arguments are an array, not a shell command. `cwd` must be absolute. |
| `url`, `headers` | Remote HTTP(S) endpoint and optional headers. Embedded URL username/password is rejected. |
| `oauth` | Optional pre-registered `clientId`, `clientSecret`, and requested `scope`. Otherwise SDK OAuth discovery and dynamic registration are used where supported. |
| `enabled` | Defaults to `true`. `disabled: true` is also accepted on import. |
| `permission` | `allow` (default), `ask`, or `deny`. Applies to invocations, not connection/startup or catalog discovery. |
| `permissions` | Exact tool-name overrides; these never apply to non-tool operations. |
| `operationPermissions` | Separate overrides for `read_resource`, `get_prompt`, `complete`, `subscribe_resource`, or `unsubscribe_resource`. |
| `timeoutMs` | Request lifetime in milliseconds, 1,000–3,600,000; default 120,000. Approval/input waiting is included. Connection establishment, including transport startup, is capped at 30 seconds. Healthy idle streams are not limited by the request deadline. |

Use `${VARIABLE}` or `${VARIABLE:-fallback}` references in commands, arguments, environment entries, paths, URLs, and header values. Values come from the harness server's environment, including its `.env`, not the browser. Subprocesses inherit the SDK's minimal environment plus explicitly configured entries; they do not receive the entire harness environment.

Without `cwd`, a local server starts in the harness process's working directory, not automatically in the selected project. Remote URLs should be canonical endpoints: automatic HTTP redirects are rejected to avoid forwarding credentials to unexpected destinations.

## Permissions and trust

- **Allow all** exposes all capabilities permitted by the remote account. It does not increase that account's remote privileges.
- **Ask first** creates a visible request in the MCP panel with the operation and arguments. Accept, decline, or cancel it there; server-requested form/URL elicitation also appears here.
- **Deny all** blocks invocations unless explicitly overridden. To prevent the server process from starting or any connection/discovery, disable or remove it instead.
- Changing configuration closes the old connection and cancels its pending requests. Configuration errors do not replace valid saved configuration.
- Server descriptions, prompts, resources, and results are untrusted data. They cannot change harness permission policies.
- Local servers are **not OS-sandboxed**. They execute as your user. HTTP endpoints are user-trusted and may access private networks. Only connect servers you trust.

MCP management and invocation routes require a loopback client and a localhost/loopback Host header, with same-origin checks for browser requests. This is a **single-user local application**, not a remotely hosted multi-user authorization system. Other processes running as your local user remain trusted. Remote reverse-proxy access is not supported by this feature.

## Storage and authentication

The default configuration file is `.voice-pair-programmer/mcp.json`. Override it with `MCP_CONFIG_FILE`. OAuth tokens and dynamic client registrations are stored in the sibling `mcp-credentials` directory, separately from configuration. Configuration/token files use mode `0600`; newly created directories use `0700`. These are private plaintext files, not an encrypted vault. The default application data directory is already gitignored.

The management editor and **Export saved JSON** intentionally contain configured secrets. Prefer environment references; do not commit exports. Status responses and model-visible discovery do not expose connection configuration or OAuth tokens. If you override the storage path, keep both it and its credential directory out of version control.

OAuth uses server-side PKCE and expiring, single-use callback state. The redirect URI is `http://localhost:<PORT>/api/mcp/oauth/callback`. Pre-registered OAuth clients must allow that exact URI. **Clear auth** deletes locally stored credentials and disconnects; it does not revoke the authorization grant at the identity provider. **Reconnect** restarts the transport without clearing saved OAuth tokens.

Use the UI to edit running configuration. If you edit the JSON file directly, restart the harness to load it. Malformed JSON or invalid saved configuration is reported at startup rather than silently overwritten.

## Supported protocol surface

- Official MCP TypeScript SDK initialization, protocol-version/capability negotiation, stdio, Streamable HTTP, and explicitly selected legacy SSE.
- Paginated tools, tool invocation, JSON Schema input validation, structured content, and MCP `isError` results.
- Resources, resource templates, resource reads/subscriptions, prompts and prompt retrieval, and argument completion.
- Fresh catalog discovery on each discovery request; change notifications appear in the activity log. Elva can filter and page the catalog (50 entries per response).
- Client roots representing the current selected project, with roots-changed notifications. Roots communicate scope; they do not sandbox an MCP server.
- Form and URL elicitation through explicit user interaction. Form answers are validated against the server schema.
- Progress reporting, request cancellation, reconnect/disconnect lifecycle, and bounded recent activity history.

Only implemented client capabilities are advertised. **Sampling and experimental task APIs are not advertised or implemented.** Custom transports, provider-specific nonstandard extensions, and native image/audio rendering of MCP results are outside this change. JSON results preserve MCP content blocks, including structured/binary descriptors; they are not automatically converted into native Realtime image/audio input. Server-provided prompts are returned as data, not automatically installed as system instructions.

Catalog discovery has protective bounds of 20,000 entries and 1,000 continuation cursors per collection; repeated cursors fail clearly. Transport failures do not automatically replay tool calls. A cancelled/timed-out write may have completed remotely—verify its outcome before retrying. Resource subscriptions and pending interactions are session-local, not durable jobs; reconnect/restart requires subscribing again.

## Verification

Run `npm run test:e2e -- e2e/mcp.spec.ts e2e/mcp-remote.spec.ts e2e/mcp-lifecycle.spec.ts`. The tests use local protocol servers, a local OAuth provider, disposable files under `.e2e`, and fake Realtime browser events. They do not use your actual MCP credentials or third-party accounts. Real Jira/Splunk/vendor compatibility and live model selection of tools require separate opt-in checks with your chosen servers.
