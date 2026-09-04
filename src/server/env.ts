import path from "node:path";

// Codex `model_provider` from ~/.codex/config.toml, passed as `codex app-server -c model_provider=<name>`.
// `--profile` cannot be used: codex-cli restricts it to runtime commands and rejects it for app-server.
const codexModelProvider = process.env.CODEX_MODEL_PROVIDER?.trim() || undefined;

if (process.env.CODEX_PROFILE?.trim()) {
  console.warn(
    "CODEX_PROFILE is ignored: codex-cli does not accept --profile for `app-server`. " +
      "Set CODEX_MODEL_PROVIDER (and CODEX_MODEL) instead."
  );
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  defaultWorkspaceRoot: path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd()),
  projectStorePath: path.resolve(
    process.env.PROJECTS_FILE ?? path.join(process.cwd(), ".voice-pair-programmer", "projects.json")
  ),
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2",
  webSearchModel: process.env.OPENAI_WEB_SEARCH_MODEL?.trim() || "gpt-5.4-mini",
  codexModelProvider,
  // gpt-5.5 is rejected by codex app-server's thread/start as of CLI 0.130; use 5.4.
  // With a custom model_provider, set CODEX_MODEL to a model that provider serves.
  codexModel: process.env.CODEX_MODEL?.trim() || (codexModelProvider ? undefined : "gpt-5.4"),
  voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
  noProjectWorkspace: process.env.NO_PROJECT_WORKSPACE,
  isProduction: process.env.NODE_ENV === "production"
};
