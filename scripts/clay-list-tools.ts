/**
 * Interactive Clay OAuth + tools/list helper for Phase 3 setup.
 * Does not perform tools/call — selection happens after inspection.
 */

import { createClayTransport } from "../adapters/clay-transport.ts";

async function main(): Promise<void> {
  console.error("Connecting to Clay MCP (interactive OAuth if needed)...");
  const session = await createClayTransport({ interactiveAuth: true });

  try {
    const era = session.protocolEra();
    if (era) {
      console.error(`Protocol era: ${era}`);
    }

    const tools = await session.listTools();
    console.log(
      JSON.stringify(
        {
          toolCount: tools.length,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? null,
            inputSchema: t.inputSchema ?? null,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
