import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

test("runner routes Clay tools through interceptor and finishes locally", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "agent-runner-"));
  const tracePath = join(workDir, "trace.jsonl");
  let liveCalls = 0;
  const transport: Transport = {
    async call(toolName, args) {
      liveCalls += 1;
      if (toolName === "find-and-enrich-company") {
        assert.deepEqual(args, { companyIdentifier: "notion.so" });
        return { taskId: "task-1", summary: "Found Notion" };
      }
      if (toolName === "get-task-context") {
        assert.deepEqual(args, { taskId: "task-1" });
        return {
          entities: [{ name: "Notion", description: "productivity software" }],
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    },
  };

  try {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });

    const model = scriptedModel([
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
      {
        content: null,
        toolCalls: [
          toolCall("3", "finish_classification", {
            company: "notion.so",
            classification: "medium_fit",
            rationale: "Technical B2B SaaS with APIs.",
            evidence_used: ["B2B SaaS"],
            missing_evidence: ["infra adjacency"],
          }),
        ],
      },
    ]);

    const result = await runAgent({
      version: "v1",
      mode: "record",
      model,
      interceptor,
    });

    assert.equal(result.final.classification, "medium_fit");
    assert.equal(result.toolSequence.length, 2);
    assert.equal(result.toolSequence[0].toolName, "find-and-enrich-company");
    assert.equal(result.toolSequence[1].toolName, "get-task-context");
    assert.equal(liveCalls, 2);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("runner surfaces ReplayMismatchError from interceptor on divergent tool call", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "agent-runner-"));
  const tracePath = join(workDir, "trace.jsonl");
  const transport: Transport = {
    async call() {
      throw new Error("live should not be called in this test setup path");
    },
  };

  try {
    // Seed a one-entry trace via record with a stub that writes one interaction.
    const seedTransport: Transport = {
      async call() {
        return { taskId: "task-1" };
      },
    };
    const recorder = await createInterceptor({
      mode: "record",
      transport: seedTransport,
      tracePath,
    });
    await recorder.call("find-and-enrich-company", {
      companyIdentifier: "notion.so",
    });

    const replayer = await createInterceptor({
      mode: "strict_replay",
      transport,
      tracePath,
    });

    const model = scriptedModel([
      {
        content: null,
        toolCalls: [
          toolCall("1", "get-task-context", { taskId: "task-1" }),
        ],
      },
    ]);

    await assert.rejects(
      () =>
        runAgent({
          version: "v2",
          mode: "strict_replay",
          model,
          interceptor: replayer,
        }),
      (err: unknown) => err instanceof ReplayMismatchError,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
