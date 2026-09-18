/**
 * Gitignored local credential store for Phase 3 Clay OAuth (ADR-018).
 * Persists DCR client registration + tokens only. PKCE stays ephemeral.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Default ignored auth directory under the repo root. */
export const CLAY_AUTH_DIR = join(repoRoot, ".clay-auth");
export const CLAY_CREDENTIALS_PATH = join(CLAY_AUTH_DIR, "credentials.json");

export interface ClayCredentialFile {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}

async function atomicWriteJson(
  path: string,
  data: ClayCredentialFile,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export async function loadClayCredentials(
  path: string = CLAY_CREDENTIALS_PATH,
): Promise<ClayCredentialFile> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ClayCredentialFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export async function saveClayCredentials(
  data: ClayCredentialFile,
  path: string = CLAY_CREDENTIALS_PATH,
): Promise<void> {
  await atomicWriteJson(path, data);
}

/**
 * Update tokens (including rotated refresh_token) while preserving client registration.
 */
export async function saveClayTokens(
  tokens: StoredOAuthTokens,
  path: string = CLAY_CREDENTIALS_PATH,
): Promise<void> {
  const current = await loadClayCredentials(path);
  await atomicWriteJson(path, {
    ...current,
    tokens,
  });
}

export async function saveClayClientInformation(
  clientInformation: StoredOAuthClientInformation,
  path: string = CLAY_CREDENTIALS_PATH,
): Promise<void> {
  const current = await loadClayCredentials(path);
  await atomicWriteJson(path, {
    ...current,
    clientInformation,
  });
}

/** Remove tokens from the store (keeps DCR client registration when present). */
export async function clearClayTokens(
  path: string = CLAY_CREDENTIALS_PATH,
): Promise<void> {
  const current = await loadClayCredentials(path);
  const next: ClayCredentialFile = {};
  if (current.clientInformation) {
    next.clientInformation = current.clientInformation;
  }
  await atomicWriteJson(path, next);
}
