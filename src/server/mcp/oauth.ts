import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerConfig } from "../../shared/mcp";
import { expandEnvironment, writePrivateJson } from "./config";

type Credentials = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens };

export class McpOAuthProvider implements OAuthClientProvider {
  private credentials: Credentials = {};
  private verifier?: string;
  private pendingState?: { value: string; expiresAt: number };
  private writes: Promise<void> = Promise.resolve();
  private cleared = false;
  authorizationUrl?: string;
  readonly filePath: string;

  constructor(
    directory: string,
    name: string,
    private readonly config: McpServerConfig,
    readonly redirectUrl: string
  ) {
    const identity = createHash("sha256").update(JSON.stringify([name, expandEnvironment(config.url ?? ""), config.oauth, redirectUrl])).digest("hex");
    this.filePath = path.join(directory, `${identity}.json`);
  }

  async load() {
    try {
      this.credentials = JSON.parse(await readFile(this.filePath, "utf8")) as Credentials;
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to load MCP OAuth credentials. Disconnect authentication and try again.");
    }
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Elva MCP client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.oauth?.clientSecret ? "client_secret_post" : "none",
      scope: this.config.oauth?.scope
    };
  }

  state() {
    const value = randomBytes(32).toString("hex");
    this.pendingState = { value, expiresAt: Date.now() + 10 * 60_000 };
    return value;
  }

  acceptsState(value: string) {
    const expected = this.pendingState;
    return Boolean(expected && expected.expiresAt > Date.now() && value.length === expected.value.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected.value)));
  }

  consumeState(value: string) {
    if (!this.acceptsState(value)) throw new Error("Invalid or expired OAuth state. Start authentication again.");
    this.pendingState = undefined;
    this.authorizationUrl = undefined;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config.oauth?.clientId) return {
      client_id: expandEnvironment(this.config.oauth.clientId),
      client_secret: this.config.oauth.clientSecret ? expandEnvironment(this.config.oauth.clientSecret) : undefined
    };
    return this.credentials.client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed) {
    this.credentials.client = client;
    await this.save();
  }

  tokens() { return this.credentials.tokens; }

  async saveTokens(tokens: OAuthTokens) {
    this.credentials.tokens = tokens;
    await this.save();
  }

  redirectToAuthorization(url: URL) {
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported OAuth authorization URL.");
    this.authorizationUrl = url.toString();
  }

  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() {
    if (!this.verifier) throw new Error("OAuth verifier expired. Start authentication again.");
    return this.verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.credentials.client;
    if (scope === "all" || scope === "tokens") delete this.credentials.tokens;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    await this.save();
  }

  async clear() {
    this.cleared = true;
    await this.writes;
    this.credentials = {};
    this.verifier = undefined;
    this.pendingState = undefined;
    this.authorizationUrl = undefined;
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private save() {
    if (this.cleared) throw new Error("OAuth credentials were cleared; this authorization attempt is no longer valid.");
    const snapshot = structuredClone(this.credentials);
    this.writes = this.writes.catch(() => {}).then(() => writePrivateJson(this.filePath, snapshot));
    return this.writes;
  }
}
