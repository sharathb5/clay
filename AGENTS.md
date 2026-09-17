# AGENTS.md

Record/replay interception for tool-using agents. Freeze the external tool environment so agent changes can be tested without world drift.

**Clay MCP is the first real backend. It is not the core.** First vertical slice uses a fake local MCP tool.

## Record / replay model

```
LIVE RECORD:  Agent → Interceptor → Live transport (MCP/tool) → record → response
STRICT REPLAY: Agent → Interceptor → Trace only → response | explicit mismatch failure
```

Strict replay never calls Clay, MCP, HTTP, or any live provider. If the trace cannot satisfy a call, fail visibly.

## Terminology

| Term | Meaning |
|------|---------|
| **Interceptor** | Sole boundary for replayable tool execution |
| **Transport** | Live backend that executes tool calls (fake MCP, later Clay) |
| **Trace** | Immutable record of tool requests and responses from one record session |
| **Record mode** | Forward to transport; append interactions to a write-target trace |
| **Strict replay** | Serve only from a read-only trace; no live I/O |
| **Mismatch** | Replay call that cannot be matched to the trace — visible failure, not repaired |

Modes not in scope yet: hybrid replay, forked/branched traces.

## Intended architecture (slice 1)

```
Agent / caller
    → interceptor (mode: record | strict_replay)
        → record: transport.call → append to trace → return
        → replay: match trace → return | fail mismatch
```

- One interception API for tool calls.
- Transports are adapters behind that API.
- Trace IO is separate from transport.
- No UI, eval dashboard, graders, or Clay business workflows.

## Repository layout

```
/
  AGENTS.md          # this contract
  DECISIONS.md       # architecture decision log
  src/               # interceptor, modes, trace read/write (when implemented)
  adapters/          # live transports (fake MCP first; Clay later)
  fixtures/          # local fake tool server for tests
  tests/             # vertical slice + invariant proofs
```

Keep flat until structure hurts. Do not add packages, services, or infra early.

## System invariants

1. **Strict replay never performs live tool execution.** Unsatisfied calls fail explicitly. No silent fallback to any live provider.
2. **Replayable tool execution crosses one interception boundary.** Callers must not reach Clay/MCP/HTTP in a way that bypasses record/replay. (Enforce harder once a second call path appears.)
3. **Recorded traces are immutable during replay.** Replay must not rewrite its source trace. Forking, if added later, is explicit and produces a new artifact.
4. **Replay mismatches are visible.** Do not hide or auto-repair unmatched calls.
5. **Mode is explicit per session.** A run is record or strict replay; no quiet mid-run mode switching.

## Banned patterns (initial)

- Live transport use inside strict-replay code paths
- Catching replay mismatch and retrying live
- Mutating a trace opened for replay
- Recording by sniping HTTP/MCP outside the interceptor “for convenience”
- Clay-specific logic in the interceptor core
- Building UI, dashboards, graders, or prod infra in this foundation phase

## Definition of done — first vertical slice

Prove this loop with a **fake/local MCP tool** (not Clay):

1. Start fake tool server
2. Tool call through interceptor in **record** mode
3. Persist request + response
4. Stop/remove the fake server
5. Same interaction in **strict replay**
6. Receive the recorded result
7. Prove **zero** live tool/network calls during replay

**Invariant proof requirement:** a passing test is not enough. Also demonstrate that if replay is deliberately wired to hit the live transport, verification **fails**. That negative demonstration is part of done.

## How coding agents should verify work

1. Re-read this file and `DECISIONS.md` before implementing.
2. Prefer the smallest change that advances the current slice.
3. For invariant-related changes: show both the positive path and a deliberate-break failure (or explain why not applicable).
4. Do not treat green tests as proof of isolation — isolation needs an explicit no-live-I/O check.
5. When a design question is open in `DECISIONS.md`, do not silently settle it in code; update `DECISIONS.md` if a choice becomes necessary.
6. Do not implement past the currently requested phase.
