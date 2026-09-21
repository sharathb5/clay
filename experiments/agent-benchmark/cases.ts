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

/**
 * Active benchmark v1 cases (after Figma exclusion / Canva replacement).
 * Gold labels are not assigned here.
 */
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
    id: "canva",
    domain: "canva.com",
    slot: "clear_non_fit",
    slotRationale: "Design / creative tooling — ICP exclusion (replaces figma)",
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

/**
 * Recorded but excluded from benchmark v1.
 * Artifacts remain under cases/<id>/ for diagnostics; do not delete or overwrite.
 */
export const EXCLUDED_FROM_BENCHMARK_V1 = [
  {
    id: "figma",
    domain: "figma.com",
    slot: "clear_non_fit" as const,
    excludedAt: "2026-09-20",
    reason:
      "Frozen evidence has identity/evidence-quality ambiguity (requested figma.com; returned domain/website figma.bot; description only Config 2026 blurb). Insufficiently clean for the intended clear-non-fit control. Exclusion is about benchmark evidence quality, not Figma's real-world ICP classification.",
    frozenTraceSha256:
      "b5d6eb5f464853ba30e5bf661fe55328a4d7495d07984b7a0fd9473c9853fd78",
  },
] as const;
