import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  ElicitRequestSchema, ListRootsRequestSchema, ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema, ProgressNotificationSchema,
  type Tool, type Resource, type ResourceTemplate, type Prompt
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ProjectConfig, ToolResult } from "../../shared/contracts";
import type { McpEvent, McpInteraction, McpInteractionAnswer, McpServerConfig, McpServerStatus, McpStatus } from "../../shared/mcp";
import { expandEnvironment, expandMap, McpConfigStore, object } from "./config";
import { McpOAuthProvider } from "./oauth";
import { discoverCatalog, discoverTools } from "./discovery";
import { createMcpFetch } from "./transportFetch";

type Catalog = { tools: Tool[]; resources: Resource[]; resourceTemplates: ResourceTemplate[]; prompts: Prompt[] };
type Connection = {
  config: McpServerConfig;
  status: McpServerStatus;
  client?: Client;
  transport?: Transport;
  oauth?: McpOAuthProvider;
  opening?: Promise<Client>;
  closing?: Promise<void>;
  lifetime: AbortController;
};
type Pending = { data: McpInteraction; resolve: (answer: McpInteractionAnswer) => void };

export class McpManager {
  private connections = new Map<string, Connection>();
  private pending = new Map<string, Pending>();
  private events: McpEvent[] = [];
  private updates: Promise<void> = Promise.resolve();

  constructor(
    readonly store: McpConfigStore,
    private readonly redirectUrl: string,
    private readonly activeProject: () => ProjectConfig | null
  ) {}

  async load() {
    await this.store.load();
    for (const [name, config] of Object.entries(this.store.get().mcpServers)) this.connections.set(name, this.entry(name, config));
  }

  private entry(name: string, config: McpServerConfig): Connection {
    return {
      config, lifetime: new AbortController(),
      status: { name, type: config.type, enabled: config.enabled, permission: config.permission, state: "disconnected", toolCount: 0, resourceCount: 0, promptCount: 0 }
    };
  }

  status(): McpStatus {
    return {
      servers: [...this.connections.values()].map(({ status, oauth }) => ({ ...status, authorizationUrl: oauth?.authorizationUrl })),
      interactions: [...this.pending.values()].map(({ data }) => data),
      events: this.events.slice(-100)
    };
  }

  configure(input: unknown) {
    const update = this.updates.catch(() => {}).then(async () => {
      const saved = await this.store.save(input);
      for (const [name, connection] of this.connections) {
        if (JSON.stringify(connection.config) !== JSON.stringify(saved.mcpServers[name])) {
          await this.close(connection);
          if (connection.config.type !== "stdio" && (!Object.hasOwn(saved.mcpServers, name) || saved.mcpServers[name].url !== connection.config.url || JSON.stringify(saved.mcpServers[name].oauth) !== JSON.stringify(connection.config.oauth))) await this.oauthProvider(name, connection).clear();
          this.connections.delete(name);
        }
      }
      for (const [name, config] of Object.entries(saved.mcpServers)) {
        if (!this.connections.has(name)) this.connections.set(name, this.entry(name, config));
      }
    });
    this.updates = update;
    return update;
  }

  private get(name: string) {
    const connection = this.connections.get(name);
    if (!connection) throw new Error(`Unknown MCP server: ${name}`);
    if (!connection.config.enabled) throw new Error(`MCP server ${name} is disabled.`);
    if (connection.closing) throw new Error(`MCP server ${name} is disconnecting.`);
    return connection;
  }

  async connect(name: string): Promise<Client> {
    const connection = this.get(name);
    if (connection.status.state === "connected" && connection.client) return connection.client;
    if (connection.opening) return connection.opening;
    if (connection.status.state === "auth_required" && connection.oauth?.authorizationUrl) throw new Error("Authentication required. Use the MCP panel to authorize this server.");
    connection.lifetime = new AbortController();
    connection.opening = this.open(name, connection).finally(() => { connection.opening = undefined; });
    return connection.opening;
  }

