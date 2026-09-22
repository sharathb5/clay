/**
 * Frozen-trace agent benchmark runner (benchmark v1).
 *
 * Replay-only evaluation of V1/V2 against sealed human gold.
 * No live Clay. No re-recording. No policy/ICP mutation.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFailClosedClayTransport } from "../../adapters/clay-transport.ts";
import {
  createInterceptor,
  ReplayMismatchError,
} from "../../src/interceptor.ts";
import type { Transport } from "../../src/types.ts";
import {
  createOpenRouterChatModel,
  getOpenRouterGenerationSettings,
  requireOpenRouterApiKey,
  type OpenRouterGenerationSettings,
} from "../agent-replay/provider-openrouter.ts";
import {
  V1_SYSTEM_PROMPT,
  V2_SYSTEM_PROMPT,
  ICP_DESCRIPTION,
} from "../agent-replay/policies.ts";
import { runAgent } from "../agent-replay/runner.ts";
import type {
  AgentRunResult,
  AgentVersion,
  Classification,
  ObservedToolCall,
  TokenUsage,
} from "../agent-replay/types.ts";
import { EXPECTED_TOOL_SEQUENCE } from "./cases.ts";
import { assertFrozenTraceSha256 } from "./integrity.ts";
import {
  loadBenchmarkManifest,
  MANIFEST_PATH,
  type BenchmarkManifest,
  type ManifestCase,
} from "./manifest.ts";
import { sha256File } from "./seal.ts";
import {
  accuracyRate,
  classificationMatchesGold,
  distinctClassificationCount,
  emptyClassificationCounts,
  modalClassification,
  modalShare,
} from "./score.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACTS_ROOT = join(repoRoot, ".experiment-artifacts", "agent-benchmark");

const CLASSIFICATIONS: Classification[] = [
  "strong_fit",
  "medium_fit",
  "weak_fit",
  "unclear",
];

interface RunArtifact {
  caseId: string;
  domain: string;
  runIndex: number;
  agentVersion: AgentVersion;
  status: "ok" | "mismatch" | "error";
  gold_label: Classification;
  classification: Classification | null;
  matches_gold: boolean;
  rationale: string | null;
  evidence_used: string[] | null;
  missing_evidence: string[] | null;
  toolSequence: ObservedToolCall[];
  toolSequenceLabel: string;
  matchesExpectedSequence: boolean;
  mismatch: {
    message: string;
    expected?: unknown;
    attempted?: unknown;
  } | null;
  error: string | null;
  model: string;
  generation: OpenRouterGenerationSettings;
  usage: TokenUsage | null;
  liveClayTransportCalls: number;
  frozenTraceSha256: string;
}

interface CasePolicyAggregate {
  caseId: string;
  domain: string;
  gold_label: Classification;
  runs: number;
  successful: number;
  failed: number;
  classifications: Record<Classification, number>;
  correct: number;
  accuracy: number | null;
  modal: Classification | null;
  modal_matches_gold: boolean | null;
  modal_share: number | null;
  distinct_classifications: number;
  tool_sequence_stable: number;
  mismatches: number;
  errors: number;
}

interface PolicyAggregate {
  version: AgentVersion;
  total_runs: number;
  successful: number;
  failed: number;
  correct: number;
  accuracy: number | null;
  modal_label_correct_cases: number;
  modal_label_accuracy: number | null;
  mismatches: number;
  errors: number;
  tool_sequence_stable: number;
  liveClayCalls: number;
  usage: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    average_tokens_per_run: number | null;
    total_cost: number | null;
    runs_with_usage: number;
  };
  cases: CasePolicyAggregate[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`BENCHMARK FAILED: ${message}`);
  }
}

function parseRunsArg(argv: string[]): number {
  const idx = argv.indexOf("--runs");
  if (idx === -1) return 5;
  const raw = argv[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --runs value: ${raw}`);
  }
  return n;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function formatToolSequence(tools: ObservedToolCall[]): string {
  if (tools.length === 0) return "(none)";
  return tools.map((t) => t.toolName).join(" → ");
}

function matchesExpectedSequence(tools: ObservedToolCall[]): boolean {
  if (tools.length !== EXPECTED_TOOL_SEQUENCE.length) return false;
  return EXPECTED_TOOL_SEQUENCE.every((name, i) => tools[i]?.toolName === name);
}

function createCountingFailClosedTransport(): {
  transport: Transport;
  liveCallCount: () => number;
} {
  const inner = createFailClosedClayTransport();
  let calls = 0;
  return {
    transport: {
      async call(toolName, args) {
        calls += 1;
        return inner.call(toolName, args);
      },
    },
    liveCallCount: () => calls,
  };
}

function extractMismatchDetail(message: string): {
  expected?: unknown;
  attempted?: unknown;
} {
  const match = message.match(/expected ({[\s\S]*?}), got ({[\s\S]*})/);
  if (!match) return {};
  try {
    return {
      expected: JSON.parse(match[1]),
      attempted: JSON.parse(match[2]),
    };
  } catch {
    return {};
  }
}

function frozenTracePath(caseId: string): string {
  return join(ARTIFACTS_ROOT, "cases", caseId, "frozen.trace.jsonl");
}

async function verifyTraceHash(
  caseId: string,
  expectedSha: string,
): Promise<string> {
  return assertFrozenTraceSha256(frozenTracePath(caseId), expectedSha);
}

async function runOne(options: {
  c: ManifestCase;
  version: AgentVersion;
  runIndex: number;
  model: ReturnType<typeof createOpenRouterChatModel>;
  settings: OpenRouterGenerationSettings;
  live: { transport: Transport; liveCallCount: () => number };
}): Promise<RunArtifact> {
  const { c, version, runIndex, model, settings, live } = options;
  const tracePath = frozenTracePath(c.id);
  const callsBefore = live.liveCallCount();

  // Fresh interceptor → fresh replay cursor; never share across runs.
  const interceptor = await createInterceptor({
    mode: "strict_replay",
    transport: live.transport,
    tracePath,
  });

  try {
    const result: AgentRunResult = await runAgent({
      version,
      model,
      interceptor,
      companyDomain: c.domain,
    });
    const liveClayTransportCalls = live.liveCallCount() - callsBefore;
    assert(
      liveClayTransportCalls === 0,
      `live Clay transport invoked during ${c.id}/${version} run ${runIndex}`,
    );
    return {
      caseId: c.id,
      domain: c.domain,
      runIndex,
      agentVersion: version,
      status: "ok",
      gold_label: c.gold_label,
      classification: result.final.classification,
      matches_gold: classificationMatchesGold(
        result.final.classification,
        c.gold_label,
      ),
      rationale: result.final.rationale,
      evidence_used: result.final.evidence_used,
      missing_evidence: result.final.missing_evidence,
      toolSequence: result.toolSequence,
      toolSequenceLabel: formatToolSequence(result.toolSequence),
      matchesExpectedSequence: matchesExpectedSequence(result.toolSequence),
      mismatch: null,
      error: null,
      model: result.model,
      generation: settings,
      usage: result.usage ?? null,
      liveClayTransportCalls,
      frozenTraceSha256: c.frozen_trace_sha256,
    };
  } catch (err) {
    const liveClayTransportCalls = live.liveCallCount() - callsBefore;
    assert(
      liveClayTransportCalls === 0,
      `live Clay transport invoked during ${c.id}/${version} run ${runIndex} (error path)`,
    );
    if (err instanceof ReplayMismatchError) {
      return {
        caseId: c.id,
        domain: c.domain,
        runIndex,
        agentVersion: version,
        status: "mismatch",
        gold_label: c.gold_label,
        classification: null,
        matches_gold: false,
        rationale: null,
        evidence_used: null,
        missing_evidence: null,
        toolSequence: [],
        toolSequenceLabel: "(mismatch before finish)",
        matchesExpectedSequence: false,
        mismatch: {
          message: err.message,
          ...extractMismatchDetail(err.message),
        },
        error: null,
        model: model.model,
        generation: settings,
        usage: null,
        liveClayTransportCalls,
        frozenTraceSha256: c.frozen_trace_sha256,
      };
    }
    return {
      caseId: c.id,
      domain: c.domain,
      runIndex,
      agentVersion: version,
      status: "error",
      gold_label: c.gold_label,
      classification: null,
      matches_gold: false,
      rationale: null,
      evidence_used: null,
      missing_evidence: null,
      toolSequence: [],
      toolSequenceLabel: "(error)",
      matchesExpectedSequence: false,
      mismatch: null,
      error: err instanceof Error ? err.message : String(err),
      model: model.model,
      generation: settings,
      usage: null,
      liveClayTransportCalls,
      frozenTraceSha256: c.frozen_trace_sha256,
    };
  }
}

async function writeRunArtifact(artifact: RunArtifact): Promise<void> {
  const dir = join(
    ARTIFACTS_ROOT,
    "cases",
    artifact.caseId,
    "runs",
    artifact.agentVersion,
  );
  await mkdir(dir, { recursive: true });
  const name = `run-${String(artifact.runIndex).padStart(2, "0")}.json`;
  await writeFile(
    join(dir, name),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
}

function aggregateCasePolicy(
  c: ManifestCase,
  runs: RunArtifact[],
): CasePolicyAggregate {
  const classifications = emptyClassificationCounts();
  let correct = 0;
  let successful = 0;
  let failed = 0;
  let mismatches = 0;
  let errors = 0;
  let tool_sequence_stable = 0;

  for (const run of runs) {
    if (run.status === "ok") successful += 1;
    else failed += 1;
    if (run.status === "mismatch") mismatches += 1;
    if (run.status === "error") errors += 1;
    if (run.matchesExpectedSequence) tool_sequence_stable += 1;
    if (run.classification) {
      classifications[run.classification] += 1;
    }
    if (run.matches_gold) correct += 1;
  }

  const modal = modalClassification(classifications);
  return {
    caseId: c.id,
    domain: c.domain,
    gold_label: c.gold_label,
    runs: runs.length,
    successful,
    failed,
    classifications,
    correct,
    accuracy: accuracyRate(correct, runs.length),
    modal,
    modal_matches_gold: modal === null ? null : modal === c.gold_label,
    modal_share: modalShare(classifications, runs.length),
    distinct_classifications: distinctClassificationCount(classifications),
    tool_sequence_stable,
    mismatches,
    errors,
  };
}

function aggregatePolicy(
  version: AgentVersion,
  cases: ManifestCase[],
  allRuns: RunArtifact[],
  liveClayCalls: number,
): PolicyAggregate {
  const versionRuns = allRuns.filter((r) => r.agentVersion === version);
  const caseAggs = cases.map((c) =>
    aggregateCasePolicy(
      c,
      versionRuns.filter((r) => r.caseId === c.id),
    ),
  );

  let correct = 0;
  let successful = 0;
  let failed = 0;
  let mismatches = 0;
  let errors = 0;
  let tool_sequence_stable = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let costPresent = false;
  let runsWithUsage = 0;
  let modal_label_correct_cases = 0;

  for (const run of versionRuns) {
    if (run.status === "ok") successful += 1;
    else failed += 1;
    if (run.status === "mismatch") mismatches += 1;
    if (run.status === "error") errors += 1;
    if (run.matchesExpectedSequence) tool_sequence_stable += 1;
    if (run.matches_gold) correct += 1;
    if (run.usage) {
      runsWithUsage += 1;
      totalPrompt += run.usage.prompt_tokens;
      totalCompletion += run.usage.completion_tokens;
      totalTokens += run.usage.total_tokens;
      if (run.usage.cost !== undefined) {
        costPresent = true;
        totalCost += run.usage.cost;
      }
    }
  }

  for (const agg of caseAggs) {
    if (agg.modal_matches_gold === true) modal_label_correct_cases += 1;
  }

  return {
    version,
    total_runs: versionRuns.length,
    successful,
    failed,
    correct,
    accuracy: accuracyRate(correct, versionRuns.length),
    modal_label_correct_cases,
    modal_label_accuracy: accuracyRate(
      modal_label_correct_cases,
      cases.length,
    ),
    mismatches,
    errors,
    tool_sequence_stable,
    liveClayCalls,
    usage: {
      total_prompt_tokens: totalPrompt,
      total_completion_tokens: totalCompletion,
      total_tokens: totalTokens,
      average_tokens_per_run:
        runsWithUsage === 0 ? null : Math.round(totalTokens / runsWithUsage),
      total_cost: costPresent ? totalCost : null,
      runs_with_usage: runsWithUsage,
    },
    cases: caseAggs,
  };
}

function formatDist(counts: Record<Classification, number>): string {
  return CLASSIFICATIONS.map((c) => `${c}=${counts[c]}`).join(" ");
}

function formatCliReport(options: {
  manifest: BenchmarkManifest;
  runsPerPolicy: number;
  integrity: Record<string, unknown>;
  v1: PolicyAggregate;
  v2: PolicyAggregate;
}): string {
  const { manifest, runsPerPolicy, integrity, v1, v2 } = options;
  const lines: string[] = [
    "AGENT BENCHMARK V1",
    `gold_version: ${manifest.gold_version}`,
    `protocol_version: ${manifest.protocol_version}`,
    `cases: ${manifest.cases.length}`,
    `runs per policy per case: ${runsPerPolicy}`,
    `intended total runs: ${manifest.cases.length * 2 * runsPerPolicy}`,
    "",
    "Integrity",
    `gold_manifest_sha256: ${integrity.goldManifestSha256}`,
    `v1_policy_sha256: ${integrity.v1PolicySha256}`,
    `v2_policy_sha256: ${integrity.v2PolicySha256}`,
    `icp_sha256: ${integrity.icpSha256}`,
    `traces_unchanged: ${integrity.tracesUnchanged}`,
    `policies_unchanged: ${integrity.policiesUnchanged}`,
    `gold_unchanged: ${integrity.goldUnchanged}`,
    `live_clay_calls: ${integrity.liveClayCalls}`,
    "",
    `Provider: ${manifest.generation_settings.provider}`,
    `Model: ${manifest.generation_settings.model}`,
    `temperature: ${manifest.generation_settings.temperature}`,
    `seed: ${manifest.generation_settings.seed}`,
    `max_tokens: ${manifest.generation_settings.max_tokens}`,
    `tool_choice: ${manifest.generation_settings.tool_choice}`,
    "",
    "Per-case",
  ];

  for (const c of manifest.cases) {
    const a1 = v1.cases.find((x) => x.caseId === c.id)!;
    const a2 = v2.cases.find((x) => x.caseId === c.id)!;
    lines.push(
      `${c.domain}  gold=${c.gold_label}`,
      `  V1 dist=[${formatDist(a1.classifications)}] acc=${a1.correct}/${a1.runs} (${a1.accuracy}%) modal=${a1.modal} share=${a1.modal_share}% distinct=${a1.distinct_classifications}`,
      `  V2 dist=[${formatDist(a2.classifications)}] acc=${a2.correct}/${a2.runs} (${a2.accuracy}%) modal=${a2.modal} share=${a2.modal_share}% distinct=${a2.distinct_classifications}`,
    );
  }

  lines.push(
    "",
    "Aggregate V1",
    `correct: ${v1.correct}/${v1.total_runs} (${v1.accuracy}%)`,
    `modal-label accuracy: ${v1.modal_label_correct_cases}/${manifest.cases.length} (${v1.modal_label_accuracy}%)`,
    `successful/failed: ${v1.successful}/${v1.failed}`,
    `tool-sequence stable: ${v1.tool_sequence_stable}/${v1.total_runs}`,
    `replay mismatches: ${v1.mismatches}`,
    `tokens: ${v1.usage.total_tokens} (avg ${v1.usage.average_tokens_per_run}/run)`,
    `cost: ${v1.usage.total_cost ?? "(not reported)"}`,
    "",
    "Aggregate V2",
    `correct: ${v2.correct}/${v2.total_runs} (${v2.accuracy}%)`,
    `modal-label accuracy: ${v2.modal_label_correct_cases}/${manifest.cases.length} (${v2.modal_label_accuracy}%)`,
    `successful/failed: ${v2.successful}/${v2.failed}`,
    `tool-sequence stable: ${v2.tool_sequence_stable}/${v2.total_runs}`,
    `replay mismatches: ${v2.mismatches}`,
    `tokens: ${v2.usage.total_tokens} (avg ${v2.usage.average_tokens_per_run}/run)`,
    `cost: ${v2.usage.total_cost ?? "(not reported)"}`,
    "",
    "Interpretation",
    "Environment variance: removed by frozen-trace strict replay.",
    "Model variance: variation within repeated runs of one policy.",
    "Policy effect: observed difference between V1 and V2 under fixed evidence.",
    "Correctness: agreement with sealed human gold labels only.",
    "Six cases × five runs; no statistical significance claimed.",
  );

  return lines.join("\n");
}

async function main(): Promise<void> {
  const runsPerPolicy = parseRunsArg(process.argv.slice(2));
  requireOpenRouterApiKey();

  const manifest = await loadBenchmarkManifest();
  assert(
    manifest.icp === ICP_DESCRIPTION,
    "manifest ICP must match policies.ICP_DESCRIPTION",
  );

  const settings = getOpenRouterGenerationSettings({
    model: manifest.generation_settings.model,
  });
  assert(
    settings.model === manifest.generation_settings.model,
    "model must match sealed generation_settings",
  );
  assert(settings.temperature === "unset", "temperature must remain unset");
  assert(settings.seed === "unset", "seed must remain unset");
  assert(
    settings.max_tokens === manifest.generation_settings.max_tokens,
    "max_tokens must match sealed generation_settings",
  );
  assert(settings.tool_choice === "auto", "tool_choice must remain auto");

  const model = createOpenRouterChatModel({ model: settings.model });

  const goldManifestSha256Before = await sha256File(MANIFEST_PATH);
  const v1PolicySha256Before = sha256Text(V1_SYSTEM_PROMPT);
  const v2PolicySha256Before = sha256Text(V2_SYSTEM_PROMPT);
  const icpSha256Before = sha256Text(ICP_DESCRIPTION);

  const traceHashesBefore: Record<string, string> = {};
  for (const c of manifest.cases) {
    traceHashesBefore[c.id] = await verifyTraceHash(c.id, c.frozen_trace_sha256);
  }

  const live = createCountingFailClosedTransport();
  const allRuns: RunArtifact[] = [];

  console.error(
    `AGENT BENCHMARK: ${manifest.cases.length} cases × 2 policies × ${runsPerPolicy} runs`,
  );
  console.error(`gold: ${manifest.gold_version} sha256=${goldManifestSha256Before}`);
  console.error(
    `model: ${settings.provider}/${settings.model} temperature=${settings.temperature} seed=${settings.seed} max_tokens=${settings.max_tokens}`,
  );

  // Sequential: case → policy → runs (isolation-first for benchmark v1).
  for (const c of manifest.cases) {
    for (const version of ["v1", "v2"] as const) {
      for (let i = 1; i <= runsPerPolicy; i += 1) {
        console.error(`${c.domain} ${version} run ${i}/${runsPerPolicy}…`);
        const artifact = await runOne({
          c,
          version,
          runIndex: i,
          model,
          settings,
          live,
        });
        allRuns.push(artifact);
        await writeRunArtifact(artifact);
        console.error(
          `  → ${artifact.status}${artifact.classification ? ` ${artifact.classification}` : ""}${artifact.matches_gold ? " ✓gold" : ""} tools=${artifact.toolSequenceLabel}`,
        );
      }
    }
  }

  // Post-run integrity: traces, policies, gold must be unchanged; live Clay = 0.
  const goldManifestSha256After = await sha256File(MANIFEST_PATH);
  const v1PolicySha256After = sha256Text(V1_SYSTEM_PROMPT);
  const v2PolicySha256After = sha256Text(V2_SYSTEM_PROMPT);
  const icpSha256After = sha256Text(ICP_DESCRIPTION);

  assert(
    goldManifestSha256Before === goldManifestSha256After,
    "gold manifest mutated during benchmark",
  );
  assert(
    v1PolicySha256Before === v1PolicySha256After,
    "V1 policy mutated during benchmark",
  );
  assert(
    v2PolicySha256Before === v2PolicySha256After,
    "V2 policy mutated during benchmark",
  );
  assert(icpSha256Before === icpSha256After, "ICP mutated during benchmark");

  const traceHashesAfter: Record<string, string> = {};
  for (const c of manifest.cases) {
    const after = await sha256File(frozenTracePath(c.id));
    traceHashesAfter[c.id] = after;
    assert(
      after === traceHashesBefore[c.id],
      `frozen trace mutated for ${c.id}`,
    );
    assert(
      after === c.frozen_trace_sha256,
      `frozen trace no longer matches manifest for ${c.id}`,
    );
  }

  const totalLiveClayCalls = live.liveCallCount();
  assert(totalLiveClayCalls === 0, `live Clay transport calls: ${totalLiveClayCalls}`);

  const integrity = {
    goldManifestPath: MANIFEST_PATH,
    goldManifestSha256: goldManifestSha256Before,
    goldUnchanged: true,
    v1PolicySha256: v1PolicySha256Before,
    v2PolicySha256: v2PolicySha256Before,
    icpSha256: icpSha256Before,
    policiesUnchanged: true,
    traceHashesBefore,
    traceHashesAfter,
    tracesUnchanged: true,
    liveClayCalls: totalLiveClayCalls,
    generation: settings,
  };

  const v1 = aggregatePolicy("v1", manifest.cases, allRuns, totalLiveClayCalls);
  const v2 = aggregatePolicy("v2", manifest.cases, allRuns, totalLiveClayCalls);

  const summary = {
    experiment: "agent-benchmark-v1",
    gold_version: manifest.gold_version,
    protocol_version: manifest.protocol_version,
    runsPerPolicy,
    intendedTotalRuns: manifest.cases.length * 2 * runsPerPolicy,
    completedTotalRuns: allRuns.length,
    integrity,
    v1,
    v2,
    runs: allRuns.map((r) => ({
      caseId: r.caseId,
      domain: r.domain,
      agentVersion: r.agentVersion,
      runIndex: r.runIndex,
      status: r.status,
      gold_label: r.gold_label,
      classification: r.classification,
      matches_gold: r.matches_gold,
      toolSequenceLabel: r.toolSequenceLabel,
      matchesExpectedSequence: r.matchesExpectedSequence,
      usage: r.usage,
      error: r.error,
      mismatch: r.mismatch,
    })),
  };

  await writeFile(
    join(ARTIFACTS_ROOT, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  const cli = formatCliReport({
    manifest,
    runsPerPolicy,
    integrity,
    v1,
    v2,
  });
  console.log(cli);
  console.error(`\nWrote ${join(ARTIFACTS_ROOT, "summary.json")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
