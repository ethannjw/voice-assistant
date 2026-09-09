import path from "node:path";
import { parseCodingAgentName } from "./codingAgent";

// Codex `model_provider` from ~/.codex/config.toml, passed as `codex app-server -c model_provider=<name>`.
// `--profile` cannot be used: codex-cli restricts it to runtime commands and rejects it for app-server.
const codexModelProvider = process.env.CODEX_MODEL_PROVIDER?.trim() || undefined;
const codingAgent = parseCodingAgentName(process.env.CODING_AGENT);
const cursorModel = process.env.CURSOR_MODEL?.trim() || undefined;

function readTimeout(name: string, fallback: number) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer in milliseconds, at most 2147483647.`);
  }
  return milliseconds;
}

if (process.env.CODEX_PROFILE?.trim()) {
  console.warn(
    "CODEX_PROFILE is ignored: codex-cli does not accept --profile for `app-server`. " +
      "Set CODEX_MODEL_PROVIDER (and CODEX_MODEL) instead."
  );
}

export const env = {
  mcpConfigPath: path.resolve(process.env.MCP_CONFIG_FILE ?? path.join(process.cwd(), ".voice-pair-programmer", "mcp.json")),
  port: Number(process.env.PORT ?? 8787),
  defaultWorkspaceRoot: path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd()),
  projectStorePath: path.resolve(
    process.env.PROJECTS_FILE ?? path.join(process.cwd(), ".voice-pair-programmer", "projects.json")
  ),
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2",
  firecrawlBaseUrl: process.env.FIRECRAWL_BASE_URL?.trim() || "http://localhost:3002",
  codingAgent,
  cursorAgentCommand: process.env.CURSOR_AGENT_COMMAND?.trim() || "agent",
  cursorModel,
  cursorRequestTimeoutMs: readTimeout("CURSOR_REQUEST_TIMEOUT_MS", 30_000),
  cursorTurnTimeoutMs: readTimeout("CURSOR_TURN_TIMEOUT_MS", 300_000),
  codexModelProvider,
  // gpt-5.5 is rejected by codex app-server's thread/start as of CLI 0.130; use 5.4.
  // With a custom model_provider, set CODEX_MODEL to a model that provider serves.
  codexModel: process.env.CODEX_MODEL?.trim() || (codexModelProvider ? undefined : "gpt-5.4"),
  voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
  noProjectWorkspace: process.env.NO_PROJECT_WORKSPACE,
  isProduction: process.env.NODE_ENV === "production"
};
