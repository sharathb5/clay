/**
 * Phase 3 Clay record/replay verifier.
 *
 * 1. Authenticated Clay MCP tool call through interceptor (record)
 * 2. Persist normalized JSONL trace
 * 3. Terminate/close Clay session
 * 4. Remove replay access to auth credentials
 * 5. Strict replay succeeds via fail-closed transport
 * 6. Mismatch still fails explicitly
 * 7. Trace contains no auth/session field names
 */

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAY_CREDENTIALS_PATH } from "../adapters/clay-auth-store.ts";
import {
  createClayTransport,
  createFailClosedClayTransport,
} from "../adapters/clay-transport.ts";
import {
  createInterceptor,
  ReplayMismatchError,
} from "../src/interceptor.ts";
import { readTrace, stableEqual, traceExistsAndNonEmpty } from "../src/trace.ts";

const SELECTED = {
  toolName: "get-credits-available",
  args: {} as Record<string, unknown>,
  rationale:
    "Live Clay schema: no parameters; read-only workspace credit status; not enrichment or mutation",
} as const;

/** Forbidden auth/session keys that must never appear in trace JSON. */
const FORBIDDEN_TRACE_KEYS = [
  "access_token",
  "refresh_token",
  "client_secret",
  "client_id",
  "code_verifier",
  "code_challenge",
  "authorization",
  "mcp-session-id",
  "mcp_session_id",
  "session_id",
  "sessionId",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`CLAY VERIFY FAILED: ${message}`);
  }
}

function assertNoAuthMaterial(value: unknown, path: string): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoAuthMaterial(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      for (const forbidden of FORBIDDEN_TRACE_KEYS) {
        assert(
          lower !== forbidden.toLowerCase(),
          `trace contains forbidden auth/session field at ${path}.${k}`,
        );
      }
      assertNoAuthMaterial(v, `${path}.${k}`);
    }
  }
}

/** Redact obviously sensitive scalar leaves for console reporting only. */
function redactForReport(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 24 && /^[A-Za-z0-9_-]+$/.test(value)) {
      return `[redacted:${value.length}chars]`;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactForReport);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (
        lower.includes("id") ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("email") ||
        lower.includes("url")
      ) {
        out[k] = typeof v === "string" ? "[redacted]" : redactForReport(v);
      } else {
        out[k] = redactForReport(v);
      }
    }
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "clay-verify-clay-"));
  const tracePath = join(workDir, "trace.jsonl");
  const credBackup = join(workDir, "credentials.backup.json");

  // Preserve developer credentials across removeAuthAccess for local reruns.
  await copyFile(CLAY_CREDENTIALS_PATH, credBackup);

  const session = await createClayTransport({
    interactiveAuth: false,
    openBrowser: false,
  });

  try {
    const recorder = await createInterceptor({
      mode: "record",
      transport: session.transport,
      tracePath,
    });

    const recorded = await recorder.call(SELECTED.toolName, SELECTED.args);
    assert(session.liveCallCount() === 1, "expected 1 live Clay call during record");
    assert(await traceExistsAndNonEmpty(tracePath), "trace was not written");

    const entries = await readTrace(tracePath);
    assert(entries.length === 1, `expected 1 trace entry, got ${entries.length}`);
    assert(entries[0].toolName === SELECTED.toolName, "trace tool name mismatch");
    assert(stableEqual(entries[0].arguments, SELECTED.args), "trace arguments mismatch");
    assert(stableEqual(entries[0].response, recorded), "trace response mismatch");
    assertNoAuthMaterial(entries[0], "entry");

    // Ensure raw trace text has no obvious auth header / session markers.
    const { readFile } = await import("node:fs/promises");
    const rawTrace = await readFile(tracePath, "utf8");
    assert(!/access_token/i.test(rawTrace), "raw trace mentions access_token");
    assert(!/refresh_token/i.test(rawTrace), "raw trace mentions refresh_token");
    assert(!/Mcp-Session-Id/i.test(rawTrace), "raw trace mentions Mcp-Session-Id");
    assert(!/Bearer\s+\S+/i.test(rawTrace), "raw trace mentions Bearer token");
    assert(!/\.clay-auth/i.test(rawTrace), "raw trace mentions .clay-auth path");

    await session.close();
    await session.removeAuthAccess();

    let liveBlocked = false;
    try {
      await session.transport.call(SELECTED.toolName, SELECTED.args);
    } catch (err) {
      liveBlocked =
        err instanceof Error && err.message.includes("Live Clay MCP unavailable");
    }
    assert(liveBlocked, "closed Clay transport should reject live calls");

    const failClosed = createFailClosedClayTransport();
    const liveCallsBeforeReplay = session.liveCallCount();
    const replayer = await createInterceptor({
      mode: "strict_replay",
      transport: failClosed,
      tracePath,
    });

    const replayed = await replayer.call(SELECTED.toolName, SELECTED.args);
    assert(stableEqual(replayed, recorded), "replayed output must equal recorded");
    assert(
      session.liveCallCount() === liveCallsBeforeReplay,
      "live Clay was invoked during replay",
    );

    // Reordered empty object is still {}; use a real mismatch instead.
    const mismatcher = await createInterceptor({
      mode: "strict_replay",
      transport: failClosed,
      tracePath,
    });
    let mismatched = false;
    try {
      await mismatcher.call(SELECTED.toolName, { unexpected: true });
    } catch (err) {
      mismatched = err instanceof ReplayMismatchError;
    }
    assert(mismatched, "different arguments must raise ReplayMismatchError");
    assert(
      session.liveCallCount() === liveCallsBeforeReplay,
      "live Clay was invoked during mismatch attempt",
    );

    console.log("CLAY VERIFY PASSED");
    console.log(
      JSON.stringify(
        {
          tool: SELECTED.toolName,
          args: SELECTED.args,
          rationale: SELECTED.rationale,
          protocolEra: session.protocolEra() ?? null,
          recordedRedacted: redactForReport(recorded),
          replayedRedacted: redactForReport(replayed),
          liveCallsDuringRecord: 1,
          liveCallsDuringReplay: 0,
          authRemovedBeforeReplay: true,
          traceAuthClean: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await session.close().catch(() => undefined);
    // Restore credentials so the local developer store survives the isolation proof.
    await copyFile(credBackup, CLAY_CREDENTIALS_PATH).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
