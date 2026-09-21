/**
 * Deterministic Clay recorder for the agent benchmark (ADR-024).
 *
 * For each case:
 *   find-and-enrich-company({ companyIdentifier: domain })
 *   → get-task-context({ taskId })
 *
 * No live agent. No gold labels. No V1/V2.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClayTransport } from "../../adapters/clay-transport.ts";
import { createInterceptor } from "../../src/interceptor.ts";
import { readTrace } from "../../src/trace.ts";
import {
  BENCHMARK_CASES,
  EXPECTED_TOOL_SEQUENCE,
  PROTOCOL_VERSION,
  type BenchmarkCase,
} from "./cases.ts";
import { deriveEvidenceCard, type EvidenceCard } from "./evidence-card.ts";
import { sha256File } from "./seal.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const artifactsRoot = join(repoRoot, ".experiment-artifacts", "agent-benchmark");

/** Optional `--only <id>[,<id>…]` to record a subset without touching other freezes. */
function casesToRecord(): BenchmarkCase[] {
  const onlyIdx = process.argv.indexOf("--only");
  if (onlyIdx < 0) {
    return [...BENCHMARK_CASES];
  }
  const raw = process.argv[onlyIdx + 1];
  if (!raw) {
    throw new Error("Usage: record.ts [--only <caseId>[,<caseId>…]]");
  }
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const selected: BenchmarkCase[] = [];
  for (const id of ids) {
    const found = BENCHMARK_CASES.find((c) => c.id === id);
    if (!found) {
      throw new Error(
        `Unknown case id "${id}". Active cases: ${BENCHMARK_CASES.map((c) => c.id).join(", ")}`,
      );
    }
    selected.push(found);
  }
  return selected;
}

export interface CaseRecordingResult {
  caseId: string;
  domain: string;
  slot: BenchmarkCase["slot"];
  slotRationale: string;
  succeeded: boolean;
  toolSequence: string[];
  frozenTracePath: string;
  frozenTraceSha256: string | null;
  evidenceCardPath: string | null;
  evidenceCard: EvidenceCard | null;
  clayCallsForCase: number;
  error: string | null;
}

export interface RecordingSessionReport {
  protocolVersion: typeof PROTOCOL_VERSION;
  recordedAt: string;
  artifactsRoot: string;
  creditsBefore: unknown;
  creditsAfter: unknown;
  totalClayToolCallsInTraces: number;
  totalLiveClayCallsIncludingCredits: number;
  cases: CaseRecordingResult[];
  agentRunsExecuted: 0;
  goldLabelsAssigned: 0;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`BENCHMARK RECORD FAILED: ${message}`);
  }
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

function extractTaskId(response: unknown): string {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("find-and-enrich-company response is not an object");
  }
  const taskId = (response as Record<string, unknown>).taskId;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("find-and-enrich-company response missing taskId");
  }
  return taskId;
}

function caseDir(caseId: string): string {
  return join(artifactsRoot, "cases", caseId);
}

