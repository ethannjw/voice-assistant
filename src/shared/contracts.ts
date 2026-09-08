export const WORKSPACE_TOOL_NAMES = [
  "workspace_status",
  "search_workspace",
  "read_file",
  "git_diff",
  "run_tests",
  "propose_patch"
] as const;

export type ToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export type ToolRequest = {
  name: ToolName;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
};

export type CodingAgentName = "cursor" | "codex";

export type PendingPatch = {
  id: string;
  diff: string;
  createdAt: string;
};

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline";

export type CodexApprovalRequest = {
  id: string;
  kind: "command" | "file_change" | "legacy_command" | "legacy_file_change" | "cursor_tool";
  title: string;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  grantRoot: string | null;
  diff: string | null;
  availableDecisions: CodexApprovalDecision[];
  createdAt: string;
};

export type ProjectConfig = {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
};

export type AppConfig = {
  activeProject: ProjectConfig | null;
  projects: ProjectConfig[];
  realtimeModel: string;
  voice: string;
  codingAgent: CodingAgentName;
  codingModel: string | null;
};
