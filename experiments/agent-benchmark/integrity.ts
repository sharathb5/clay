/**
 * Benchmark integrity helpers (hash checks only; no Clay I/O).
 */

import { sha256File } from "./seal.ts";

/**
 * Refuse to proceed when on-disk frozen trace bytes do not match the sealed hash.
 */
export async function assertFrozenTraceSha256(
  tracePath: string,
  expectedSha256: string,
): Promise<string> {
  const actual = await sha256File(tracePath);
  if (actual !== expectedSha256) {
    throw new Error(
      `BENCHMARK FAILED: trace hash mismatch for ${tracePath}: manifest=${expectedSha256} on-disk=${actual}`,
    );
  }
  return actual;
}