async function recordOneCase(
  c: BenchmarkCase,
  transportCall: (toolName: string, args: unknown) => Promise<unknown>,
): Promise<CaseRecordingResult> {
  const dir = caseDir(c.id);
  await mkdir(dir, { recursive: true });
  const frozenTracePath = join(dir, "frozen.trace.jsonl");
  const evidenceCardPath = join(dir, "evidence-card.json");

  const base: CaseRecordingResult = {
    caseId: c.id,
    domain: c.domain,
    slot: c.slot,
    slotRationale: c.slotRationale,
    succeeded: false,
    toolSequence: [],
    frozenTracePath,
    frozenTraceSha256: null,
    evidenceCardPath: null,
    evidenceCard: null,
    clayCallsForCase: 0,
    error: null,
  };

  try {
    const interceptor = await createInterceptor({
      mode: "record",
      transport: { call: transportCall },
      tracePath: frozenTracePath,
    });

    const findResponse = await interceptor.call("find-and-enrich-company", {
      companyIdentifier: c.domain,
    });
    const taskId = extractTaskId(findResponse);
    await interceptor.call("get-task-context", { taskId });

    const entries = await readTrace(frozenTracePath);
    assert(
      entries.length === EXPECTED_TOOL_SEQUENCE.length,
      `${c.id}: expected ${EXPECTED_TOOL_SEQUENCE.length} trace entries, got ${entries.length}`,
    );
    for (let i = 0; i < EXPECTED_TOOL_SEQUENCE.length; i += 1) {
      assert(
        entries[i].toolName === EXPECTED_TOOL_SEQUENCE[i],
        `${c.id}: tool sequence mismatch at ${i}: ${entries[i].toolName}`,
      );
    }
    assert(
      !JSON.stringify(entries).includes("access_token"),
      `${c.id}: trace must not contain access_token`,
    );

    const frozenTraceSha256 = await sha256File(frozenTracePath);
    const evidenceCard = deriveEvidenceCard({
      caseId: c.id,
      requestedDomain: c.domain,
      frozenTraceSha256,
      entries,
    });
    await writeFile(
      evidenceCardPath,
      `${JSON.stringify(evidenceCard, null, 2)}\n`,
      "utf8",
    );

    return {
      ...base,
      succeeded: true,
      toolSequence: entries.map((e) => e.toolName),
      frozenTraceSha256,
      evidenceCardPath,
      evidenceCard,
      clayCallsForCase: entries.length,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  await mkdir(artifactsRoot, { recursive: true });
  const selectedCases = casesToRecord();
  console.error(
    `Recording ${selectedCases.length} case(s): ${selectedCases.map((c) => c.id).join(", ")}`,
  );

  // Interactive auth allowed: recording is an operator session; stale tokens
  // must be able to complete PKCE re-consent (same as clay:list-tools).
  const session = await createClayTransport({
    interactiveAuth: true,
    openBrowser: true,
  });

  let creditsBefore: unknown = null;
  let creditsAfter: unknown = null;
  const caseResults: CaseRecordingResult[] = [];
  let totalClayToolCallsInTraces = 0;
  let totalLiveClayCallsIncludingCredits = 0;

  try {
    creditsBefore = await session.transport.call("get-credits-available", {});
    console.error(
      "Credits before:",
      JSON.stringify(redactCredits(creditsBefore)),
    );

    for (const c of selectedCases) {
      console.error(`\nRecording ${c.id} (${c.domain})…`);
      const before = session.liveCallCount();
      const result = await recordOneCase(c, (toolName, args) =>
        session.transport.call(toolName, args),
      );
      const after = session.liveCallCount();
      // Prefer interceptor-counted sequence length; fall back to live delta.
      if (result.succeeded) {
        totalClayToolCallsInTraces += result.clayCallsForCase;
      } else {
        result.clayCallsForCase = after - before;
      }
      caseResults.push(result);
      if (result.succeeded) {
        console.error(
          `  ok sha256=${result.frozenTraceSha256} tools=${result.toolSequence.join(" → ")}`,
        );
      } else {
        console.error(`  FAILED: ${result.error}`);
      }

      // Early stop if workspace credits flipped unavailable.
      const mid = await session.transport.call("get-credits-available", {});
      const beforeObj = creditsBefore as Record<string, unknown> | null;
      const midObj = mid as Record<string, unknown> | null;
      if (
        beforeObj &&
        midObj &&
        beforeObj.hasWorkspaceCredits === true &&
        midObj.hasWorkspaceCredits === false
      ) {
        throw new Error(
          "STOP: workspace credits appear exhausted mid-recording. Halting.",
        );
      }
    }

    creditsAfter = await session.transport.call("get-credits-available", {});
    totalLiveClayCallsIncludingCredits = session.liveCallCount();
  } finally {
    await session.close().catch(() => undefined);
  }

  const report: RecordingSessionReport = {
    protocolVersion: PROTOCOL_VERSION,
    recordedAt: new Date().toISOString(),
    artifactsRoot,
    creditsBefore: redactCredits(creditsBefore),
    creditsAfter: redactCredits(creditsAfter),
    totalClayToolCallsInTraces,
    totalLiveClayCallsIncludingCredits,
    cases: caseResults,
    agentRunsExecuted: 0,
    goldLabelsAssigned: 0,
  };

  // Subset runs write a separate report so full-session metadata stays intact.
  const reportName =
    selectedCases.length === BENCHMARK_CASES.length
      ? "recording-session.json"
      : `recording-session-${selectedCases.map((c) => c.id).join("-")}.json`;
  const reportPath = join(artifactsRoot, reportName);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  // Operator-facing summary (stdout).
  const lines: string[] = [
    "BENCHMARK RECORDING SESSION",
    `protocol: ${PROTOCOL_VERSION}`,
    `artifacts: ${artifactsRoot}`,
    `agent runs: 0`,
    `gold labels assigned: 0`,
    `total Clay tool calls in traces: ${totalClayToolCallsInTraces}`,
    `total live Clay calls (incl. credits probes): ${totalLiveClayCallsIncludingCredits}`,
    `credits before: ${JSON.stringify(redactCredits(creditsBefore))}`,
    `credits after:  ${JSON.stringify(redactCredits(creditsAfter))}`,
    "",
  ];

  for (const r of caseResults) {
    lines.push(`## ${r.domain} (${r.caseId})`);
    lines.push(`slot: ${r.slot} — ${r.slotRationale}`);
    lines.push(`succeeded: ${r.succeeded}`);
    lines.push(`tool sequence: ${r.toolSequence.join(" → ") || "(none)"}`);
    lines.push(`trace sha256: ${r.frozenTraceSha256 ?? "(none)"}`);
    if (r.error) lines.push(`error: ${r.error}`);
    if (r.evidenceCard) {
      const e = r.evidenceCard;
      lines.push(
        `identity match: ${String(e.identity.appearsToMatchRequestedDomain)}`,
      );
      lines.push(
        `sufficient for rubric: ${String(e.sufficiency.appearsSufficientForRubric)}`,
      );
      lines.push(
        `missing/ambiguous: ${e.sufficiency.missingOrAmbiguousFields.join(", ") || "(none)"}`,
      );
      lines.push(`evidence card: ${r.evidenceCardPath}`);
    }
    lines.push("");
  }

  console.log(lines.join("\n"));
  console.error(`Wrote ${reportPath}`);

  if (caseResults.some((r) => !r.succeeded)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
