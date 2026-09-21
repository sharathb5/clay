import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFailClosedClayTransport } from "../adapters/clay-transport.ts";
import {
  createInterceptor,
  ReplayMismatchError,
} from "../src/interceptor.ts";
import type { Transport } from "../src/types.ts";
import { runAgent } from "../experiments/agent-replay/runner.ts";
import type {
  ChatModel,
  ChatToolCall,
  ModelTurn,
} from "../experiments/agent-replay/types.ts";
import { assertFrozenTraceSha256 } from "../experiments/agent-benchmark/integrity.ts";
import { loadBenchmarkManifest } from "../experiments/agent-benchmark/manifest.ts";
import {
  classificationMatchesGold,
  modalClassification,
} from "../experiments/agent-benchmark/score.ts";

function scriptedModel(turns: ModelTurn[]): ChatModel {
  let i = 0;
  return {
    model: "mock-model",
    async complete(): Promise<ModelTurn> {
      if (i >= turns.length) {
        throw new Error("mock model: no more scripted turns");
      }
      const turn = turns[i];
      i += 1;
      return turn;
    },
  };
}

function toolCall(id: string, name: string, args: unknown): ChatToolCall {
  return {
    id,
    name,
    argumentsJson: JSON.stringify(args),
  };
}

test("manifest loads sealed human gold without Clay payloads", async () => {
  const manifest = await loadBenchmarkManifest();
  assert.equal(manifest.gold_version, "benchmark-v1-gold-1");
  assert.equal(manifest.labeled_by, "human");
  assert.equal(manifest.cases.length, 6);
  assert.equal(manifest.generation_settings.temperature, "unset");
  assert.equal(manifest.generation_settings.seed, "unset");
  for (const c of manifest.cases) {
    assert.equal(c.labeled_by, "human");
    assert.ok(c.frozen_trace_sha256.length === 64);
    assert.ok(c.gold_rationale.length > 0);
    assert.ok(!("taskId" in c));
  }
  const raw = JSON.stringify(manifest);
  assert.ok(!raw.includes("access_token"));
  assert.ok(!raw.includes("Authorization"));
});

test("assertFrozenTraceSha256 refuses mismatched hashes", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "bench-hash-"));
  const tracePath = join(workDir, "frozen.trace.jsonl");
  try {
    await writeFile(tracePath, '{"toolName":"x"}\n', "utf8");
    const actual = createHash("sha256")
      .update(await readFile(tracePath))
      .digest("hex");
    await assert.rejects(
      () => assertFrozenTraceSha256(tracePath, "0".repeat(64)),
      /trace hash mismatch/,
    );
    const ok = await assertFrozenTraceSha256(tracePath, actual);
    assert.equal(ok, actual);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("scoring compares classification to gold without rationale grading", () => {
  assert.equal(classificationMatchesGold("strong_fit", "strong_fit"), true);
  assert.equal(classificationMatchesGold("weak_fit", "strong_fit"), false);
  assert.equal(classificationMatchesGold(null, "weak_fit"), false);
  assert.equal(
    modalClassification({
      strong_fit: 3,
      medium_fit: 1,
      weak_fit: 1,
      unclear: 0,
    }),
    "strong_fit",
  );
  assert.equal(
    modalClassification({
      strong_fit: 2,
      medium_fit: 2,
      weak_fit: 1,
      unclear: 0,
    }),
    null,
  );
});

test("benchmark replay uses fresh interceptor and fail-closed transport", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "bench-replay-"));
  const tracePath = join(workDir, "frozen.trace.jsonl");
  const domain = "circleci.com";

  try {
    const seed: Transport = {
      async call(toolName) {
        if (toolName === "find-and-enrich-company") {
          return { taskId: "task-1" };
        }
        if (toolName === "get-task-context") {
          return { entities: [{ name: "CircleCI" }] };
        }
        throw new Error(`unexpected ${toolName}`);
      },
    };
    const recorder = await createInterceptor({
      mode: "record",
      transport: seed,
      tracePath,
    });
    await recorder.call("find-and-enrich-company", {
      companyIdentifier: domain,
    });
    await recorder.call("get-task-context", { taskId: "task-1" });

    let transportCalls = 0;
    const failClosed = createFailClosedClayTransport();
    const counting: Transport = {
      async call(toolName, args) {
        transportCalls += 1;
        return failClosed.call(toolName, args);
      },
    };

    const turns = (): ModelTurn[] => [
      {
        content: null,
        toolCalls: [
          toolCall("1", "find-and-enrich-company", {
            companyIdentifier: domain,
          }),
        ],
      },
      {
        content: null,
        toolCalls: [toolCall("2", "get-task-context", { taskId: "task-1" })],
      },
      {
        content: null,
        toolCalls: [
          toolCall("3", "finish_classification", {
            company: domain,
            classification: "strong_fit",
            rationale: "CI/CD",
            evidence_used: ["CI/CD"],
            missing_evidence: [],
          }),
        ],
      },
    ];

    for (let i = 0; i < 2; i += 1) {
      const interceptor = await createInterceptor({
        mode: "strict_replay",
        transport: counting,
        tracePath,
      });
      assert.equal(interceptor.mode, "strict_replay");
      const result = await runAgent({
        version: i === 0 ? "v1" : "v2",
        mode: "strict_replay",
        model: scriptedModel(turns()),
        interceptor,
        companyDomain: domain,
      });
      assert.equal(result.final.classification, "strong_fit");
    }
    assert.equal(transportCalls, 0);

    await assert.rejects(
      async () => {
        const interceptor = await createInterceptor({
          mode: "strict_replay",
          transport: counting,
          tracePath,
        });
        await runAgent({
          version: "v1",
          mode: "strict_replay",
          model: scriptedModel([
            {
              content: null,
              toolCalls: [
                toolCall("1", "get-task-context", { taskId: "task-1" }),
              ],
            },
          ]),
          interceptor,
          companyDomain: domain,
        });
      },
      (err: unknown) => err instanceof ReplayMismatchError,
    );
    assert.equal(transportCalls, 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("benchmark runner source has no record-mode or live Clay transport path", async () => {
  const source = await readFile(
    join(
      import.meta.dirname,
      "../experiments/agent-benchmark/run.ts",
    ),
    "utf8",
  );
  assert.ok(!source.includes("createClayTransport("));
  assert.ok(!source.includes('mode: "record"'));
  assert.ok(source.includes("createFailClosedClayTransport"));
  assert.ok(source.includes('mode: "strict_replay"'));
});
