export type ToolName =
  | "workspace_status"
  | "search_workspace"
  | "read_file"
  | "git_diff"
  | "run_tests"
  | "propose_patch";

export type ToolRequest = {
  name: ToolName;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
};

export type PendingPatch = {
  id: string;
  diff: string;
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
};
