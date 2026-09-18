/**
 * Local MCP stdio server for Phase 2.
 * Exposes one deterministic tool: lookup_company.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { LOOKUP_COMPANY } from "./tools.ts";

const handle = serveStdio(() => {
  const server = new McpServer({
    name: "clay-phase2-lookup",
    version: "0.0.1",
  });

  server.registerTool(
    LOOKUP_COMPANY,
    {
      description: "Deterministic fake company lookup for record/replay proofs",
      inputSchema: z.object({
        name: z.string(),
        limit: z.number(),
      }),
      outputSchema: z.object({
        name: z.string(),
        limit: z.number(),
        employeeCount: z.number(),
        industry: z.string(),
      }),
    },
    async ({ name, limit }) => {
      const output = {
        name,
        limit,
        employeeCount: 150,
        industry: "Software",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
});

const exit = async () => {
  await handle.close();
  process.exit(0);
};

process.on("SIGINT", exit);
process.on("SIGTERM", exit);
