/**
 * Authenticated Clay MCP transport (ADR-016, ADR-017, ADR-019).
 * Implements the generic Transport boundary; OAuth/HTTP/session stay here.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { Transport } from "../src/types.ts";
import {
  CLAY_MCP_URL,
  ClayOAuthProvider,
  startLoopbackCallbackServer,
  type ClayOAuthProviderOptions,
} from "./clay-oauth.ts";

export interface ClayTransportSession {
  transport: Transport;
  /** Live MCP client (adapter-only; not for interceptor use). */
  listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  >;
  liveCallCount(): number;
  /** Negotiated protocol era if the SDK reports one (dev inspection only). */
  protocolEra(): string | undefined;
  /** Drop stored/in-memory tokens so replay cannot refresh or reconnect. */
  removeAuthAccess(): Promise<void>;
  /** Terminate Clay MCP session and close the client. */
  close(): Promise<void>;
}

export interface CreateClayTransportOptions extends ClayOAuthProviderOptions {
  /** Skip interactive browser auth; fail if tokens are missing/invalid. */
  interactiveAuth?: boolean;
}

function normalizeToolResult(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}): unknown {
  if (result.isError) {
    const detail = JSON.stringify(result.content ?? null);
    throw new Error(`Clay MCP tool error: ${detail}`);
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  return result.content ?? null;
}

async function connectClayClient(
  provider: ClayOAuthProvider,
  interactiveAuth: boolean,
): Promise<{
  client: Client;
  httpTransport: StreamableHTTPClientTransport;
}> {
  const url = new URL(CLAY_MCP_URL);
  const client = new Client(
    { name: "clay-record-replay", version: "0.0.1" },
    { versionNegotiation: { mode: "legacy" } },
  );

  // Loopback must be listening before any authorize redirect (SDK redirects
  // inside connect before throwing UnauthorizedError).
  const loopback = interactiveAuth
    ? await startLoopbackCallbackServer()
    : undefined;

  try {
    let httpTransport = new StreamableHTTPClientTransport(url, {
      authProvider: provider,
    });

    try {
      await client.connect(httpTransport);
      return { client, httpTransport };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        throw err;
      }
      if (!interactiveAuth || !loopback) {
        throw new Error(
          "Clay MCP authorization required. Re-run with interactive auth enabled.",
        );
      }

      const params = await loopback.waitForCallback();
      if (provider.lastState && params.get("state") !== provider.lastState) {
        throw new Error("OAuth state mismatch on callback");
      }
      await httpTransport.finishAuth(params);

      // Started transport cannot be restarted — reconnect on a fresh instance.
      httpTransport = new StreamableHTTPClientTransport(url, {
        authProvider: provider,
      });
      await client.connect(httpTransport);
      return { client, httpTransport };
    }
  } finally {
    await loopback?.close().catch(() => undefined);
  }
}

/**
 * Connect to Clay MCP with public PKCE OAuth and expose a generic Transport.
 */
export async function createClayTransport(
  options: CreateClayTransportOptions = {},
): Promise<ClayTransportSession> {
  const interactiveAuth = options.interactiveAuth ?? true;
  const provider = new ClayOAuthProvider(options);

  // Ensure loopback is listening before the authorize redirect when we may need auth.
  // If tokens already work, connect succeeds without callback.
  const { client, httpTransport } = await connectClayClient(
    provider,
    interactiveAuth,
  );

  let closed = false;
  let liveCalls = 0;
  let era: string | undefined;
  try {
    era = client.getProtocolEra?.();
  } catch {
    era = undefined;
  }
  if (era) {
    console.error(`[clay-transport] negotiated protocol era: ${era}`);
  }

  const transport: Transport = {
    async call(toolName: string, args: unknown): Promise<unknown> {
      if (closed) {
        throw new Error("Live Clay MCP unavailable: transport is closed");
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Clay MCP tool arguments must be a plain object");
      }

      const result = await client.callTool({
        name: toolName,
        arguments: args as Record<string, unknown>,
      });

      liveCalls += 1;
      return normalizeToolResult(result);
    },
  };

  return {
    transport,
    async listTools() {
      if (closed) {
        throw new Error("Live Clay MCP unavailable: transport is closed");
      }
      const listed = await client.listTools();
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    liveCallCount() {
      return liveCalls;
    },
    protocolEra() {
      return era;
    },
    async removeAuthAccess() {
      await provider.removeTokenAccess();
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await httpTransport.terminateSession();
      } catch {
        // Session may already be gone; still close the client.
      }
      await client.close();
    },
  };
}

/**
 * Fail-closed Transport that always rejects — for strict-replay isolation proofs.
 */
export function createFailClosedClayTransport(): Transport {
  return {
    async call() {
      throw new Error("Live Clay MCP unavailable: fail-closed transport");
    },
  };
}
