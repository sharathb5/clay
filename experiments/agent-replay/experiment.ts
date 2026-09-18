/**
 * First Clay agent replay experiment.
 *
 * Order: credits before → V1 live record → close/remove auth →
 * V1 strict replay → V2 strict replay → credits after (restored auth).
 */

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAY_CREDENTIALS_PATH } from "../../adapters/clay-auth-store.ts";
import {
  createClayTransport,
  createFailClosedClayTransport,
  type ClayTransportSession,
} from "../../adapters/clay-transport.ts";
import {
  createInterceptor,
  ReplayMismatchError,
} from "../../src/interceptor.ts";
import { readTrace } from "../../src/trace.ts";
import { createOpenAiChatModel, requireOpenAiApiKey } from "./provider-openai.ts";
import { runAgent } from "./runner.ts";
import type { AgentRunResult } from "./types.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const artifactsDir = join(repoRoot, ".experiment-artifacts", "agent-replay");
const tracePath = join(artifactsDir, "v1-live.trace.jsonl");
const reportPath = join(artifactsDir, "comparison.txt");
const resultsPath = join(artifactsDir, "results.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`EXPERIMENT FAILED: ${message}`);
  }
}

function formatToolSequence(
  tools: Array<{ toolName: string; arguments?: unknown }>,
): string {
  if (tools.length === 0) return "(none)";
  return tools.map((t) => t.toolName).join(" → ");
}

function redactCredits(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactCredits);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("authorization")
    ) {
      out[k] = "[redacted]";
    } else {
      out[k] = redactCredits(v);
    }
  }
  return out;
}

async function readCredits(session: ClayTransportSession): Promise<unknown> {
  return session.transport.call("get-credits-available", {});
}

