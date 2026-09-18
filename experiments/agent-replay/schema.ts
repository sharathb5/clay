import type { ClassificationResult } from "./types.ts";

export const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "company",
    "classification",
    "rationale",
    "evidence_used",
    "missing_evidence",
  ],
  properties: {
    company: { type: "string" },
    classification: {
      type: "string",
      enum: ["strong_fit", "medium_fit", "weak_fit", "unclear"],
    },
    rationale: { type: "string" },
    evidence_used: {
      type: "array",
      items: { type: "string" },
    },
    missing_evidence: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

const CLASSIFICATIONS = new Set([
  "strong_fit",
  "medium_fit",
  "weak_fit",
  "unclear",
]);

export function parseClassificationResult(value: unknown): ClassificationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Classification result must be a plain object");
  }
  const obj = value as Record<string, unknown>;
  const company = obj.company;
  const classification = obj.classification;
  const rationale = obj.rationale;
  const evidence_used = obj.evidence_used;
  const missing_evidence = obj.missing_evidence;

  if (typeof company !== "string" || company.trim().length === 0) {
    throw new Error("classification.company must be a non-empty string");
  }
  if (typeof classification !== "string" || !CLASSIFICATIONS.has(classification)) {
    throw new Error("classification.classification is invalid");
  }
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    throw new Error("classification.rationale must be a non-empty string");
  }
  if (
    !Array.isArray(evidence_used) ||
    !evidence_used.every((item) => typeof item === "string")
  ) {
    throw new Error("classification.evidence_used must be string[]");
  }
  if (
    !Array.isArray(missing_evidence) ||
    !missing_evidence.every((item) => typeof item === "string")
  ) {
    throw new Error("classification.missing_evidence must be string[]");
  }

  return {
    company,
    classification: classification as ClassificationResult["classification"],
    rationale,
    evidence_used,
    missing_evidence,
  };
}
