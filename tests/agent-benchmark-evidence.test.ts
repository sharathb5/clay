import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveEvidenceCard } from "../experiments/agent-benchmark/evidence-card.ts";
import { sha256Bytes, sha256File } from "../experiments/agent-benchmark/seal.ts";
import type { TraceEntry } from "../src/types.ts";

function companyEntry(
  toolName: string,
  domainKey: string,
  company: Record<string, unknown>,
  args: unknown,
): TraceEntry {
  return {
    toolName,
    arguments: args,
    response: {
      taskId: "task-1",
      companies: { [domainKey]: company },
    },
  };
}

test("sha256File matches sha256 of file bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-seal-"));
  const path = join(dir, "t.jsonl");
  const body = '{"toolName":"x"}\n';
  await writeFile(path, body, "utf8");
  assert.equal(await sha256File(path), sha256Bytes(body));
});

test("deriveEvidenceCard extracts labeling fields without gold", () => {
  const entries: TraceEntry[] = [
    companyEntry(
      "find-and-enrich-company",
      "circleci.com",
      {
        name: "CircleCI",
        domain: "circleci.com",
        website: "https://circleci.com",
        industry: "Software Development",
        description:
          "CircleCI is a continuous integration and continuous delivery platform for software teams.",
        size: "501-1,000 employees",
        enrichments: [],
      },
      { companyIdentifier: "circleci.com" },
    ),
    companyEntry(
      "get-task-context",
      "circleci.com",
      {
        name: "CircleCI",
        domain: "circleci.com",
        website: "https://circleci.com",
        industry: "Software Development",
        description:
          "CircleCI is a continuous integration and continuous delivery platform for software teams.",
        enrichments: [],
      },
      { taskId: "task-1" },
    ),
  ];

  const card = deriveEvidenceCard({
    caseId: "circleci",
    requestedDomain: "circleci.com",
    frozenTraceSha256: "abc",
    entries,
  });

  assert.equal(card.company?.name, "CircleCI");
  assert.equal(card.company?.industry, "Software Development");
  assert.equal(card.identity.appearsToMatchRequestedDomain, true);
  assert.equal(card.sufficiency.appearsSufficientForRubric, true);
  assert.ok(!("gold_label" in card));
  assert.ok(!("classification" in card));
  assert.deepEqual(card.toolSequence, [
    "find-and-enrich-company",
    "get-task-context",
  ]);
});

test("deriveEvidenceCard flags identity mismatch and insufficient evidence", () => {
  const entries: TraceEntry[] = [
    companyEntry(
      "find-and-enrich-company",
      "other.com",
      {
        name: "Other Co",
        domain: "other.com",
        website: "https://other.com",
        industry: null,
        description: "",
        enrichments: {},
      },
      { companyIdentifier: "linear.app" },
    ),
    {
      toolName: "get-task-context",
      arguments: { taskId: "task-1" },
      response: { taskId: "task-1", companies: {} },
    },
  ];

  const card = deriveEvidenceCard({
    caseId: "linear",
    requestedDomain: "linear.app",
    frozenTraceSha256: "def",
    entries,
  });

  assert.equal(card.identity.appearsToMatchRequestedDomain, false);
  assert.equal(card.sufficiency.appearsSufficientForRubric, false);
  assert.ok(card.sufficiency.missingOrAmbiguousFields.includes("identity_mismatch"));
  assert.ok(card.sufficiency.missingOrAmbiguousFields.includes("description"));
});

test("notion.com domain is accepted as related to notion.so request", () => {
  const entries: TraceEntry[] = [
    companyEntry(
      "find-and-enrich-company",
      "notion.so",
      {
        name: "Notion",
        domain: "notion.com",
        website: "https://notion.com",
        industry: "Software Development",
        description:
          "Notion blends your everyday work tools into one workspace for notes and wikis.",
        enrichments: [],
      },
      { companyIdentifier: "notion.so" },
    ),
    companyEntry(
      "get-task-context",
      "notion.so",
      {
        name: "Notion",
        domain: "notion.com",
        website: "https://notion.com",
        industry: "Software Development",
        description:
          "Notion blends your everyday work tools into one workspace for notes and wikis.",
        enrichments: [],
      },
      { taskId: "task-1" },
    ),
  ];

  const card = deriveEvidenceCard({
    caseId: "notion",
    requestedDomain: "notion.so",
    frozenTraceSha256: "ghi",
    entries,
  });

  // mapKey notion.so matches request even if company.domain is notion.com
  assert.equal(card.identity.appearsToMatchRequestedDomain, true);
  assert.equal(card.sufficiency.appearsSufficientForRubric, true);
});
