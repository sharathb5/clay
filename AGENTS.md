# AGENTS.md

## Project purpose

Record/replay execution layer for tool-using agents.

Freeze the external tool environment from a live run, then replay the same tool responses against another version of the agent. That lets us distinguish:

- **agent behavior changes**
- **environment / tool-result changes**

**Clay MCP is the first real backend. It is not the core.** The core stays transport-generic unless implementation evidence justifies coupling it to Clay. The first vertical slice uses a local fake tool (not Clay).

## Record / replay model

```
LIVE RECORD:  Agent → Interceptor → Live transport (MCP/tool) → record → response
STRICT REPLAY: Agent → Interceptor → Trace only → response | explicit mismatch failure
```

Strict replay never calls Clay, MCP, HTTP, or any live provider. If the trace cannot satisfy a call, fail visibly.

## Core modes

For now, only these modes exist:

| Mode | Behavior |
|------|----------|
| **record** | Forward to transport; append interactions to a write-target trace |
| **strict_replay** | Serve only from a read-only trace; no live I/O |

Mode is **explicit and sticky** for an execution (fixed on the interceptor instance). Do not document or implement hybrid/fork modes as current behavior.

## Terminology

| Term | Meaning |
|------|---------|
| **Interceptor** | Sole boundary for replayable tool execution |
| **Transport** | Live backend that executes tool calls (fake tool first; Clay later) |
| **Trace** | Immutable record of tool requests and responses from one record session |
| **Mismatch** | Replay call that cannot be matched to the trace — visible failure, not repaired |

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
  README.md          # short human overview
  src/               # interceptor, modes, trace read/write
  adapters/          # live transports (fake first; Clay later)
  fixtures/          # local fake tool for tests
  tests/             # vertical slice + invariant proofs
```

Keep flat until structure hurts. Do not add packages, services, or infra early.

## System invariants

1. **Strict replay never performs live tool execution.** Unsatisfied calls fail explicitly. No silent fallback to any live provider.
2. **Replayable tool execution crosses one interception boundary.** Callers must not reach Clay/MCP/HTTP in a way that bypasses record/replay. (Enforce harder once a second call path appears.)
3. **Recorded traces are immutable during replay.** Replay must not rewrite its source trace. Forking, if added later, is explicit and produces a new artifact.
4. **Replay mismatches are explicit.** Do not hide or auto-repair unmatched calls.
5. **Execution mode is explicit and sticky.** A run is record or strict replay; no quiet mid-run mode switching.

## Banned patterns (initial)

- Live transport use inside strict-replay code paths
- Catching replay mismatch and retrying live
- Mutating a trace opened for replay
- Recording by sniping HTTP/MCP outside the interceptor “for convenience”
- Clay-specific logic in the interceptor core
- Building UI, dashboards, graders, or prod infra in this foundation phase

## Verification discipline

> Do not trust an agent's account of its own work. Verify the behavior, and only automate what has been verified.

- Agents must **run** relevant verification (`npm run verify`, focused tests) rather than claim code should work.
- Important invariant checks must be **demonstrated failing** when the protected behavior is deliberately violated.
- Deliberate breaks are temporary verification techniques and must **never remain** in the repository.
- If verification stays green after the protected mechanism is removed, the verification is **invalid** until that is understood and fixed.
- Prefer testing **externally observable behavior** over implementation details.
- A green test alone is not sufficient evidence that an invariant is actually being exercised.

## Constraint escalation

1. Begin with written guidance (this file, `DECISIONS.md`).
2. Observe actual agent or implementation failure modes.
3. Only convert a rule into hard enforcement once there is evidence the stronger constraint is useful.
4. Do not add speculative lint rules, hooks, abstractions, or process infrastructure.

## Git discipline

- Commit regularly at coherent, **verified** boundaries.
- Each commit should represent one logical feature, behavior, architectural decision, or verification change.
- Prefer commits that leave the repository in a passing state.
- Run relevant verification before committing.
- Do not mix unrelated work.
- Do not create meaningless micro-commits.
- Never commit deliberate invariant-breaking mutations.
- Treat git history as durable project context.
- Commit messages should explain the logical change clearly.
- Do not create or commit ad hoc Markdown planning or scratch files. Durable project Markdown is limited to `README.md`, `AGENTS.md`, and `DECISIONS.md` unless another Markdown artifact is explicitly justified.

Before beginning a substantial phase, **propose the expected commit boundaries**. Boundaries may change as implementation teaches us more, but commits should follow actual architectural/behavioral units rather than arbitrary time intervals.

## Fresh-chat workflow

Major build steps should generally start in a **fresh Cursor conversation**.

Continuity should come primarily from:

- `AGENTS.md`
- `DECISIONS.md`
- repository code
- git history

rather than relying on a very long prior chat.

## Definition of done

A task is not done because the implementation appears correct.

It is done when the required behavior has actually been exercised through the appropriate verification.

### Phase 1 vertical slice (complete)

Proven with a **fake/local tool** (not Clay):

1. Start fake tool
2. Tool call through interceptor in **record** mode
3. Persist request + response
4. Stop/remove the fake tool
5. Same interaction in **strict replay**
6. Receive the recorded result
7. Prove **zero** live tool calls during replay

**Invariant proof requirement:** a passing test is not enough. Also demonstrate that if replay is deliberately wired to hit the live transport, verification **fails**. That negative demonstration is part of done.

## How coding agents should work

1. Re-read this file and `DECISIONS.md` before implementing.
2. Prefer the smallest change that advances the current slice.
3. For invariant-related changes: show both the positive path and a deliberate-break failure (or explain why not applicable).
4. Do not treat green tests as proof of isolation — isolation needs an explicit no-live-I/O check.
5. When a design question is open in `DECISIONS.md`, do not silently settle it in code; update `DECISIONS.md` if a choice becomes necessary.
6. Do not implement past the currently requested phase.
7. Do not settle open questions by inventing process infrastructure (hooks, CI, Cursor rules) without observed failure evidence.
