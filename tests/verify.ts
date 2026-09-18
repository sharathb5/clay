/**
 * End-to-end invariant proof for Phase 2 (MCP stdio boundary).
 *
 * 1. Start local MCP server via transport adapter
 * 2. Record a real MCP tool call through the interceptor
 * 3. Persist + confirm recorded output
 * 4. Fully stop the MCP process
 * 5. Prove a direct live call can no longer succeed
 * 6. Strict replay returns the recorded result
 * 7. Confirm zero live MCP calls during replay
 * 8. Reordered equivalent object keys also replay successfully
 * 9. Meaningfully different arguments fail with ReplayMismatchError
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpTransport } from "../adapters/mcp-transport.ts";
import { LOOKUP_COMPANY } from "../fixtures/tools.ts";
import {
  createInterceptor,
  ReplayMismatchError,
} from "../src/interceptor.ts";
import { readTrace, stableEqual, traceExistsAndNonEmpty } from "../src/trace.ts";

const ARGS = { name: "Linear", limit: 5 } as const;
const ARGS_REORDERED = { limit: 5, name: "Linear" } as const;
const ARGS_MISMATCH = { name: "Linear", limit: 10 } as const;

const EXPECTED_RESPONSE = {
  name: "Linear",
  limit: 5,
  employeeCount: 150,
  industry: "Software",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`VERIFY FAILED: ${message}`);
  }
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "clay-verify-"));
  const tracePath = join(workDir, "trace.jsonl");
  const session = await createMcpTransport();

  try {
    // --- Record ---
    const recorder = await createInterceptor({
      mode: "record",
      transport: session.transport,
      tracePath,
    });

    const recorded = await recorder.call(LOOKUP_COMPANY, ARGS);
    const liveCallsAfterRecord = session.liveCallCount();
    assert(
      liveCallsAfterRecord === 1,
      `expected 1 live MCP call during record, got ${liveCallsAfterRecord}`,
    );
    assert(
      stableEqual(recorded, EXPECTED_RESPONSE),
      "recorded response mismatch",
    );

    assert(await traceExistsAndNonEmpty(tracePath), "trace was not written");
    const entries = await readTrace(tracePath);
    assert(entries.length === 1, `expected 1 trace entry, got ${entries.length}`);
    assert(entries[0].toolName === LOOKUP_COMPANY, "trace tool name mismatch");
    assert(stableEqual(entries[0].arguments, ARGS), "trace arguments mismatch");
    assert(stableEqual(entries[0].response, recorded), "trace response mismatch");

    // --- Make live MCP execution impossible ---
    await session.close();

    let liveBlocked = false;
    try {
      await session.transport.call(LOOKUP_COMPANY, ARGS);
    } catch (err) {
      liveBlocked =
        err instanceof Error && err.message.includes("Live MCP unavailable");
    }
    assert(liveBlocked, "closed MCP transport should throw on live call");

    // --- Strict replay ---
    const liveCallsBeforeReplay = session.liveCallCount();
    const replayer = await createInterceptor({
      mode: "strict_replay",
      transport: session.transport,
      tracePath,
    });

    const replayed = await replayer.call(LOOKUP_COMPANY, ARGS);
    assert(
      stableEqual(replayed, recorded),
      "replayed output must equal recorded output",
    );
    assert(
      session.liveCallCount() === liveCallsBeforeReplay,
      `live MCP was invoked during replay (count ${session.liveCallCount()} vs ${liveCallsBeforeReplay})`,
    );

    // --- Reordered keys must also match (structural equality) ---
    const replayerKeys = await createInterceptor({
      mode: "strict_replay",
      transport: session.transport,
      tracePath,
    });
    const replayedReordered = await replayerKeys.call(
      LOOKUP_COMPANY,
      ARGS_REORDERED,
    );
    assert(
      stableEqual(replayedReordered, recorded),
      "reordered-key replay must equal recorded output",
    );
    assert(
      session.liveCallCount() === liveCallsBeforeReplay,
      "live MCP was invoked during reordered-key replay",
    );

    // --- Genuine mismatch ---
    const mismatcher = await createInterceptor({
      mode: "strict_replay",
      transport: session.transport,
      tracePath,
    });
    let mismatched = false;
    try {
      await mismatcher.call(LOOKUP_COMPANY, ARGS_MISMATCH);
    } catch (err) {
      mismatched = err instanceof ReplayMismatchError;
    }
    assert(mismatched, "different arguments must raise ReplayMismatchError");
    assert(
      session.liveCallCount() === liveCallsBeforeReplay,
      "live MCP was invoked during mismatch attempt",
    );

    console.log("VERIFY PASSED");
    console.log(
      JSON.stringify(
        {
          recorded,
          replayed,
          replayedReordered,
          liveCallsDuringRecord: liveCallsAfterRecord,
          liveCallsDuringReplay: session.liveCallCount() - liveCallsBeforeReplay,
          traceEntries: entries.length,
          mismatchRaised: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await session.close().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
