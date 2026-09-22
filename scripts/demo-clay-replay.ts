/**
 * Presentation-only Loom demo helper.
 *
 * 1. Verify the sealed Notion benchmark frozen-trace hash
 * 2. Run one fresh V2 strict_replay (fail-closed; 0 live Clay)
 * 3. Regenerate sanitized demo/*.json from canonical artifacts + this sample
 *
 * Does not recompute sealed benchmark scores or mutate gold/traces/policies.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFailClosedClayTransport } from "../adapters/clay-transport.ts";
import {
  createInterceptor,
  ReplayMismatchError,
} from "../src/interceptor.ts";
import type { TraceEntry, Transport } from "../src/types.ts";
import { readTrace } from "../src/trace.ts";
import {
  createOpenRouterChatModel,
  getOpenRouterGenerationSettings,
  requireOpenRouterApiKey,
} from "../experiments/agent-replay/provider-openrouter.ts";
import { runAgent } from "../experiments/agent-replay/runner.ts";
import { sha256File } from "../experiments/agent-benchmark/seal.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const NOTION_TRACE = join(
  repoRoot,
  ".experiment-artifacts/agent-benchmark/cases/notion/frozen.trace.jsonl",
);
const EXPECTED_NOTION_SHA =
  "a7ff8a0eae7eb777ecfa432b512070b1c0c60d5dbdbaf48b696677d3f2c4d8c9";
const DEMO_DIR = join(repoRoot, "demo");
const CLAY_TRACE_OUT = join(DEMO_DIR, "clay-trace.json");
const BENCHMARK_OUT = join(DEMO_DIR, "benchmark-results.json");

const MANIFEST_CASES = [
  {
    id: "circleci",
    domain: "circleci.com",
    sha: "eea859f02c70469bddda3a607dc48c2b2d8256cd4b57e7e93eea3a3a38779f8a",
  },
  {
    id: "datadog",
    domain: "datadoghq.com",
    sha: "e3d28bae732e18d4b909b2211b9b7c92614b48f4a8e340cb671caa4e5f721e12",
  },
  {
    id: "hubspot",
    domain: "hubspot.com",
    sha: "468d54f371e940991e69cc2d25fcace4f49a13aa055d84219f5d3916b9d0aff3",
  },
  {
    id: "canva",
    domain: "canva.com",
    sha: "bc26193a2a749fbf591829aa474e93d614c850045520de484894a5fc056f47f2",
  },
  {
    id: "notion",
    domain: "notion.so",
    sha: EXPECTED_NOTION_SHA,
  },
  {
    id: "linear",
    domain: "linear.app",
    sha: "7468adf4fcba16da13dfa5f8d93914a6a104e60780015aa035a36b65e7730042",
  },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`DEMO FAILED: ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function companyEvidence(response: unknown): Record<string, unknown> {
  const root = asRecord(response);
  const companies = asRecord(root?.companies);
  const company = asRecord(companies?.["notion.so"]);
  assert(company, "Notion company evidence missing from frozen trace");
  const out: Record<string, unknown> = {};
  for (const key of [
    "name",
    "domain",
    "industry",
    "description",
    "size",
    "type",
    "locality",
    "country",
    "employee_count",
    "annual_revenue",
  ] as const) {
    if (company[key] !== undefined) out[key] = company[key];
  }
  return out;
}

function sanitizeTrace(entries: TraceEntry[], traceSha256: string) {
  assert(entries.length === 2, `expected 2 Notion trace steps, got ${entries.length}`);
  const [find, task] = entries;
  assert(
    find.toolName === "find-and-enrich-company",
    `unexpected first tool: ${find.toolName}`,
  );
  assert(
    task.toolName === "get-task-context",
    `unexpected second tool: ${task.toolName}`,
  );

  const findCompany = companyEvidence(find.response);
  const taskCompany = companyEvidence(task.response);

  return {
    demo: "Frozen Clay MCP trace",
    company: "notion.so",
    source: "Clay MCP",
    mode: "recorded_once_then_strict_replay",
    note: "Sanitized presentation copy of the sealed benchmark Notion freeze. Not the canonical trace.",
    trace_sha256: traceSha256,
    tool_calls: [
      {
        step: 1,
        tool: find.toolName,
        arguments: {
          companyIdentifier: "notion.so",
        },
        response: findCompany,
      },
      {
        step: 2,
        tool: task.toolName,
        arguments: {
          taskId: "<redacted>",
        },
        response: {
          name: taskCompany.name,
          domain: taskCompany.domain,
          industry: taskCompany.industry,
          size: taskCompany.size,
          note: "Same company evidence as step 1 (task context). Full description identical; IDs and noise removed.",
        },
      },
    ],
    replay_guarantees: {
      live_clay_calls_during_replay: 0,
      unexpected_tool_call: "ReplayMismatchError",
      trace_mutated_during_replay: false,
    },
  };
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

function formatToolSequence(
  tools: Array<{ toolName: string }>,
): string {
  return tools.map((t) => t.toolName).join(" → ");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function verifyAllBenchmarkTraceHashes(): Promise<void> {
  for (const c of MANIFEST_CASES) {
    const path = join(
      repoRoot,
      ".experiment-artifacts/agent-benchmark/cases",
      c.id,
      "frozen.trace.jsonl",
    );
    const actual = await sha256File(path);
    assert(
      actual === c.sha,
      `trace hash changed for ${c.id}: expected ${c.sha}, got ${actual}`,
    );
  }
}

async function main(): Promise<void> {
  requireOpenRouterApiKey();
  const settings = getOpenRouterGenerationSettings();
  const model = createOpenRouterChatModel();

  const hashBefore = await sha256File(NOTION_TRACE);
  assert(
    hashBefore === EXPECTED_NOTION_SHA,
    `Notion freeze hash mismatch: expected ${EXPECTED_NOTION_SHA}, got ${hashBefore}`,
  );
  await verifyAllBenchmarkTraceHashes();

  const entries = await readTrace(NOTION_TRACE);
  const clayTrace = sanitizeTrace(entries, hashBefore);

  const live = createCountingFailClosedTransport();
  const callsBefore = live.liveCallCount();
  const interceptor = await createInterceptor({
    mode: "strict_replay",
    transport: live.transport,
    tracePath: NOTION_TRACE,
  });

  let classification: string | null = null;
  let rationale: string | null = null;
  let evidence_used: string[] | null = null;
  let missing_evidence: string[] | null = null;
  let tool_sequence: string = "(none)";
  let replay_mismatch = false;
  let mismatch_message: string | null = null;
  let usage: unknown = null;

  try {
    const result = await runAgent({
      version: "v2",
      mode: "strict_replay",
      model,
      interceptor,
      companyDomain: "notion.so",
    });
    classification = result.final.classification;
    rationale = result.final.rationale;
    evidence_used = result.final.evidence_used;
    missing_evidence = result.final.missing_evidence;
    tool_sequence = formatToolSequence(result.toolSequence);
    usage = result.usage ?? null;
  } catch (err) {
    if (err instanceof ReplayMismatchError) {
      replay_mismatch = true;
      mismatch_message = err.message;
    } else {
      throw err;
    }
  }

  const liveClayCalls = live.liveCallCount() - callsBefore;
  assert(liveClayCalls === 0, `live Clay calls during demo replay: ${liveClayCalls}`);

  const hashAfter = await sha256File(NOTION_TRACE);
  assert(
    hashAfter === hashBefore,
    `Notion freeze mutated during demo replay: before=${hashBefore} after=${hashAfter}`,
  );
  await verifyAllBenchmarkTraceHashes();

  const demoSample = {
    excluded_from_benchmark_statistics: true,
    purpose: "Fresh Loom demo replay only; sealed 60-run benchmark numbers are unchanged.",
    company: "notion.so",
    policy: "v2",
    mode: "strict_replay",
    classification,
    rationale,
    evidence_used,
    missing_evidence,
    tool_sequence,
    live_clay_calls: liveClayCalls,
    replay_mismatches: replay_mismatch ? 1 : 0,
    mismatch_message,
    trace_sha256_before: hashBefore,
    trace_sha256_after: hashAfter,
    provider: settings.provider,
    model: settings.model,
    temperature: settings.temperature,
    seed: settings.seed,
    max_tokens: settings.max_tokens,
    tool_choice: settings.tool_choice,
    usage,
  };

  // Sealed aggregate facts (presentation copy; not recomputed from this sample).
  const benchmarkResults = {
    benchmark: {
      name: "Frozen Clay Agent Benchmark v1",
      companies: 6,
      runs_per_policy_per_company: 5,
      total_agent_runs: 60,
      live_clay_calls: 0,
      replay_mismatches: 0,
      gold: "human-labeled before agent scoring",
    },

    method: {
      environment: "frozen Clay MCP traces",
      gold: "human-labeled before agent scoring",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      temperature: "unset",
      seed: "unset",
      max_tokens: 512,
      tool_choice: "auto",
    },

    aggregate: {
      v1: {
        correct: 23,
        total: 30,
        accuracy: "76.7%",
        modal_label_accuracy: "5/6",
        tokens: 116424,
        approx_cost_usd: 0.014,
      },
      v2: {
        correct: 25,
        total: 30,
        accuracy: "83.3%",
        modal_label_accuracy: "5/6",
        tokens: 117924,
        approx_cost_usd: 0.015,
      },
      combined_approx_cost_usd: 0.029,
    },

    interpretation: [
      "Frozen replay removes environment drift.",
      "Repeated runs reveal model variance under identical evidence.",
      "Policy changes can improve some cases and regress others.",
      "V2 had higher observed agreement with human gold in this six-case benchmark — not a claim that V2 is universally better.",
    ],

    cases: {
      circleci: {
        domain: "circleci.com",
        human_gold: "strong_fit",
        v1_distribution: "strong_fit 5/5",
        v1_accuracy: "5/5",
        v2_distribution: "strong_fit 5/5",
        v2_accuracy: "5/5",
        observation: "Both policies matched gold on every run.",
      },
      datadog: {
        domain: "datadoghq.com",
        human_gold: "strong_fit",
        v1_distribution: "strong_fit 5/5",
        v1_accuracy: "5/5",
        v2_distribution: "strong_fit 5/5",
        v2_accuracy: "5/5",
        observation: "Both policies matched gold on every run.",
      },
      hubspot: {
        domain: "hubspot.com",
        human_gold: "weak_fit",
        v1_distribution: "weak_fit 3/5, medium_fit 2/5",
        v1_accuracy: "3/5",
        v2_distribution: "weak_fit 5/5",
        v2_accuracy: "5/5",
        observation:
          "V1 showed run-to-run model variance under identical evidence; V2 did not in this sample.",
      },
      canva: {
        domain: "canva.com",
        human_gold: "weak_fit",
        v1_distribution: "weak_fit 5/5",
        v1_accuracy: "5/5",
        v2_distribution: "weak_fit 5/5",
        v2_accuracy: "5/5",
        observation: "Both policies matched gold on every run.",
      },
      notion: {
        domain: "notion.so",
        human_gold: "weak_fit",
        v1_distribution: "medium_fit 5/5",
        v1_accuracy: "0/5",
        v2_distribution: "weak_fit 5/5",
        v2_accuracy: "5/5",
        observation:
          "V2 corrected V1's consistently over-generous classification.",
      },
      linear: {
        domain: "linear.app",
        human_gold: "medium_fit",
        v1_distribution: "medium_fit 5/5",
        v1_accuracy: "5/5",
        v2_distribution: "weak_fit 5/5",
        v2_accuracy: "0/5",
        observation:
          "The stricter V2 policy introduced a regression on the borderline case.",
      },
    },

    highlights: {
      notion: {
        gold: "weak_fit",
        v1: "medium_fit 5/5",
        v2: "weak_fit 5/5",
        observation:
          "V2 corrected V1's consistently over-generous classification.",
      },
      linear: {
        gold: "medium_fit",
        v1: "medium_fit 5/5",
        v2: "weak_fit 5/5",
        observation:
          "The stricter V2 policy introduced a regression on the borderline case.",
      },
      hubspot: {
        gold: "weak_fit",
        v1: "weak_fit 3/5, medium_fit 2/5",
        v2: "weak_fit 5/5",
        observation:
          "V1 showed run-to-run model variance under identical evidence; V2 did not in this sample.",
      },
    },

    demo_sample: demoSample,
  };

  await mkdir(DEMO_DIR, { recursive: true });
  await writeFile(CLAY_TRACE_OUT, `${JSON.stringify(clayTrace, null, 2)}\n`, "utf8");
  await writeFile(
    BENCHMARK_OUT,
    `${JSON.stringify(benchmarkResults, null, 2)}\n`,
    "utf8",
  );

  // Integrity fingerprints for the demo report (not written into presentation files).
  const { V1_SYSTEM_PROMPT, V2_SYSTEM_PROMPT, ICP_DESCRIPTION } = await import(
    "../experiments/agent-replay/policies.ts"
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        demo_sample: demoSample,
        files: {
          clay_trace: CLAY_TRACE_OUT,
          benchmark_results: BENCHMARK_OUT,
        },
        integrity: {
          notion_trace_sha256: hashAfter,
          v1_policy_sha256: sha256Text(V1_SYSTEM_PROMPT),
          v2_policy_sha256: sha256Text(V2_SYSTEM_PROMPT),
          icp_sha256: sha256Text(ICP_DESCRIPTION),
          live_clay_calls: liveClayCalls,
          sample_excluded_from_benchmark_statistics: true,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
