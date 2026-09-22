import {
  appendTraceEntry,
  clearTrace,
  readTrace,
  stableEqual,
} from "./trace.ts";
import type { Mode, TraceEntry, Transport } from "./types.ts";

export class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayMismatchError";
  }
}

export interface InterceptorOptions {
  mode: Mode;
  transport: Transport;
  tracePath: string;
}

export interface Interceptor {
  readonly mode: Mode;
  call(toolName: string, args: unknown): Promise<unknown>;
}

/**
 * Sole interception boundary for replayable tool execution.
 * Mode is sticky for the lifetime of this instance.
 */
export async function createInterceptor(
  options: InterceptorOptions,
): Promise<Interceptor> {
  const { mode, transport, tracePath } = options;

  if (mode === "record") {
    await clearTrace(tracePath);
    // Serialize record-mode calls so trace order matches invocation order,
    // even when transports resolve out of order. Queue advances after failures.
    let recordQueue: Promise<unknown> = Promise.resolve();

    return {
      mode,
      async call(toolName: string, args: unknown): Promise<unknown> {
        const scheduled = recordQueue.then(async () => {
          const response = await transport.call(toolName, args);
          const entry: TraceEntry = {
            toolName,
            arguments: args,
            response,
          };
          await appendTraceEntry(tracePath, entry);
          return response;
        });
        recordQueue = scheduled.then(
          () => undefined,
          () => undefined,
        );
        return scheduled;
      },
    };
  }

  // strict_replay: serve only from the immutable trace. Never call transport.
  const entries = await readTrace(tracePath);
  let cursor = 0;

  return {
    mode,
    async call(toolName: string, args: unknown): Promise<unknown> {
      if (cursor >= entries.length) {
        throw new ReplayMismatchError(
          `Replay mismatch: no remaining trace entries for ${toolName}`,
        );
      }

      const expected = entries[cursor];
      const nameOk = expected.toolName === toolName;
      const argsOk = stableEqual(expected.arguments, args);

      if (!nameOk || !argsOk) {
        throw new ReplayMismatchError(
          `Replay mismatch at index ${cursor}: expected ${JSON.stringify({
            toolName: expected.toolName,
            arguments: expected.arguments,
          })}, got ${JSON.stringify({ toolName, arguments: args })}`,
        );
      }

      cursor += 1;
      // Clone so callers cannot mutate in-memory replay evidence.
      return structuredClone(expected.response);
    },
  };
}
