import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInterceptor } from "../src/interceptor.ts";
import { parseTraceEntry, readTrace } from "../src/trace.ts";
import type { Transport } from "../src/types.ts";

test("parseTraceEntry rejects arrays and primitives", () => {
  assert.throws(
    () => parseTraceEntry([], "/tmp/t.jsonl", 1),
    /expected plain object/,
  );
  assert.throws(
    () => parseTraceEntry("find-and-enrich-company", "/tmp/t.jsonl", 2),
    /expected plain object/,
  );
  assert.throws(
    () => parseTraceEntry(null, "/tmp/t.jsonl", 3),
    /expected plain object/,
  );
});

test("parseTraceEntry rejects missing or empty toolName", () => {
  assert.throws(
    () =>
      parseTraceEntry(
        { arguments: {}, response: {} },
        "/tmp/t.jsonl",
        1,
      ),
    /missing toolName/,
  );
  assert.throws(
    () =>
      parseTraceEntry(
        { toolName: "", arguments: {}, response: {} },
        "/tmp/t.jsonl",
        2,
      ),
    /toolName must be a non-empty string/,
  );
});

test("parseTraceEntry rejects missing arguments or response properties", () => {
  assert.throws(
    () =>
      parseTraceEntry(
        { toolName: "lookup", response: null },
        "/tmp/t.jsonl",
        1,
      ),
    /missing arguments property/,
  );
  assert.throws(
    () =>
      parseTraceEntry(
        { toolName: "lookup", arguments: null },
        "/tmp/t.jsonl",
        2,
      ),
    /missing response property/,
  );
});

test("parseTraceEntry accepts null arguments and response", () => {
  const entry = parseTraceEntry(
    { toolName: "lookup", arguments: null, response: null },
    "/tmp/t.jsonl",
    1,
  );
  assert.equal(entry.toolName, "lookup");
  assert.equal(entry.arguments, null);
  assert.equal(entry.response, null);
});

test("readTrace reports path and line for malformed entries", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "trace-validate-"));
  const tracePath = join(workDir, "trace.jsonl");
  try {
    await writeFile(
      tracePath,
      [
        JSON.stringify({
          toolName: "ok",
          arguments: {},
          response: {},
        }),
        JSON.stringify({ toolName: "bad", arguments: {} }),
      ].join("\n") + "\n",
      "utf8",
    );
    await assert.rejects(
      () => readTrace(tracePath),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(`${tracePath}:2`) &&
        err.message.includes("missing response property"),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("mutating a replayed object response does not alter stored evidence", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "replay-clone-"));
  const tracePath = join(workDir, "trace.jsonl");
  try {
    await writeFile(
      tracePath,
      `${JSON.stringify({
        toolName: "lookup",
        arguments: { name: "Linear" },
        response: { nested: { value: 1 }, list: [1, 2] },
      })}\n`,
      "utf8",
    );

    const transport: Transport = {
      async call() {
        throw new Error("live must not be called");
      },
    };

    const first = await createInterceptor({
      mode: "strict_replay",
      transport,
      tracePath,
    });
    const response = (await first.call("lookup", {
      name: "Linear",
    })) as { nested: { value: number }; list: number[] };
    response.nested.value = 99;
    response.list.push(3);

    const second = await createInterceptor({
      mode: "strict_replay",
      transport,
      tracePath,
    });
    const again = (await second.call("lookup", {
      name: "Linear",
    })) as { nested: { value: number }; list: number[] };
    assert.deepEqual(again, { nested: { value: 1 }, list: [1, 2] });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("concurrent record calls preserve invocation order", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "record-order-"));
  const tracePath = join(workDir, "trace.jsonl");

  let releaseA!: () => void;
  const aGate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let bStarted = false;

  const transport: Transport = {
    async call(toolName) {
      if (toolName === "A") {
        await aGate;
        return { from: "A" };
      }
      if (toolName === "B") {
        bStarted = true;
        return { from: "B" };
      }
      throw new Error(`unexpected ${toolName}`);
    },
  };

  try {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });

    const callA = interceptor.call("A", { n: 1 });
    // Allow A to enter the queue and hit its gate before starting B.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bStarted, false);
    const callB = interceptor.call("B", { n: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    // B is queued behind A, so its transport must not start until A finishes.
    assert.equal(bStarted, false);

    releaseA();
    await Promise.all([callA, callB]);

    const entries = await readTrace(tracePath);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].toolName, "A");
    assert.equal(entries[1].toolName, "B");
    assert.equal(bStarted, true);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("record queue continues after a failed transport call", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "record-fail-"));
  const tracePath = join(workDir, "trace.jsonl");
  let calls = 0;

  const transport: Transport = {
    async call(toolName) {
      calls += 1;
      if (toolName === "fail") {
        throw new Error("transport boom");
      }
      return { ok: toolName };
    },
  };

  try {
    const interceptor = await createInterceptor({
      mode: "record",
      transport,
      tracePath,
    });

    await assert.rejects(() => interceptor.call("fail", {}), /transport boom/);
    const ok = await interceptor.call("ok", { n: 1 });
    assert.deepEqual(ok, { ok: "ok" });
    assert.equal(calls, 2);

    const entries = await readTrace(tracePath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].toolName, "ok");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