  private async open(name: string, connection: Connection) {
    const lifetime = connection.lifetime;
    await connection.client?.close().catch(() => {});
    lifetime.signal.throwIfAborted();
    connection.status.state = "connecting";
    connection.status.error = undefined;
    const config = connection.config;
    const client = new Client({ name: "elva", version: "0.1.0" }, {
      capabilities: { roots: { listChanged: true }, elicitation: { form: {}, url: {} } }
    });
    connection.client = client;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      const project = this.activeProject();
      return { roots: project ? [{ name: project.name, uri: pathToFileURL(project.path).href }] : [] };
    });
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const params = request.params;
      return this.interact(name, {
        kind: "elicitation", message: params.message,
        ...(params.mode === "url" ? { url: this.safeUrl(params.url) } : { schema: params.requestedSchema })
      }, AbortSignal.any([extra.signal, connection.lifetime.signal, AbortSignal.timeout(config.timeoutMs)]));
    });
    for (const schema of [ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema]) {
      client.setNotificationHandler(schema, async () => { this.event(name, "Capability catalog changed; discovery will return current entries."); });
    }
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async () => { this.event(name, "Subscribed resource updated."); });
    client.setNotificationHandler(ProgressNotificationSchema, async ({ params }) => { this.event(name, `Progress: ${params.progress}${params.total === undefined ? "" : `/${params.total}`}`); });
    client.onclose = () => { if (connection.status.state === "connected") connection.status.state = "disconnected"; };
    client.onerror = () => { this.event(name, "MCP transport reported an error."); };
    try {
      let transport: Transport;
      if (config.type === "stdio") {
        const stdio = new StdioClientTransport({
          command: expandEnvironment(config.command!), args: config.args?.map(expandEnvironment),
          cwd: config.cwd ? expandEnvironment(config.cwd) : undefined,
          env: { ...getDefaultEnvironment(), ...expandMap(config.env) }, stderr: "pipe"
        });
        stdio.stderr?.on("data", () => {});
        transport = stdio;
      } else {
        if (!connection.oauth) {
          await this.oauthProvider(name, connection).load();
        }
        const url = new URL(expandEnvironment(config.url!));
        const options = {
          authProvider: connection.oauth,
          fetch: createMcpFetch(url, expandMap(config.headers), lifetime.signal, config.timeoutMs)
        };
        transport = config.type === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
      }
      connection.transport = transport;
      const startupTimeout = Math.min(config.timeoutMs, 30_000);
      let cancelStartup: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancelStartup = () => reject(new Error("MCP connection cancelled or timed out."));
        lifetime.signal.addEventListener("abort", cancelStartup, { once: true });
      });
      const timer = setTimeout(() => lifetime.abort(), startupTimeout);
      try {
        lifetime.signal.throwIfAborted();
        await Promise.race([client.connect(transport, { timeout: startupTimeout, signal: lifetime.signal }), cancelled]);
      } finally {
        clearTimeout(timer);
        if (cancelStartup) lifetime.signal.removeEventListener("abort", cancelStartup);
      }
      connection.lifetime.signal.throwIfAborted();
      connection.status.state = "connected";
      connection.status.serverVersion = client.getServerVersion();
      this.event(name, "Connected.");
      return client;
    } catch (error) {
      connection.status.state = connection.oauth?.authorizationUrl ? "auth_required" : "error";
      connection.status.error = connection.oauth?.authorizationUrl ? "Authentication required." : this.safeError(connection, error);
      await client.close().catch(() => {});
      throw new Error(connection.status.error);
    }
  }

  async reconnect(name: string) {
    const connection = this.get(name);
    await this.close(connection);
    if (connection.oauth) await connection.oauth.invalidateCredentials("verifier");
    if (connection.oauth) connection.oauth.authorizationUrl = undefined;
    return this.connect(name);
  }

  async finishOAuth(state: string, code: string) {
    const entry = [...this.connections.entries()].find(([, connection]) => connection.oauth?.acceptsState(state));
    if (!entry) throw new Error("Invalid or expired OAuth state.");
    const [name, connection] = entry;
    connection.oauth!.consumeState(state);
    const transport = connection.transport;
    if (!(transport instanceof StreamableHTTPClientTransport) && !(transport instanceof SSEClientTransport)) throw new Error("No pending remote authorization.");
    await transport.finishAuth(code);
    connection.status.state = "disconnected";
    await this.connect(name);
  }

  async logout(name: string) {
    const connection = this.connections.get(name);
    if (!connection) throw new Error("Unknown MCP server.");
    await this.close(connection);
    if (connection.config.type !== "stdio") await this.oauthProvider(name, connection).clear();
    connection.oauth = undefined;
  }

  private oauthProvider(name: string, connection: Connection) {
    connection.oauth ??= new McpOAuthProvider(path.join(path.dirname(this.store.filePath), "mcp-credentials"), name, connection.config, this.redirectUrl);
    return connection.oauth;
  }

  async rootsChanged() {
    await Promise.all([...this.connections.values()].map(async ({ client, status }) => {
      if (status.state === "connected") await client?.sendRootsListChanged().catch(() => {});
    }));
  }

  async catalog(name: string, signal?: AbortSignal): Promise<Catalog> {
    const client = await this.connect(name);
    const connection = this.get(name);
    const options = { timeout: connection.config.timeoutMs, signal: AbortSignal.any([connection.lifetime.signal, AbortSignal.timeout(connection.config.timeoutMs), ...(signal ? [signal] : [])]) };
    const { tools, resources, resourceTemplates, prompts } = await discoverCatalog(client, options);
    Object.assign(connection.status, { toolCount: tools.length, resourceCount: resources.length, promptCount: prompts.length });
    return { tools, resources, resourceTemplates, prompts };
  }

  async call(input: unknown, externalSignal?: AbortSignal): Promise<ToolResult> {
    let connection: Connection | undefined;
    try {
      const args = object(input, "MCP request");
      const name = this.required(args.server, "server");
      const operation = this.required(args.operation, "operation");
      connection = this.get(name);
      const lifetime = connection;
      const key = operation === "tool" ? this.required(args.name, "tool name") : operation;
      const overrides = operation === "tool" ? connection.config.permissions : connection.config.operationPermissions;
      const policy = overrides && Object.hasOwn(overrides, key) ? overrides[key] : connection.config.permission;
      if (policy === "deny") throw new Error(`Execution denied by MCP policy: ${name}/${key}`);
      const client = await this.connect(name);
      const signal = AbortSignal.any([connection.lifetime.signal, AbortSignal.timeout(connection.config.timeoutMs), ...(externalSignal ? [externalSignal] : [])]);
      const options = { timeout: connection.config.timeoutMs, signal };
      const progress = { _meta: { progressToken: randomUUID() } };
      if (policy === "ask") {
        const response = await this.interact(name, { kind: "permission", message: `${operation}: ${key}\n${JSON.stringify(args.arguments ?? args.uri ?? {}, null, 2)}` }, signal);
        if (response.action !== "accept") throw new Error("MCP execution declined.");
      }
      signal.throwIfAborted();
      if (this.get(name) !== lifetime) throw new Error("MCP configuration changed. Submit a new request.");
      let result: unknown;
      const parameters = object(args.arguments ?? {}, "arguments");
      if (operation === "tool") {
        const tools = await discoverTools(client, options);
        const tool = tools.find((candidate) => candidate.name === key);
        if (!tool) throw new Error(`Unknown MCP tool: ${key}`);
        const validation = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(parameters);
        if (!validation.valid) throw new Error(`Invalid tool arguments: ${validation.errorMessage}`);
        result = await client.callTool({ ...progress, name: key, arguments: parameters }, undefined, options);
      } else if (operation === "read_resource") {
        result = await client.readResource({ ...progress, uri: this.required(args.uri, "uri") }, options);
      } else if (operation === "get_prompt") {
        if (Object.values(parameters).some((value) => typeof value !== "string")) throw new Error("Prompt arguments must be strings.");
        result = await client.getPrompt({ ...progress, name: this.required(args.name, "prompt name"), arguments: parameters as Record<string, string> }, options);
      } else if (operation === "subscribe_resource") {
        result = await client.subscribeResource({ ...progress, uri: this.required(args.uri, "uri") }, options);
      } else if (operation === "unsubscribe_resource") {
        result = await client.unsubscribeResource({ ...progress, uri: this.required(args.uri, "uri") }, options);
      } else if (operation === "complete") {
        const reference = object(args.reference, "reference");
        const argument = object(args.argument, "argument");
        const ref = reference.type === "ref/prompt" ? { type: "ref/prompt" as const, name: this.required(reference.name, "reference.name") } : reference.type === "ref/resource" ? { type: "ref/resource" as const, uri: this.required(reference.uri, "reference.uri") } : undefined;
        if (!ref) throw new Error("Completion reference must be ref/prompt or ref/resource.");
        result = await client.complete({ ...progress, ref, argument: { name: this.required(argument.name, "argument.name"), value: typeof argument.value === "string" ? argument.value : "" } }, options);
      } else throw new Error("Unsupported MCP operation.");
      const payload = object(result, "MCP result");
      this.event(name, `${operation}: ${key} ${payload.isError ? "failed" : "completed"}.`);
      return { ok: payload.isError !== true, output: JSON.stringify(result), metadata: { server: name, operation, result } };
    } catch (error) {
      return { ok: false, output: connection ? this.safeError(connection, error) : "Invalid MCP server or request." };
    }
  }

  private interact(server: string, input: Omit<McpInteraction, "id" | "server" | "createdAt">, signal: AbortSignal): Promise<McpInteractionAnswer> {
    signal.throwIfAborted();
    if (this.pending.size >= 100) throw new Error("Too many pending MCP interactions.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const aborted = () => { this.pending.delete(id); reject(new Error("MCP request cancelled or timed out. The remote outcome may be unknown.")); };
      signal.addEventListener("abort", aborted, { once: true });
      this.pending.set(id, {
        data: { ...input, id, server, createdAt: new Date().toISOString() },
        resolve: (answer) => { signal.removeEventListener("abort", aborted); this.pending.delete(id); resolve(answer); }
      });
    });
  }

  answer(id: string, input: unknown) {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("MCP request expired or is already resolved.");
    const response = object(input, "answer");
    if (!["accept", "decline", "cancel"].includes(String(response.action))) throw new Error("Unsupported MCP answer.");
    if (response.action === "accept" && pending.data.schema) {
      const validation = new AjvJsonSchemaValidator().getValidator(pending.data.schema)(response.content ?? {});
      if (!validation.valid) throw new Error(`Invalid response: ${validation.errorMessage}`);
    }
    pending.resolve(response as McpInteractionAnswer);
  }

  safeError(connection: Connection, error: unknown) {
    let message = error instanceof Error ? error.message : "MCP request failed.";
    const tokens = connection.oauth?.tokens();
    const secrets = [...Object.values(connection.config.env ?? {}), ...Object.values(connection.config.headers ?? {}), ...(connection.config.args ?? []), connection.config.oauth?.clientSecret, tokens?.access_token, tokens?.refresh_token].filter((value): value is string => Boolean(value));
    for (const secret of secrets) {
      let expanded = secret;
      try { expanded = expandEnvironment(secret); } catch {}
      if (expanded.length > 2) message = message.split(expanded).join("[redacted]");
    }
    message = message.replace(/https?:\/\/[^\s]+/g, "[remote URL]");
    if (/abort|timeout|timed out/i.test(message)) return "MCP request cancelled or timed out. Remote execution may have completed; verify before retrying a write.";
    return message.slice(0, 1000);
  }

  private safeUrl(value: string) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported elicitation URL.");
    return url.href;
  }

  private required(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
    return value;
  }

  private event(server: string, message: string) {
    this.events.push({ id: randomUUID(), server, message, createdAt: new Date().toISOString() });
    if (this.events.length > 100) this.events.shift();
  }

  private close(connection: Connection): Promise<void> {
    if (connection.closing) return connection.closing;
    connection.closing = (async () => {
      for (const pending of this.pending.values()) {
        if (pending.data.server === connection.status.name) pending.resolve({ action: "cancel" });
      }
      const transport = connection.transport;
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId && !connection.lifetime.signal.aborted) {
        const deadline = setTimeout(() => connection.lifetime.abort(), 2000);
        try { await transport.terminateSession(); } catch {}
        finally { clearTimeout(deadline); }
      }
      connection.lifetime.abort();
      await connection.opening?.catch(() => {});
      await connection.client?.close().catch(() => {});
      connection.client = undefined;
      connection.status.state = "disconnected";
    })().finally(() => { connection.closing = undefined; });
    return connection.closing;
  }

  async dispose() {
    await Promise.all([...this.connections.values()].map((connection) => this.close(connection)));
  }
}
