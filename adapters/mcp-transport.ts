import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Transport } from "../src/types.ts";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const serverPath = fileURLToPath(
  new URL("../fixtures/mcp-lookup-server.ts", import.meta.url),
);

export interface McpTransportSession {
  /** Live Transport boundary used by the interceptor. */
  transport: Transport;
  /** How many successful live MCP tool calls completed since connect. */
  liveCallCount(): number;
  /** Tear down the MCP client and spawned server process. */
  close(): Promise<void>;
}

/**
 * Spawn a local MCP stdio server and expose it as a Transport.
 * Protocol details stay inside this adapter (ADR-013, ADR-015).
 */
export async function createMcpTransport(): Promise<McpTransportSession> {
  const client = new Client({
    name: "clay-record-replay",
    version: "0.0.1",
  });

  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, serverPath],
  });

  await client.connect(stdio);

  let closed = false;
  let liveCalls = 0;

  const transport: Transport = {
    async call(toolName: string, args: unknown): Promise<unknown> {
      if (closed) {
        throw new Error("Live MCP unavailable: transport is closed");
      }

      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("MCP tool arguments must be a plain object");
      }

      const result = await client.callTool({
        name: toolName,
        arguments: args as Record<string, unknown>,
      });

      if (result.isError) {
        const detail = JSON.stringify(result.content ?? null);
        throw new Error(`MCP tool error for ${toolName}: ${detail}`);
      }

      liveCalls += 1;

      if (
        result.structuredContent !== undefined &&
        result.structuredContent !== null
      ) {
        return result.structuredContent;
      }

      return result.content ?? null;
    },
  };

  return {
    transport,
    liveCallCount() {
      return liveCalls;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await client.close();
    },
  };
}
