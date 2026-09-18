import assert from "node:assert/strict";
import { test } from "node:test";
import { stableEqual } from "../src/trace.ts";

test("object key order does not matter", () => {
  assert.equal(
    stableEqual({ name: "Linear", limit: 5 }, { limit: 5, name: "Linear" }),
    true,
  );
});

test("primitive types matter", () => {
  assert.equal(stableEqual({ limit: 5 }, { limit: "5" }), false);
  assert.equal(stableEqual(5, "5"), false);
  assert.equal(stableEqual(null, undefined), false);
});

test("array order is meaningful", () => {
  assert.equal(stableEqual([1, 2], [1, 2]), true);
  assert.equal(stableEqual([1, 2], [2, 1]), false);
});

test("nested objects compare structurally", () => {
  assert.equal(
    stableEqual(
      { outer: { b: 2, a: 1 }, list: [1, { z: 9, y: 8 }] },
      { list: [1, { y: 8, z: 9 }], outer: { a: 1, b: 2 } },
    ),
    true,
  );
});

test("missing keys are not equivalent", () => {
  assert.equal(stableEqual({ name: "Linear", limit: 5 }, { name: "Linear" }), false);
});
