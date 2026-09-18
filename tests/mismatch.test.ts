import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMcpTransport } from "../adapters/mcp-transport.ts";
import { LOOKUP_COMPANY } from "../fixtures/tools.ts";
import {
  createInterceptor,
  ReplayMismatchError,
} from "../src/interceptor.ts";

test("strict replay mismatches when arguments differ", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "clay-test-"));
  const tracePath = join(workDir, "trace.jsonl");
  const session = await createMcpTransport();

  try {
    const recorder = await createInterceptor({
      mode: "record",
      transport: session.transport,
      tracePath,
    });
    await recorder.call(LOOKUP_COMPANY, { name: "Linear", limit: 5 });
    await session.close();

    const replayer = await createInterceptor({
      mode: "strict_replay",
      transport: session.transport,
      tracePath,
    });

    await assert.rejects(
      () => replayer.call(LOOKUP_COMPANY, { name: "Linear", limit: 10 }),
      (err: unknown) => err instanceof ReplayMismatchError,
    );
    assert.equal(session.liveCallCount(), 1);
  } finally {
    await session.close().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
});
