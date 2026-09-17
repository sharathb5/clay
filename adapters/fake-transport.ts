import type { FakeToolServer } from "../fixtures/fake-tool.ts";
import type { Transport } from "../src/types.ts";

/** Live transport adapter over the in-process fake tool. */
export function createFakeTransport(server: FakeToolServer): Transport {
  return {
    async call(toolName: string, args: unknown): Promise<unknown> {
      return server.invoke(toolName, args);
    },
  };
}
