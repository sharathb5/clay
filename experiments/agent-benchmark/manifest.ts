/**
 * Load and validate the sealed benchmark-v1 gold manifest.
 * No Clay I/O. No gold mutation.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Classification } from "../agent-replay/types.ts";
import { PROTOCOL_VERSION } from "./cases.ts";

const CLASSIFICATIONS = new Set<Classification>([
  "strong_fit",
  "medium_fit",
  "weak_fit",
  "unclear",
]);

export interface ManifestGenerationSettings {
  provider: "openrouter";
  model: string;
  temperature: "unset";
  seed: "unset";
  max_tokens: number;
  tool_choice: "auto";
}

export interface ManifestCase {
  id: string;
  domain: string;
  frozen_trace_sha256: string;
  gold_label: Classification;
  gold_rationale: string;
  labeled_by: "human";
}

export interface BenchmarkManifest {
  gold_version: string;
  protocol_version: string;
  labeled_by: "human";
  roster_freeze_commit: string;
  icp: string;
  generation_settings: ManifestGenerationSettings;
  cases: ManifestCase[];
}

export const MANIFEST_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "benchmark-v1.manifest.json",
);

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest root must be a plain object");
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`manifest.${key} must be a non-empty string`);
  }
  return v;
}

function parseCase(value: unknown, index: number): ManifestCase {
  const obj = asRecord(value);
  const gold_label = requireString(obj, "gold_label");
  if (!CLASSIFICATIONS.has(gold_label as Classification)) {
    throw new Error(`manifest.cases[${index}].gold_label is invalid`);
  }
  const labeled_by = requireString(obj, "labeled_by");
  if (labeled_by !== "human") {
    throw new Error(`manifest.cases[${index}].labeled_by must be "human"`);
  }
  return {
    id: requireString(obj, "id"),
    domain: requireString(obj, "domain"),
    frozen_trace_sha256: requireString(obj, "frozen_trace_sha256"),
    gold_label: gold_label as Classification,
    gold_rationale: requireString(obj, "gold_rationale"),
    labeled_by: "human",
  };
}

export function parseBenchmarkManifest(value: unknown): BenchmarkManifest {
  const root = asRecord(value);
  const gold_version = requireString(root, "gold_version");
  const protocol_version = requireString(root, "protocol_version");
  if (protocol_version !== PROTOCOL_VERSION) {
    throw new Error(
      `manifest.protocol_version mismatch: expected ${PROTOCOL_VERSION}, got ${protocol_version}`,
    );
  }
  const labeled_by = requireString(root, "labeled_by");
  if (labeled_by !== "human") {
    throw new Error('manifest.labeled_by must be "human"');
  }
  const roster_freeze_commit = requireString(root, "roster_freeze_commit");
  const icp = requireString(root, "icp");

  const genRaw = asRecord(root.generation_settings);
  const generation_settings: ManifestGenerationSettings = {
    provider: "openrouter",
    model: requireString(genRaw, "model"),
    temperature: "unset",
    seed: "unset",
    max_tokens:
      typeof genRaw.max_tokens === "number" ? genRaw.max_tokens : Number.NaN,
    tool_choice: "auto",
  };
  if (genRaw.provider !== "openrouter") {
    throw new Error('manifest.generation_settings.provider must be "openrouter"');
  }
  if (genRaw.temperature !== "unset" || genRaw.seed !== "unset") {
    throw new Error("manifest generation temperature/seed must remain unset");
  }
  if (genRaw.tool_choice !== "auto") {
    throw new Error('manifest.generation_settings.tool_choice must be "auto"');
  }
  if (!Number.isInteger(generation_settings.max_tokens) || generation_settings.max_tokens < 1) {
    throw new Error("manifest.generation_settings.max_tokens must be a positive integer");
  }

  if (!Array.isArray(root.cases) || root.cases.length === 0) {
    throw new Error("manifest.cases must be a non-empty array");
  }
  const cases = root.cases.map(parseCase);

  return {
    gold_version,
    protocol_version,
    labeled_by: "human",
    roster_freeze_commit,
    icp,
    generation_settings,
    cases,
  };
}

export async function loadBenchmarkManifest(
  path: string = MANIFEST_PATH,
): Promise<BenchmarkManifest> {
  const raw = await readFile(path, "utf8");
  return parseBenchmarkManifest(JSON.parse(raw));
}
