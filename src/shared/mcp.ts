export type McpPermission = "allow" | "ask" | "deny";

export type McpServerConfig = {
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: { clientId?: string; clientSecret?: string; scope?: string };
  enabled: boolean;
  permission: McpPermission;
  permissions?: Record<string, McpPermission>;
  operationPermissions?: Record<string, McpPermission>;
  timeoutMs: number;
};

export type McpConfig = { mcpServers: Record<string, McpServerConfig> };

export type McpServerStatus = {
  name: string;
  type: McpServerConfig["type"];
  enabled: boolean;
  permission: McpPermission;
  state: "disconnected" | "connecting" | "connected" | "auth_required" | "error";
  error?: string;
  authorizationUrl?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  serverVersion?: { name: string; version: string };
};

export type McpInteraction = {
  id: string;
  server: string;
  kind: "permission" | "elicitation";
  message: string;
  schema?: Record<string, unknown>;
  url?: string;
  createdAt: string;
};

export type McpInteractionAnswer = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
};

export type McpEvent = {
  id: string;
  server: string;
  message: string;
  createdAt: string;
};

export type McpStatus = {
  servers: McpServerStatus[];
  interactions: McpInteraction[];
  events: McpEvent[];
};
