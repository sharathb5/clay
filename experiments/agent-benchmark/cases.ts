/**
 * Benchmark case registry for the recording subphase.
 * Slot intent is coverage design only — not a gold label.
 */

export const PROTOCOL_VERSION = "benchmark-record-v1";

export const EXPECTED_TOOL_SEQUENCE = [
  "find-and-enrich-company",
  "get-task-context",
] as const;

export type CoverageSlot =
  | "clear_fit"
  | "clear_non_fit"
  | "borderline";

export interface BenchmarkCase {
  /** Stable filesystem / manifest id. */
  id: string;
  /** Domain passed as companyIdentifier. */
  domain: string;
  /** Intended coverage slot (not gold). */
  slot: CoverageSlot;
  /** One-line why this domain is in this slot. */
  slotRationale: string;
}

export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  {
    id: "circleci",
    domain: "circleci.com",
    slot: "clear_fit",
    slotRationale: "CI/CD — explicit ICP example",
  },
  {
    id: "datadog",
    domain: "datadoghq.com",
    slot: "clear_fit",
    slotRationale: "Observability — explicit ICP example",
  },
  {
    id: "hubspot",
    domain: "hubspot.com",
    slot: "clear_non_fit",
    slotRationale: "CRM / marketing — ICP exclusion",
  },
  {
    id: "figma",
    domain: "figma.com",
    slot: "clear_non_fit",
    slotRationale: "Design tooling — ICP exclusion",
  },
  {
    id: "notion",
    domain: "notion.so",
    slot: "borderline",
    slotRationale: "Productivity / collaboration used by eng teams",
  },
  {
    id: "linear",
    domain: "linear.app",
    slot: "borderline",
    slotRationale: "Eng issue/workflow tool — buyer eng, product not infra",
  },
] as const;
