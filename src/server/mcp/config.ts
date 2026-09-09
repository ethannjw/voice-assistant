import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpConfig, McpPermission, McpServerConfig } from "../../shared/mcp";

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be a nonempty string.`);
  return value;
}

function stringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(object(value, label)).map(([key, entry]) => {
    if (typeof entry !== "string" || entry.includes("\0")) throw new Error(`${label}.${key} must be a string.`);
    return [key, entry];
  }));
}

function permission(value: unknown): McpPermission {
  if (value !== "allow" && value !== "ask" && value !== "deny") throw new Error("Permission must be allow, ask, or deny.");
  return value;
}

export function validateConfig(input: unknown): McpConfig {
  const source = object(object(input, "Configuration").mcpServers, "mcpServers");
  if (Object.keys(source).length > 100) throw new Error("At most 100 MCP servers may be configured.");
  const mcpServers = Object.fromEntries(Object.entries(source).map(([name, value]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) throw new Error("Server names must be 1-80 letters, digits, dots, underscores, or hyphens.");
    const entry = object(value, name);
    const type = entry.type ?? (entry.command ? "stdio" : "http");
    if (type !== "stdio" && type !== "http" && type !== "sse") throw new Error(`${name}: unsupported transport type.`);
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new Error(`${name}: enabled must be boolean.`);
    if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") throw new Error(`${name}: disabled must be boolean.`);
    const timeoutMs = entry.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 3_600_000) throw new Error(`${name}: timeoutMs must be between 1000 and 3600000.`);
    const config: McpServerConfig = {
      type,
      enabled: (entry.enabled as boolean | undefined) ?? !entry.disabled,
      permission: permission(entry.permission ?? "allow"),
      timeoutMs: Number(timeoutMs)
    };
    if (entry.permissions !== undefined) {
      config.permissions = Object.fromEntries(Object.entries(object(entry.permissions, "permissions")).map(([key, policy]) => [key, permission(policy)]));
    }
    if (entry.operationPermissions !== undefined) {
      config.operationPermissions = Object.fromEntries(Object.entries(object(entry.operationPermissions, "operationPermissions")).map(([key, policy]) => {
        if (!["read_resource", "get_prompt", "complete", "subscribe_resource", "unsubscribe_resource"].includes(key)) throw new Error(`Unknown MCP operation permission: ${key}`);
        return [key, permission(policy)];
      }));
    }
    if (type === "stdio") {
      config.command = optionalString(entry.command, "command");
      if (!config.command) throw new Error(`${name}: stdio requires command.`);
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((argument) => typeof argument !== "string" || argument.includes("\0")))) throw new Error(`${name}: args must be an array of strings.`);
      config.args = entry.args as string[] | undefined;
      config.env = stringMap(entry.env, "env");
      config.cwd = optionalString(entry.cwd, "cwd");
      if (config.cwd && !path.isAbsolute(expandEnvironment(config.cwd))) throw new Error(`${name}: cwd must be absolute.`);
    } else {
      config.url = optionalString(entry.url, "url");
      if (!config.url) throw new Error(`${name}: remote servers require url.`);
      validateRemoteUrl(expandEnvironment(config.url));
      config.headers = stringMap(entry.headers, "headers");
      if (entry.oauth !== undefined) {
        const oauth = object(entry.oauth, "oauth");
        config.oauth = {
          clientId: optionalString(oauth.clientId, "oauth.clientId"),
          clientSecret: optionalString(oauth.clientSecret, "oauth.clientSecret"),
          scope: optionalString(oauth.scope, "oauth.scope")
        };
        if (config.oauth.clientSecret && !config.oauth.clientId) throw new Error("oauth.clientSecret requires oauth.clientId.");
      }
    }
    return [name, config];
  }));
  return { mcpServers };
}

export function expandEnvironment(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const replacement = process.env[name] ?? fallback;
    if (replacement === undefined) throw new Error(`Missing environment variable: ${name}`);
    return replacement;
  });
}

export function expandMap(value?: Record<string, string>) {
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, entry]) => [key, expandEnvironment(entry)]));
}

export function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("MCP URLs must use HTTP(S) without embedded credentials.");
  return url;
}

export async function writePrivateJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export class McpConfigStore {
  private config: McpConfig = { mcpServers: {} };

  constructor(readonly filePath: string) {}

  async load() {
    try {
      this.config = validateConfig(JSON.parse(await readFile(this.filePath, "utf8")));
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get() { return structuredClone(this.config); }

  async save(input: unknown) {
    const config = validateConfig(input);
    await writePrivateJson(this.filePath, config);
    this.config = config;
    return this.get();
  }
}
