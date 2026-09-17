import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TraceEntry } from "./types.ts";

/** Stable deep equality via JSON serialization (slice-1 exact match). */
export function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
    try {
      return JSON.parse(line) as TraceEntry;
    } catch {
      throw new Error(`Invalid JSONL at ${tracePath}:${index + 1}`);
    }
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
