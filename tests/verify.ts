/**
 * End-to-end invariant proof for Phase 1.
 *
 * 1. Clean trace
 * 2. Record via interceptor → live fake tool
 * 3. Confirm trace persisted
 * 4. Stop fake tool (live calls throw)
 * 5. Strict replay via interceptor
 * 6. Replay output equals recorded output
 * 7. Live implementation was not invoked during replay
 *
 * If strict replay accidentally crosses the live boundary after stop(),
 * this script fails hard ("Live tool unavailable").
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeTransport } from "../adapters/fake-transport.ts";
import { createFakeToolServer, LOOKUP_COMPANY } from "../fixtures/fake-tool.ts";
import { createInterceptor } from "../src/interceptor.ts";
import { readTrace, stableEqual, traceExistsAndNonEmpty } from "../src/trace.ts";

const ARGS = { name: "Linear" } as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`VERIFY FAILED: ${message}`);
  }
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "clay-verify-"));
  const tracePath = join(workDir, "trace.jsonl");

  try {
    const server = createFakeToolServer();
    const transport = createFakeTransport(server);

    // --- Record ---
    server.start();
    assert(server.isAvailable(), "fake server should be available for record");

    const recorder = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });

    const recorded = await recorder.call(LOOKUP_COMPANY, ARGS);
    const liveCallsAfterRecord = server.liveCallCount();
    assert(liveCallsAfterRecord === 1, `expected 1 live call during record, got ${liveCallsAfterRecord}`);
    assert(
      stableEqual(recorded, {
        name: "Linear",
        employeeCount: 150,
        industry: "Software",
      }),
      "recorded response mismatch",
    );

    assert(await traceExistsAndNonEmpty(tracePath), "trace was not written");
    const entries = await readTrace(tracePath);
    assert(entries.length === 1, `expected 1 trace entry, got ${entries.length}`);
    assert(entries[0].toolName === LOOKUP_COMPANY, "trace tool name mismatch");
    assert(stableEqual(entries[0].arguments, ARGS), "trace arguments mismatch");
    assert(stableEqual(entries[0].response, recorded), "trace response mismatch");

    // --- Make live execution impossible ---
    server.stop();
    assert(!server.isAvailable(), "fake server should be stopped before replay");

    // Sanity: a direct live call must fail now.
    let liveBlocked = false;
    try {
      await transport.call(LOOKUP_COMPANY, ARGS);
    } catch (err) {
      liveBlocked = err instanceof Error && err.message.includes("Live tool unavailable");
    }
    assert(liveBlocked, "stopped transport should throw on live call");

    // --- Strict replay ---
    const liveCallsBeforeReplay = server.liveCallCount();
    const replayer = await createInterceptor({
      mode: "strict_replay",
      transport,
      tracePath,
    });

    const replayed = await replayer.call(LOOKUP_COMPANY, ARGS);

    assert(
      stableEqual(replayed, recorded),
      "replayed output must equal recorded output",
    );
    assert(
      server.liveCallCount() === liveCallsBeforeReplay,
      `live tool was invoked during replay (count ${server.liveCallCount()} vs ${liveCallsBeforeReplay})`,
    );
    assert(!server.isAvailable(), "fake server must remain stopped after replay");

    console.log("VERIFY PASSED");
    console.log(
      JSON.stringify(
        {
          recorded,
          replayed,
          liveCallsDuringRecord: liveCallsAfterRecord,
          liveCallsDuringReplay: server.liveCallCount() - liveCallsBeforeReplay,
          traceEntries: entries.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
