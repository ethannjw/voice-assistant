import path from "node:path";

// Codex config profile layered on the base user config, passed as `codex --profile <name>`.
const codexProfile = process.env.CODEX_PROFILE?.trim() || undefined;

export const env = {
  port: Number(process.env.PORT ?? 8787),
  defaultWorkspaceRoot: path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd()),
  projectStorePath: path.resolve(
    process.env.PROJECTS_FILE ?? path.join(process.cwd(), ".voice-pair-programmer", "projects.json")
  ),
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2",
  codexProfile,
  // gpt-5.5 is rejected by codex app-server's thread/start as of CLI 0.130; use 5.4.
  // With a profile active, the profile's model/provider wins unless CODEX_MODEL is set explicitly.
  codexModel: process.env.CODEX_MODEL?.trim() || (codexProfile ? undefined : "gpt-5.4"),
  voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
  noProjectWorkspace: process.env.NO_PROJECT_WORKSPACE,
  isProduction: process.env.NODE_ENV === "production"
};
