import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeTransport } from "../adapters/fake-transport.ts";
import { createFakeToolServer, LOOKUP_COMPANY } from "../fixtures/fake-tool.ts";
import {
  createInterceptor,
  ReplayMismatchError,
} from "../src/interceptor.ts";

test("strict replay mismatches when arguments differ", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "clay-test-"));
  const tracePath = join(workDir, "trace.jsonl");
  const server = createFakeToolServer();
  const transport = createFakeTransport(server);

  try {
    server.start();
    const recorder = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });
    await recorder.call(LOOKUP_COMPANY, { name: "Linear" });
    server.stop();

    const replayer = await createInterceptor({
      mode: "strict_replay",
      transport,
      tracePath,
    });

    await assert.rejects(
      () => replayer.call(LOOKUP_COMPANY, { name: "Notion" }),
      (err: unknown) => err instanceof ReplayMismatchError,
    );
    assert.equal(server.liveCallCount(), 1);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
