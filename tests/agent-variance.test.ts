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
import type { ChatModel, ChatToolCall, ModelTurn } from "../experiments/agent-replay/types.ts";

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

function finishTurn(id: string): ModelTurn {
  return {
    content: null,
    toolCalls: [
      toolCall(id, "finish_classification", {
        company: "notion.so",
        classification: "weak_fit",
        rationale: "Productivity SaaS, not developer infrastructure.",
        evidence_used: ["collaboration product"],
        missing_evidence: ["CI/CD adjacency"],
      }),
    ],
  };
}

test("fresh strict-replay interceptors do not share cursor state across runs", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "agent-variance-"));
  const tracePath = join(workDir, "frozen.trace.jsonl");

  try {
    const seed: Transport = {
      async call(toolName) {
        if (toolName === "find-and-enrich-company") {
          return { taskId: "task-1" };
        }
        if (toolName === "get-task-context") {
          return { entities: [{ name: "Notion" }] };
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
      companyIdentifier: "notion.so",
    });
    await recorder.call("get-task-context", { taskId: "task-1" });

    const bytesBefore = await readFile(tracePath);
    const hashBefore = createHash("sha256").update(bytesBefore).digest("hex");

    let transportCalls = 0;
    const failClosed = createFailClosedClayTransport();
    const countingFailClosed: Transport = {
      async call(toolName, args) {
        transportCalls += 1;
        return failClosed.call(toolName, args);
      },
    };

    const replayTurns = (): ModelTurn[] => [
      {
        content: null,
        toolCalls: [
          toolCall("1", "find-and-enrich-company", {
            companyIdentifier: "notion.so",
          }),
        ],
      },
      {
        content: null,
        toolCalls: [toolCall("2", "get-task-context", { taskId: "task-1" })],
      },
      finishTurn("3"),
    ];

    // Two sequential runs, each with a fresh interceptor (fresh cursor).
    for (let i = 0; i < 2; i += 1) {
      const interceptor = await createInterceptor({
        mode: "strict_replay",
        transport: countingFailClosed,
        tracePath,
      });
      const result = await runAgent({
        version: i === 0 ? "v1" : "v2",
        mode: "strict_replay",
        model: scriptedModel(replayTurns()),
        interceptor,
      });
      assert.equal(result.final.classification, "weak_fit");
      assert.equal(result.toolSequence.length, 2);
    }

    assert.equal(transportCalls, 0, "fail-closed transport must never be called");

    const bytesAfter = await readFile(tracePath);
    const hashAfter = createHash("sha256").update(bytesAfter).digest("hex");
    assert.equal(hashAfter, hashBefore, "frozen trace must remain byte-identical");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("replay mismatch is preserved without live transport fallback", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "agent-variance-mm-"));
  const tracePath = join(workDir, "frozen.trace.jsonl");

  try {
    await writeFile(
      tracePath,
      `${JSON.stringify({
        toolName: "find-and-enrich-company",
        arguments: { companyIdentifier: "notion.so" },
        response: { taskId: "task-1" },
      })}\n`,
      "utf8",
    );

    let transportCalls = 0;
    const failClosed = createFailClosedClayTransport();
    const countingFailClosed: Transport = {
      async call(toolName, args) {
        transportCalls += 1;
        return failClosed.call(toolName, args);
      },
    };

    const interceptor = await createInterceptor({
      mode: "strict_replay",
      transport: countingFailClosed,
      tracePath,
    });

    await assert.rejects(
      () =>
        runAgent({
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
        }),
      (err: unknown) => err instanceof ReplayMismatchError,
    );
    assert.equal(transportCalls, 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
