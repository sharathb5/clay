/**
 * Deterministic fake live tool. start/stop make live execution
 * mechanically available or impossible (throws when stopped).
 */

export const LOOKUP_COMPANY = "lookup_company";

export interface FakeToolServer {
  /** Make live calls succeed. Resets the live-call counter. */
  start(): void;
  /** Make live calls throw. Live execution is unavailable. */
  stop(): void;
  /** Whether the live tool currently accepts calls. */
  isAvailable(): boolean;
  /** How many times the live implementation ran since last start. */
  liveCallCount(): number;
  /** Direct live invocation — used only by the transport adapter. */
  invoke(toolName: string, args: unknown): unknown;
}

export function createFakeToolServer(): FakeToolServer {
  let available = false;
  let calls = 0;

  return {
    start() {
      available = true;
      calls = 0;
    },
    stop() {
      available = false;
    },
    isAvailable() {
      return available;
    },
    liveCallCount() {
      return calls;
    },
    invoke(toolName: string, args: unknown): unknown {
      if (!available) {
        throw new Error("Live tool unavailable: fake server is stopped");
      }
      calls += 1;

      if (toolName !== LOOKUP_COMPANY) {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      const name =
        args &&
        typeof args === "object" &&
        "name" in args &&
        typeof (args as { name: unknown }).name === "string"
          ? (args as { name: string }).name
          : null;

      if (name === null) {
        throw new Error("lookup_company requires { name: string }");
      }

      // Fixed deterministic payload — domain content does not matter.
      return {
        name,
        employeeCount: 150,
        industry: "Software",
      };
    },
  };
}
