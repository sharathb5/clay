/** Sticky execution mode for one interceptor instance. */
export type Mode = "record" | "strict_replay";

/** Live backend behind the interception boundary. */
export interface Transport {
  call(toolName: string, args: unknown): Promise<unknown>;
}

/** One recorded tool interaction. */
export interface TraceEntry {
  toolName: string;
  arguments: unknown;
  response: unknown;
}
