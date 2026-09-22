import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TraceEntry } from "./types.ts";

/**
 * Deterministic structural equality (ADR-014).
 * Object key order does not matter; array order and value types do.
 */
export function stableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (a === null || b === null || typeof a !== "object") {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!stableEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) {
      return false;
    }
  }
  for (const key of aKeys) {
    if (
      !stableEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function clearTrace(tracePath: string): Promise<void> {
  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, "", "utf8");
}

export async function appendTraceEntry(
  tracePath: string,
  entry: TraceEntry,
): Promise<void> {
  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Runtime validation at the read boundary; arguments/response may be null. */
export function parseTraceEntry(
  value: unknown,
  tracePath: string,
  lineNumber: number,
): TraceEntry {
  if (!isPlainObject(value)) {
    throw new Error(
      `Invalid trace entry at ${tracePath}:${lineNumber}: expected plain object`,
    );
  }
  if (!("toolName" in value)) {
    throw new Error(
      `Invalid trace entry at ${tracePath}:${lineNumber}: missing toolName`,
    );
  }
  if (typeof value.toolName !== "string" || value.toolName.length === 0) {
    throw new Error(
      `Invalid trace entry at ${tracePath}:${lineNumber}: toolName must be a non-empty string`,
    );
  }
  if (!("arguments" in value)) {
    throw new Error(
      `Invalid trace entry at ${tracePath}:${lineNumber}: missing arguments property`,
    );
  }
  if (!("response" in value)) {
    throw new Error(
      `Invalid trace entry at ${tracePath}:${lineNumber}: missing response property`,
    );
  }
  return {
    toolName: value.toolName,
    arguments: value.arguments,
    response: value.response,
  };
}

export async function readTrace(tracePath: string): Promise<TraceEntry[]> {
  let raw: string;
  try {
    raw = await readFile(tracePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Trace not found: ${tracePath}`);
    }
    throw err;
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL at ${tracePath}:${lineNumber}`);
    }
    return parseTraceEntry(parsed, tracePath, lineNumber);
  });
}

export async function traceExistsAndNonEmpty(tracePath: string): Promise<boolean> {
  try {
    const raw = await readFile(tracePath, "utf8");
    return raw.split("\n").some((line) => line.trim().length > 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }
}