function formatRun(
  label: string,
  run: AgentRunResult | null,
  extra?: { error?: string; liveClayCalls?: number },
): string {
  const lines = [`${label}`];
  if (run) {
    lines.push(`classification: ${run.final.classification}`);
    lines.push(`tools: ${formatToolSequence(run.toolSequence)}`);
    lines.push(`model: ${run.model}`);
    lines.push(`rationale: ${run.final.rationale}`);
    lines.push(`evidence_used: ${JSON.stringify(run.final.evidence_used)}`);
    lines.push(
      `missing_evidence: ${JSON.stringify(run.final.missing_evidence)}`,
    );
  }
  if (extra?.error) {
    lines.push(`error: ${extra.error}`);
  }
  if (extra?.liveClayCalls !== undefined) {
    lines.push(`live Clay calls: ${extra.liveClayCalls}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  // Fail fast on provider before any Clay live work beyond setup intent.
  requireOpenAiApiKey();
  const model = createOpenAiChatModel();

  await mkdir(artifactsDir, { recursive: true });
  const credBackup = join(artifactsDir, "credentials.backup.json");
  await copyFile(CLAY_CREDENTIALS_PATH, credBackup);

  let creditsBefore: unknown = null;
  let creditsAfter: unknown = null;
  let v1Live: AgentRunResult | null = null;
  let v1Replay: AgentRunResult | null = null;
  let v2Replay: AgentRunResult | null = null;
  let v2Error: string | null = null;
  let liveCallsDuringV1Replay = -1;
  let liveCallsDuringV2Replay = -1;
  let outcome: "A_same_sequence" | "B_replay_mismatch" | "incomplete" =
    "incomplete";

  const liveSession = await createClayTransport({
    interactiveAuth: false,
    openBrowser: false,
  });

  try {
    // 1. Credits before (outside agent trace)
    creditsBefore = await readCredits(liveSession);
    console.error("Credits before:", JSON.stringify(redactCredits(creditsBefore)));

    const liveCallsBeforeRecord = liveSession.liveCallCount();

    // 2. V1 LIVE record
    const recorder = await createInterceptor({
      mode: "record",
      transport: liveSession.transport,
      tracePath,
    });
    v1Live = await runAgent({
      version: "v1",
      mode: "record",
      model,
      interceptor: recorder,
    });

    const clayCallsDuringRecord =
      liveSession.liveCallCount() - liveCallsBeforeRecord;
    // get-credits-available was outside interceptor; record path should be Clay tools only.
    assert(
      v1Live.toolSequence.length >= 1,
      "V1 live recorded no Clay tool calls",
    );
    console.error(
      `V1 LIVE classification=${v1Live.final.classification} tools=${formatToolSequence(v1Live.toolSequence)} clayLiveCallsInRecordWindow=${clayCallsDuringRecord}`,
    );

    const entries = await readTrace(tracePath);
    assert(entries.length === v1Live.toolSequence.length, "trace length mismatch");
    for (const entry of entries) {
      assert(
        entry.toolName === "find-and-enrich-company" ||
          entry.toolName === "get-task-context",
        `unexpected tool in trace: ${entry.toolName}`,
      );
      assert(
        !JSON.stringify(entry).includes("access_token"),
        "trace must not contain access_token",
      );
    }

    // Early credit stop: if workspace credits flipped to unavailable after record, halt.
    const creditsMid = await readCredits(liveSession);
    const beforeObj = creditsBefore as Record<string, unknown> | null;
    const midObj = creditsMid as Record<string, unknown> | null;
    if (
      beforeObj &&
      midObj &&
      beforeObj.hasWorkspaceCredits === true &&
      midObj.hasWorkspaceCredits === false
    ) {
      throw new Error(
        "STOP: find-and-enrich-company appears to have exhausted workspace credits. Halting before further live experimentation.",
      );
    }

    // 3. Terminate Clay / remove live auth access
    await liveSession.close();
    await liveSession.removeAuthAccess();

    let liveBlocked = false;
    try {
      await liveSession.transport.call("find-and-enrich-company", {
        companyIdentifier: "notion.so",
      });
    } catch (err) {
      liveBlocked =
        err instanceof Error && err.message.includes("Live Clay MCP unavailable");
    }
    assert(liveBlocked, "closed Clay transport should reject live calls");

    const failClosed = createFailClosedClayTransport();
    const liveCallsAtReplayStart = liveSession.liveCallCount();

    // 4. V1 REPLAY
    const v1Replayer = await createInterceptor({
      mode: "strict_replay",
      transport: failClosed,
      tracePath,
    });
    v1Replay = await runAgent({
      version: "v1",
      mode: "strict_replay",
      model,
      interceptor: v1Replayer,
    });
    liveCallsDuringV1Replay =
      liveSession.liveCallCount() - liveCallsAtReplayStart;
    assert(liveCallsDuringV1Replay === 0, "live Clay invoked during V1 replay");

    // 5. V2 REPLAY
    const liveCallsBeforeV2 = liveSession.liveCallCount();
    const v2Replayer = await createInterceptor({
      mode: "strict_replay",
      transport: failClosed,
      tracePath,
    });
    try {
      v2Replay = await runAgent({
        version: "v2",
        mode: "strict_replay",
        model,
        interceptor: v2Replayer,
      });
      outcome = "A_same_sequence";
    } catch (err) {
      if (err instanceof ReplayMismatchError) {
        v2Error = err.message;
        outcome = "B_replay_mismatch";
      } else {
        throw err;
      }
    }
    liveCallsDuringV2Replay = liveSession.liveCallCount() - liveCallsBeforeV2;
    assert(liveCallsDuringV2Replay === 0, "live Clay invoked during V2 replay");
  } finally {
    await liveSession.close().catch(() => undefined);
    // Restore credentials so credits-after and future local use work.
    await copyFile(credBackup, CLAY_CREDENTIALS_PATH).catch(() => undefined);
  }

  // 6. Credits after (restored auth; outside agent trace)
  const afterSession = await createClayTransport({
    interactiveAuth: false,
    openBrowser: false,
  });
  try {
    creditsAfter = await readCredits(afterSession);
  } finally {
    await afterSession.close();
  }

  const comparison = [
    "TRACE",
    `${(await readTrace(tracePath)).length} recorded Clay calls`,
    formatToolSequence(
      (await readTrace(tracePath)).map((e) => ({ toolName: e.toolName })),
    ),
    "",
    formatRun("V1 LIVE", v1Live),
    "",
    formatRun("V1 REPLAY", v1Replay, {
      liveClayCalls: liveCallsDuringV1Replay,
    }),
    "",
    v2Replay
      ? formatRun("V2 REPLAY", v2Replay, {
          liveClayCalls: liveCallsDuringV2Replay,
        })
      : [
          "V2 REPLAY",
          `live Clay calls: ${liveCallsDuringV2Replay}`,
          `ReplayMismatchError: ${v2Error}`,
        ].join("\n"),
    "",
    `OUTCOME: ${outcome}`,
    outcome === "A_same_sequence"
      ? "Behavior compared with the Clay environment held fixed."
      : "V2 tool strategy diverged; strict replay surfaced the mismatch (no live fallback).",
    "",
    "CREDITS (outside agent trace)",
    `before: ${JSON.stringify(redactCredits(creditsBefore))}`,
    `after:  ${JSON.stringify(redactCredits(creditsAfter))}`,
    "",
    "NONDETERMINISM NOTES",
    v1Live && v1Replay
      ? [
          `V1 live classification: ${v1Live.final.classification}`,
          `V1 replay classification: ${v1Replay.final.classification}`,
          `V1 live tools: ${formatToolSequence(v1Live.toolSequence)}`,
          `V1 replay tools: ${formatToolSequence(v1Replay.toolSequence)}`,
          v1Live.final.classification === v1Replay.final.classification
            ? "Classification matched across V1 live vs replay (model may still differ in rationale text)."
            : "Classification differed across V1 live vs replay — model nondeterminism observed.",
          v1Live.final.rationale === v1Replay.final.rationale
            ? "Rationale text identical."
            : "Rationale text differed (expected under model nondeterminism; tool env still frozen).",
        ].join("\n")
      : "V1 replay did not complete.",
  ].join("\n");

  await writeFile(reportPath, `${comparison}\n`, "utf8");
  await writeFile(
    resultsPath,
    `${JSON.stringify(
      {
        provider: "openai",
        model: model.model,
        outcome,
        creditsBefore: redactCredits(creditsBefore),
        creditsAfter: redactCredits(creditsAfter),
        v1Live,
        v1Replay,
        v2Replay,
        v2Error,
        liveCallsDuringV1Replay,
        liveCallsDuringV2Replay,
        tracePath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(comparison);
  console.error(`\nWrote ${reportPath}`);
  console.error(`Wrote ${resultsPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
