/**
 * Public PKCE-only OAuth client provider for Clay MCP (ADR-017, ADR-018).
 * Loopback redirect + ephemeral PKCE; durable store holds DCR + tokens only.
 */

import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  CLAY_CREDENTIALS_PATH,
  clearClayTokens,
  loadClayCredentials,
  saveClayClientInformation,
  saveClayTokens,
} from "./clay-auth-store.ts";

/** Fixed loopback port so DCR redirect_uris stay stable across runs. */
export const CLAY_OAUTH_LOOPBACK_PORT = 8765;
export const CLAY_OAUTH_REDIRECT_PATH = "/callback";
export const CLAY_OAUTH_REDIRECT_URL =
  `http://127.0.0.1:${CLAY_OAUTH_LOOPBACK_PORT}${CLAY_OAUTH_REDIRECT_PATH}`;

export const CLAY_MCP_URL = "https://api.clay.com/v3/mcp";

export interface ClayOAuthProviderOptions {
  credentialsPath?: string;
  /** Called when the SDK wants the user to visit the authorize URL. */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  openBrowser?: boolean;
}

export class ClayOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = CLAY_OAUTH_REDIRECT_URL;

  private readonly credentialsPath: string;
  private readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  private readonly openBrowser: boolean;

  private clientInformationMemory?: StoredOAuthClientInformation;
  private tokensMemory?: StoredOAuthTokens;
  /** Ephemeral PKCE verifier for the active authorization attempt only. */
  private codeVerifierMemory?: string;
  private discoveryMemory?: OAuthDiscoveryState;
  lastState?: string;
  private loaded = false;

  constructor(options: ClayOAuthProviderOptions = {}) {
    this.credentialsPath = options.credentialsPath ?? CLAY_CREDENTIALS_PATH;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
    this.openBrowser = options.openBrowser ?? true;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "clay-record-replay",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp",
      application_type: "native",
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const file = await loadClayCredentials(this.credentialsPath);
    this.clientInformationMemory = file.clientInformation;
    this.tokensMemory = file.tokens;
    this.loaded = true;
  }

  state(): string {
    this.lastState = crypto.randomUUID();
    return this.lastState;
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    await this.ensureLoaded();
    return this.clientInformationMemory;
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
  ): Promise<void> {
    await this.ensureLoaded();
    this.clientInformationMemory = clientInformation;
    await saveClayClientInformation(clientInformation, this.credentialsPath);
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    await this.ensureLoaded();
    return this.tokensMemory;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.ensureLoaded();
    // Atomic file replace so rotated refresh_token cannot be reused.
    this.tokensMemory = tokens;
    await saveClayTokens(tokens, this.credentialsPath);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.onAuthorizationUrl) {
      await this.onAuthorizationUrl(authorizationUrl);
    } else {
      console.error("\n=== Clay OAuth authorization required ===");
      console.error("Open this URL in your browser, sign in, and approve access:");
      console.error(authorizationUrl.toString());
      console.error("Waiting for loopback callback...\n");
    }

    if (this.openBrowser) {
      await openUrl(authorizationUrl.toString()).catch(() => {
        // Browser open is best-effort; URL is already printed.
      });
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierMemory = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierMemory) {
      throw new Error("No PKCE code verifier in memory for this authorization attempt");
    }
    return this.codeVerifierMemory;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discoveryMemory = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discoveryMemory;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    await this.ensureLoaded();
    if (scope === "verifier") {
      this.codeVerifierMemory = undefined;
      return;
    }
    if (scope === "discovery") {
      this.discoveryMemory = undefined;
      return;
    }
    if (scope === "tokens") {
      this.tokensMemory = undefined;
      await clearClayTokens(this.credentialsPath);
      return;
    }
    if (scope === "client") {
      this.clientInformationMemory = undefined;
      const { saveClayCredentials } = await import("./clay-auth-store.ts");
      await saveClayCredentials(
        this.tokensMemory ? { tokens: this.tokensMemory } : {},
        this.credentialsPath,
      );
      return;
    }
    // scope === "all"
    this.tokensMemory = undefined;
    this.clientInformationMemory = undefined;
    this.codeVerifierMemory = undefined;
    this.discoveryMemory = undefined;
    const { saveClayCredentials } = await import("./clay-auth-store.ts");
    await saveClayCredentials({}, this.credentialsPath);
  }

  /** Drop in-memory + stored tokens so replay cannot refresh or reconnect. */
  async removeTokenAccess(): Promise<void> {
    await this.ensureLoaded();
    this.tokensMemory = undefined;
    this.codeVerifierMemory = undefined;
    this.discoveryMemory = undefined;
    await clearClayTokens(this.credentialsPath);
  }
}

function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args =
      process.platform === "win32" ? ["/c", "start", "", url] : [url];
    execFile(cmd, args, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export interface LoopbackCallbackWaiter {
  /** Promise that resolves with the callback query params. */
  waitForCallback(timeoutMs?: number): Promise<URLSearchParams>;
  close(): Promise<void>;
}

/**
 * Listen on the fixed loopback redirect URI and capture one OAuth callback.
 */
export async function startLoopbackCallbackServer(): Promise<LoopbackCallbackWaiter> {
  let resolveParams: ((params: URLSearchParams) => void) | undefined;
  let rejectParams: ((err: Error) => void) | undefined;
  const paramsPromise = new Promise<URLSearchParams>((resolve, reject) => {
    resolveParams = resolve;
    rejectParams = reject;
  });

  const server: Server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${CLAY_OAUTH_LOOPBACK_PORT}`);
      if (url.pathname !== CLAY_OAUTH_REDIRECT_PATH) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (url.searchParams.get("error")) {
        const desc =
          url.searchParams.get("error_description") ??
          url.searchParams.get("error") ??
          "authorization error";
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Authorization failed: ${desc}`);
        rejectParams?.(new Error(`OAuth error: ${desc}`));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><body><h1>Clay authorization complete</h1><p>You can return to the terminal.</p></body></html>",
      );
      resolveParams?.(url.searchParams);
    } catch (err) {
      res.writeHead(500);
      res.end("Callback error");
      rejectParams?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CLAY_OAUTH_LOOPBACK_PORT, "127.0.0.1", () => resolve());
  });

  return {
    waitForCallback(timeoutMs = 10 * 60 * 1000) {
      return new Promise<URLSearchParams>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for OAuth callback after ${timeoutMs}ms`));
        }, timeoutMs);
        paramsPromise.then(
          (params) => {
            clearTimeout(timer);
            resolve(params);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
