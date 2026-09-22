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
import {
  normalizeCompanyDomain,
  runAgent,
} from "../experiments/agent-replay/runner.ts";
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

function finishArgs(company = "notion.so") {
  return {
    company,
    classification: "medium_fit",
    rationale: "Technical B2B SaaS with APIs.",
    evidence_used: ["B2B SaaS"],
    missing_evidence: ["infra adjacency"],
  };
}

async function withTrace<T>(
  fn: (tracePath: string, transport: Transport) => Promise<T>,
): Promise<T> {
  const workDir = await mkdtemp(join(tmpdir(), "agent-runner-"));
  const tracePath = join(workDir, "trace.jsonl");
  const transport: Transport = {
    async call(toolName, args) {
      if (toolName === "find-and-enrich-company") {
        return { taskId: "task-1", summary: "Found" };
      }
      if (toolName === "get-task-context") {
        return { entities: [{ name: "Company" }] };
      }
      throw new Error(`unexpected tool ${toolName}`);
    },
  };
  try {
    return await fn(tracePath, transport);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

test("runner routes Clay tools through interceptor and finishes locally", async () => {
  await withTrace(async (tracePath, transport) => {
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
          toolCall("3", "finish_classification", finishArgs("notion.so")),
        ],
      },
    ]);

    const result = await runAgent({
      version: "v1",
      model,
      interceptor,
    });

    assert.equal(result.final.classification, "medium_fit");
    assert.equal(result.mode, "record");
    assert.equal(result.toolSequence.length, 2);
    assert.equal(result.toolSequence[0].toolName, "find-and-enrich-company");
    assert.equal(result.toolSequence[1].toolName, "get-task-context");
  });
});

test("runAgent mode derives from interceptor, not a separate option", async () => {
  await withTrace(async (tracePath, transport) => {
    const recorder = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });
    const recorded = await runAgent({
      version: "v1",
      model: scriptedModel([
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
            toolCall("3", "finish_classification", finishArgs("notion.so")),
          ],
        },
      ]),
      interceptor: recorder,
    });
    assert.equal(recorded.mode, recorder.mode);
    assert.equal(recorded.mode, "record");

    const replayer = await createInterceptor({
      mode: "strict_replay",
      transport,
      tracePath,
    });
    const replayed = await runAgent({
      version: "v1",
      model: scriptedModel([
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
            toolCall("3", "finish_classification", finishArgs("notion.so")),
          ],
        },
      ]),
      interceptor: replayer,
    });
    assert.equal(replayed.mode, replayer.mode);
    assert.equal(replayed.mode, "strict_replay");
  });
});

test("finish_classification before required Clay tools fails", async () => {
  await withTrace(async (tracePath, transport) => {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });
    await assert.rejects(
      () =>
        runAgent({
          version: "v1",
          model: scriptedModel([
            {
              content: null,
              toolCalls: [
                toolCall("1", "finish_classification", finishArgs()),
              ],
            },
          ]),
          interceptor,
        }),
      /violated required tool protocol/,
    );
  });
});

test("incomplete Clay tool sequence before finish fails", async () => {
  await withTrace(async (tracePath, transport) => {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });
    await assert.rejects(
      () =>
        runAgent({
          version: "v1",
          model: scriptedModel([
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
              toolCalls: [
                toolCall("2", "finish_classification", finishArgs()),
              ],
            },
          ]),
          interceptor,
        }),
      /violated required tool protocol/,
    );
  });
});

test("get-task-context before find-and-enrich-company fails", async () => {
  await withTrace(async (tracePath, transport) => {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });
    await assert.rejects(
      () =>
        runAgent({
          version: "v1",
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
      /violated required tool order/,
    );
  });
});

test("duplicate Clay tool after required sequence fails", async () => {
  await withTrace(async (tracePath, transport) => {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });
    await assert.rejects(
      () =>
        runAgent({
          version: "v1",
          model: scriptedModel([
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
              toolCalls: [
                toolCall("2", "get-task-context", { taskId: "task-1" }),
              ],
            },
            {
              content: null,
              toolCalls: [
                toolCall("3", "find-and-enrich-company", {
                  companyIdentifier: "notion.so",
                }),
              ],
            },
          ]),
          interceptor,
        }),
      /unexpected Clay tool/,
    );
  });
});

test("wrong final company fails the run", async () => {
  await withTrace(async (tracePath, transport) => {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });
    await assert.rejects(
      () =>
        runAgent({
          version: "v1",
          model: scriptedModel([
            {
              content: null,
              toolCalls: [
                toolCall("1", "find-and-enrich-company", {
                  companyIdentifier: "circleci.com",
                }),
              ],
            },
            {
              content: null,
              toolCalls: [
                toolCall("2", "get-task-context", { taskId: "task-1" }),
              ],
            },
            {
              content: null,
              toolCalls: [
                toolCall("3", "finish_classification", finishArgs("notion.so")),
              ],
            },
          ]),
          interceptor,
          companyDomain: "circleci.com",
        }),
      /does not match evaluated company/,
    );
  });
});

test("normalizeCompanyDomain trims, lowercases, and strips leading www", () => {
  assert.equal(normalizeCompanyDomain("  WWW.Notion.SO "), "notion.so");
  assert.equal(normalizeCompanyDomain("circleci.com"), "circleci.com");
  assert.notEqual(
    normalizeCompanyDomain("notion.so"),
    normalizeCompanyDomain("circleci.com"),
  );
});

test("matching company with www. prefix is accepted", async () => {
  await withTrace(async (tracePath, transport) => {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });
    const result = await runAgent({
      version: "v1",
      model: scriptedModel([
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
            toolCall("3", "finish_classification", finishArgs("www.notion.so")),
          ],
        },
      ]),
      interceptor,
      companyDomain: "notion.so",
    });
    assert.equal(result.final.company, "www.notion.so");
  });
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
          model,
          interceptor: replayer,
        }),
      // Protocol check rejects out-of-order Clay tools before interceptor mismatch.
      /violated required tool order/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("replay mismatch still surfaces when protocol order is correct but args diverge", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "agent-runner-"));
  const tracePath = join(workDir, "trace.jsonl");

  try {
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
      transport: {
        async call() {
          throw new Error("live should not be called");
        },
      },
      tracePath,
    });

    await assert.rejects(
      () =>
        runAgent({
          version: "v2",
          model: scriptedModel([
            {
              content: null,
              toolCalls: [
                toolCall("1", "find-and-enrich-company", {
                  companyIdentifier: "other.com",
                }),
              ],
            },
          ]),
          interceptor: replayer,
        }),
      (err: unknown) => err instanceof ReplayMismatchError,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
