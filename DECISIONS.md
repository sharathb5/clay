# DECISIONS.md

Architecture decision log. Record choices we have actually made, with rationale and open alternatives. Do not treat undecided items as settled.

Format: `ADR-NNN` — status — date

---

## ADR-001 — Phase 0 delivers contract docs only

**Status:** Accepted (2026-09-16)

**Decision:** Before any product code, establish `AGENTS.md` (engineering contract) and this decision log.

**Why:** Trust in the coding agent is built incrementally. Constraints and mechanically checkable “done” come before implementation.

**Alternatives considered:** Jump straight to a skeleton package — rejected; invites invented structure without proven need.

---

## ADR-002 — First vertical slice uses a fake local MCP tool, not Clay

**Status:** Accepted (2026-09-16)

**Decision:** Prove record → persist → stop server → strict replay → no live I/O with a local fake tool server. Clay integration comes after that loop is real.

**Why:** Separates interceptor/trace correctness from Clay auth, networking, and product semantics. Faster failure observation; clearer invariant proofs.

**Alternatives considered:** Start with Clay MCP — rejected for slice 1; couples too many failure modes.

---

## ADR-003 — Core is transport-generic; Clay is an adapter

**Status:** Accepted (2026-09-16)

**Decision:** Interceptor and trace format speak “tool name + arguments + result,” not Clay APIs. Live backends implement a thin transport adapter. Clay is the first *real* adapter after the fake MCP.

**Why:** Slice 1 already needs a non-Clay transport. A one-boundary abstraction is cheap and matches the interception invariant. Clay-specific core would force rewrite when adding other tools.

**Risk:** Over-abstracting unused providers. Mitigation: one method-shaped boundary; add concepts only when a second real adapter demands them.

**Alternatives considered:**
- Clay-native core — simpler short-term, worse once non-Clay tools appear; complicates the fake-MCP slice.
- Fully protocol-agnostic “any RPC” — premature; MCP/tool-call shape is enough.

---

## ADR-004 — Strict replay is the only replay mode for now

**Status:** Accepted (2026-09-16)

**Decision:** Implement and document only **strict replay** (trace-only, explicit mismatch failure). Hybrid and forked replay remain open questions.

**Why:** One mode keeps the invariant testable. Extra modes invite silent fallbacks before we have evidence we need them.

---

## ADR-005 — Invariants encoded now; matching/storage details deferred

**Status:** Accepted (2026-09-16)

**Decision:** Encode the five system invariants in `AGENTS.md` as contract. Defer exact matching rules, trace file format, and schema versioning until implementation forces a choice — then log it here.

**Why:** Invariants are product claims. Serialization and matcher policy should be chosen against observed failures from the first slice, not speculated.

**Invariant critique notes (Phase 0):**
- Invariants 1, 3, 4: foundational — keep.
- Invariant 2 (single boundary): directionally required; hard multi-path enforcement can wait until a bypass appears.
- Added sticky explicit mode (invariant 5): closes “accidentally record during replay” without new machinery.

---

## ADR-006 — Methodology: prove invariants by deliberate break

**Status:** Accepted (2026-09-16)

**Decision:** For critical invariants (especially “strict replay never live”), done includes a demonstration that verification fails when the invariant is intentionally violated—not only a passing happy-path test.

**Why:** Green tests do not prove isolation. The coding agent must not equate “looks correct” with “invariant holds.”

---

## ADR-007 — Phase 1 runtime: TypeScript on Node

**Status:** Accepted (2026-09-16)

**Decision:** Implement slice 1 in TypeScript (ESM) on Node. Run with `tsx`; use Node’s built-in `node:test` for focused tests.

**Why:** Matches the MCP/tooling ecosystem we’ll eventually touch, keeps one language for interceptor + fake tool + verify script, and avoids adding a test framework dependency.

**Alternatives considered:** Python — deferred until a Python-first caller appears. Plain JS — rejected; types document the interception boundary cheaply.

---

