/**
 * Frozen-trace agent variance experiment.
 *
 * Repeated V1 / V2 strict replay against the existing Notion Clay trace.
 * No live Clay, no OAuth, no new recording. Characterizes observed model and
 * policy variance with the tool environment held fixed.
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
import { readTrace } from "../../src/trace.ts";
import type { Transport } from "../../src/types.ts";
import {
  createOpenRouterChatModel,
  getOpenRouterGenerationSettings,
  requireOpenRouterApiKey,
  type OpenRouterGenerationSettings,
} from "./provider-openrouter.ts";
import { COMPANY_DOMAIN } from "./policies.ts";
import { runAgent } from "./runner.ts";
import type {
  AgentRunResult,
  AgentVersion,
  Classification,
  ObservedToolCall,
  TokenUsage,
} from "./types.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const FROZEN_TRACE_PATH = join(
  repoRoot,
  ".experiment-artifacts",
  "agent-replay",
  "v1-live.trace.jsonl",
);
const ARTIFACTS_DIR = join(repoRoot, ".experiment-artifacts", "agent-variance");

const CLASSIFICATIONS: Classification[] = [
  "strong_fit",
  "medium_fit",
  "weak_fit",
  "unclear",
];

const EXPECTED_TOOL_SEQUENCE = [
  "find-and-enrich-company",
  "get-task-context",
] as const;

interface RunArtifact {
  runIndex: number;
  agentVersion: AgentVersion;
  status: "ok" | "mismatch" | "error";
  classification: Classification | null;
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
  usage: TokenUsage | null;
  liveClayTransportCalls: number;
}

interface PolicyAggregate {
  runs: number;
  classifications: Record<Classification, number>;
  classificationPercentages: Record<Classification, number>;
  mismatches: number;
  errors: number;
  toolSequenceStable: number;
  usage: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    average_tokens_per_run: number | null;
    total_cost: number | null;
    runs_with_usage: number;
  };
  distinctClassifications: Classification[];
  compactRationales: Array<{ run: number; classification: Classification; rationale: string }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`VARIANCE EXPERIMENT FAILED: ${message}`);
  }
}

function parseRunsArg(argv: string[]): number {
  const idx = argv.indexOf("--runs");
  if (idx === -1) return 10;
  const raw = argv[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --runs value: ${raw}`);
  }
  return n;
}

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
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
  const match = message.match(
    /expected ({[\s\S]*?}), got ({[\s\S]*})/,
  );
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

function emptyCounts(): Record<Classification, number> {
  return {
    strong_fit: 0,
    medium_fit: 0,
    weak_fit: 0,
    unclear: 0,
  };
}

function aggregatePolicy(runs: RunArtifact[]): PolicyAggregate {
  const classifications = emptyCounts();
  let mismatches = 0;
  let errors = 0;
  let toolSequenceStable = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let costPresent = false;
  let runsWithUsage = 0;
  const compactRationales: PolicyAggregate["compactRationales"] = [];

  for (const run of runs) {
    if (run.status === "mismatch") mismatches += 1;
    if (run.status === "error") errors += 1;
    if (run.matchesExpectedSequence) toolSequenceStable += 1;
    if (run.classification) {
      classifications[run.classification] += 1;
      if (run.rationale) {
        compactRationales.push({
          run: run.runIndex,
          classification: run.classification,
          rationale: run.rationale,
        });
      }
    }
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

  const completed = runs.length;
  const classificationPercentages = emptyCounts();
  for (const key of CLASSIFICATIONS) {
    classificationPercentages[key] =
      completed === 0
        ? 0
        : Math.round((classifications[key] / completed) * 1000) / 10;
  }

  return {
    runs: completed,
    classifications,
    classificationPercentages,
    mismatches,
    errors,
    toolSequenceStable,
    usage: {
      total_prompt_tokens: totalPrompt,
      total_completion_tokens: totalCompletion,
      total_tokens: totalTokens,
      average_tokens_per_run:
        runsWithUsage === 0 ? null : Math.round(totalTokens / runsWithUsage),
      total_cost: costPresent ? totalCost : null,
      runs_with_usage: runsWithUsage,
    },
    distinctClassifications: CLASSIFICATIONS.filter(
      (c) => classifications[c] > 0,
    ),
    compactRationales,
  };
}

function padPct(n: number): string {
  return String(n).padStart(3, " ");
}

function formatPolicyBlock(label: string, agg: PolicyAggregate): string {
  const lines = [
    label,
    ...CLASSIFICATIONS.map(
      (c) =>
        `${c.padEnd(12)} ${String(agg.classifications[c]).padStart(3)}  ${padPct(agg.classificationPercentages[c])}%`,
    ),
    `mismatches   ${String(agg.mismatches).padStart(3)}`,
  ];
  if (agg.errors > 0) {
    lines.push(`errors       ${String(agg.errors).padStart(3)}`);
  }
  return lines.join("\n");
}

function formatUsageBlock(label: string, agg: PolicyAggregate): string {
  if (agg.usage.runs_with_usage === 0) {
    return `${label} usage: (not reported by provider)`;
  }
  const lines = [
    `${label} usage`,
    `total tokens     ${agg.usage.total_tokens}`,
    `avg tokens/run   ${agg.usage.average_tokens_per_run}`,
    `prompt tokens    ${agg.usage.total_prompt_tokens}`,
    `completion tokens ${agg.usage.total_completion_tokens}`,
  ];
  if (agg.usage.total_cost !== null) {
    lines.push(`total cost       ${agg.usage.total_cost}`);
  }
  return lines.join("\n");
}

async function runOne(
  version: AgentVersion,
  runIndex: number,
  model: ReturnType<typeof createOpenRouterChatModel>,
  live: { transport: Transport; liveCallCount: () => number },
): Promise<RunArtifact> {
  const callsBefore = live.liveCallCount();
  // Fresh interceptor → fresh replay cursor; never share across runs.
  const interceptor = await createInterceptor({
    mode: "strict_replay",
    transport: live.transport,
    tracePath: FROZEN_TRACE_PATH,
  });

  try {
    // runAgent always starts a new messages[] — no conversation leak across runs.
    const result: AgentRunResult = await runAgent({
      version,
      model,
      interceptor,
    });
    const liveClayTransportCalls = live.liveCallCount() - callsBefore;
    assert(
      liveClayTransportCalls === 0,
      `live Clay transport invoked during ${version} run ${runIndex}`,
    );
    return {
      runIndex,
      agentVersion: version,
      status: "ok",
      classification: result.final.classification,
      rationale: result.final.rationale,
      evidence_used: result.final.evidence_used,
      missing_evidence: result.final.missing_evidence,
      toolSequence: result.toolSequence,
      toolSequenceLabel: formatToolSequence(result.toolSequence),
      matchesExpectedSequence: matchesExpectedSequence(result.toolSequence),
      mismatch: null,
      error: null,
      model: result.model,
      usage: result.usage ?? null,
      liveClayTransportCalls,
    };
  } catch (err) {
    const liveClayTransportCalls = live.liveCallCount() - callsBefore;
    assert(
      liveClayTransportCalls === 0,
      `live Clay transport invoked during ${version} run ${runIndex} (error path)`,
    );
    if (err instanceof ReplayMismatchError) {
      const detail = extractMismatchDetail(err.message);
      return {
        runIndex,
        agentVersion: version,
        status: "mismatch",
        classification: null,
        rationale: null,
        evidence_used: null,
        missing_evidence: null,
        toolSequence: [],
        toolSequenceLabel: "(mismatch before finish)",
        matchesExpectedSequence: false,
        mismatch: {
          message: err.message,
          ...detail,
        },
        error: null,
        model: model.model,
        usage: null,
        liveClayTransportCalls,
      };
    }
    return {
      runIndex,
      agentVersion: version,
      status: "error",
      classification: null,
      rationale: null,
      evidence_used: null,
      missing_evidence: null,
      toolSequence: [],
      toolSequenceLabel: "(error)",
      matchesExpectedSequence: false,
      mismatch: null,
      error: err instanceof Error ? err.message : String(err),
      model: model.model,
      usage: null,
      liveClayTransportCalls,
    };
  }
}

async function writeRunArtifact(
  version: AgentVersion,
  artifact: RunArtifact,
): Promise<void> {
  const dir = join(ARTIFACTS_DIR, version);
  await mkdir(dir, { recursive: true });
  const name = `run-${String(artifact.runIndex).padStart(2, "0")}.json`;
  await writeFile(
    join(dir, name),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  const runsPerPolicy = parseRunsArg(process.argv.slice(2));
  requireOpenRouterApiKey();

  const settings: OpenRouterGenerationSettings =
    getOpenRouterGenerationSettings();
  const model = createOpenRouterChatModel({ model: settings.model });

  // Stateless shared client/config is fine; each runAgent call owns fresh messages.
  assert(model.model === settings.model, "model identity must match settings");

  const frozenEntries = await readTrace(FROZEN_TRACE_PATH);
  assert(frozenEntries.length >= 1, `missing frozen trace at ${FROZEN_TRACE_PATH}`);
  assert(
    frozenEntries.every(
      (e) =>
        e.toolName === "find-and-enrich-company" ||
        e.toolName === "get-task-context",
    ),
    "frozen trace contains unexpected tools",
  );

  const hashBefore = await hashFile(FROZEN_TRACE_PATH);
  const live = createCountingFailClosedTransport();

  await mkdir(join(ARTIFACTS_DIR, "v1"), { recursive: true });
  await mkdir(join(ARTIFACTS_DIR, "v2"), { recursive: true });

  console.error(
    `AGENT VARIANCE: ${runsPerPolicy} runs × V1/V2 against frozen ${COMPANY_DOMAIN} trace`,
  );
  console.error(`trace: ${FROZEN_TRACE_PATH}`);
  console.error(`sha256: ${hashBefore}`);
  console.error(
    `model: ${settings.provider}/${settings.model} temperature=${settings.temperature} seed=${settings.seed} max_tokens=${settings.max_tokens}`,
  );

  const v1Runs: RunArtifact[] = [];
  const v2Runs: RunArtifact[] = [];

  for (let i = 1; i <= runsPerPolicy; i += 1) {
    console.error(`V1 run ${i}/${runsPerPolicy}…`);
    const artifact = await runOne("v1", i, model, live);
    v1Runs.push(artifact);
    await writeRunArtifact("v1", artifact);
    console.error(
      `  → ${artifact.status}${artifact.classification ? ` ${artifact.classification}` : ""} tools=${artifact.toolSequenceLabel}`,
    );
  }

  for (let i = 1; i <= runsPerPolicy; i += 1) {
    console.error(`V2 run ${i}/${runsPerPolicy}…`);
    const artifact = await runOne("v2", i, model, live);
    v2Runs.push(artifact);
    await writeRunArtifact("v2", artifact);
    console.error(
      `  → ${artifact.status}${artifact.classification ? ` ${artifact.classification}` : ""} tools=${artifact.toolSequenceLabel}`,
    );
  }

  const hashAfter = await hashFile(FROZEN_TRACE_PATH);
  assert(
    hashBefore === hashAfter,
    `frozen trace mutated: before=${hashBefore} after=${hashAfter}`,
  );

  const totalLiveClayCalls = live.liveCallCount();
  assert(totalLiveClayCalls === 0, `live Clay transport calls: ${totalLiveClayCalls}`);

  const v1 = aggregatePolicy(v1Runs);
  const v2 = aggregatePolicy(v2Runs);

  const summary = {
    experiment: "agent-variance",
    companyDomain: COMPANY_DOMAIN,
    frozenTracePath: FROZEN_TRACE_PATH,
    frozenTraceSha256Before: hashBefore,
    frozenTraceSha256After: hashAfter,
    frozenTraceUnchanged: hashBefore === hashAfter,
    runsPerPolicy,
    generation: settings,
    liveClayCalls: totalLiveClayCalls,
    interpretation: {
      environment_variance:
        "Removed by strict replay against one frozen Clay tool trace.",
      model_variance:
        "Observed variation across repeated runs of the same policy/model/settings.",
      policy_effect:
        "Observed difference between V1 and V2 classification distributions under the fixed environment. Not a correctness judgment.",
    },
    v1,
    v2,
    mismatchDetails: [...v1Runs, ...v2Runs]
      .filter((r) => r.status === "mismatch")
      .map((r) => ({
        agentVersion: r.agentVersion,
        runIndex: r.runIndex,
        mismatch: r.mismatch,
      })),
  };

  await writeFile(
    join(ARTIFACTS_DIR, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  const cli = [
    "AGENT VARIANCE EXPERIMENT",
    `Frozen Clay trace: ${COMPANY_DOMAIN}`,
    `Frozen trace sha256: ${hashBefore}`,
    `Trace unchanged after runs: ${hashBefore === hashAfter ? "yes" : "NO"}`,
    `Runs per policy: ${runsPerPolicy}`,
    `Live Clay calls: ${totalLiveClayCalls}`,
    "",
    `Provider: ${settings.provider}`,
    `Model: ${settings.model}`,
    `temperature: ${settings.temperature}`,
    `seed: ${settings.seed}`,
    `max_tokens: ${settings.max_tokens}`,
    `tool_choice: ${settings.tool_choice}`,
    "",
    formatPolicyBlock("V1", v1),
    "",
    formatPolicyBlock("V2", v2),
    "",
    "Tool sequence",
    `V1 stable: ${v1.toolSequenceStable}/${v1.runs} (expected: ${EXPECTED_TOOL_SEQUENCE.join(" → ")})`,
    `V2 stable: ${v2.toolSequenceStable}/${v2.runs} (expected: ${EXPECTED_TOOL_SEQUENCE.join(" → ")})`,
    "",
    formatUsageBlock("V1", v1),
    formatUsageBlock("V2", v2),
    "",
    "Interpretation",
    "Environment variance: frozen by replay (same Clay tool evidence every run).",
    "Model variance: variation within repeated runs of one policy.",
    "Policy effect: observed distribution difference between V1 and V2.",
    "This is an observed distribution under a fixed Clay environment.",
    "It does not establish statistical significance, correctness, or that either policy is better.",
    "",
    "Environment held fixed.",
    "Observed variation is attributable to model/policy behavior, not Clay data changes.",
  ].join("\n");

  console.log(cli);
  console.error(`\nWrote ${join(ARTIFACTS_DIR, "summary.json")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
