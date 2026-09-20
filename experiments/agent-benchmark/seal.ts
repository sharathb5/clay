/**
 * Seal a frozen trace by hashing its exact on-disk bytes.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