## ADR-008 — Phase 1 fake tool is in-process, not MCP protocol

**Status:** Accepted (2026-09-16)

**Decision:** Slice 1 uses a deterministic in-process fake tool with explicit `start` / `stop`. `stop` makes live calls throw. No MCP SDK and no network for this proof.

**Why:** The invariant under test is “strict replay never hits live execution,” not MCP framing. An in-process kill switch is mechanically observable and makes accidental live calls fail hard during verification. Full MCP can wait for a real adapter.

**Alternatives considered:** Local HTTP fake server — stronger “network gone” story, more code than needed. Official MCP SDK — protocol surface distracts from the interceptor proof.

---

## ADR-009 — Trace format: JSONL on local disk

**Status:** Accepted (2026-09-16)

**Decision:** Persist traces as JSON Lines files. Each line is one interaction: `{ toolName, arguments, response }`. One file per record session. No schema version field yet.

**Why:** Append-friendly, human-diffable, zero infrastructure. Enough fields to replay exactly.

**Alternatives considered:** Single JSON array — fine, but JSONL matches append-during-record more naturally. Database — banned for this phase.

---

## ADR-010 — Matching: exact, ordered (consume next)

**Status:** Accepted (2026-09-16)

**Decision:** On strict replay, the next unused trace entry must deep-equal the call’s `toolName` and `arguments` (JSON-stable equality). Match by advancing a cursor in record order. No fuzzy/canonical matching. Mismatch or exhausted trace → explicit error. Mode does not switch.

**Why:** Smallest deterministic policy. Ordered consume handles duplicate identical calls without ambiguity. Fuzzy matching would hide drift we want to see.

**Alternatives considered:** Match-by-signature ignoring order — deferred. Canonicalized args — deferred until real key-order noise appears.

---

## ADR-011 — Mode is sticky on the interceptor instance

**Status:** Accepted (2026-09-16)

**Decision:** `createInterceptor({ mode: "record" | "strict_replay", ... })` fixes mode for that instance’s lifetime. Callers get one interception API (`call`). Record uses the transport; strict replay never calls it.

**Why:** Makes invariant 5 concrete. Prevents “fall back to live on mismatch” from looking like a convenience API.

---

## ADR-012 — Phase 1 layout stays flat under AGENTS.md paths

**Status:** Accepted (2026-09-16)

**Decision:** Use `src/` (interceptor + trace), `adapters/` (fake live transport), `fixtures/` (fake tool), `tests/` (verify + focused tests). Single package at repo root. No monorepo, no services.

**Why:** Matches the existing contract; enough separation to keep the interception boundary obvious.

---

# Open questions

Do not implement answers until a phase needs them. When settled, promote to an ADR.

### MCP client/server library

**Open.** Deferred past the in-process fake (ADR-008). Choose a maintained MCP SDK when wiring a real MCP transport or Clay.

### Agent branches absent from the original trace

**Open.** Under strict replay these are mismatches (visible failures). That is acceptable for regression. Hybrid/fork modes would address exploration later—out of scope now.

### Replay modes beyond strict

**Open.** Possible later: hybrid (replay when matched, live otherwise), forked (branch a new trace from a parent). Not until strict mode is proven and a concrete use case demands them. Any non-strict mode must make live I/O explicit in API and logs.

### Secrets / redaction

**Open.** Record mode may capture secrets from tool payloads. Need a policy before sharing traces. Do not block slice 1 local fixtures; do block “commit real Clay traces” without redaction rules.

### Trace schema versioning

**Open.** When format stabilizes, add an explicit schema version field and refuse unknown versions on read. Not a blocker for the first local fixture format.

### How Clay-specific the core should be

**Settled in principle by ADR-003** (generic core, Clay adapter). Remaining detail: how much MCP session/auth/lifecycle lives in the Clay adapter vs. a shared MCP transport helper — decide at Clay integration time.

### Language alternatives

**Settled for Phase 1 by ADR-007** (TypeScript/Node). Revisit if a primary caller is Python-first.
