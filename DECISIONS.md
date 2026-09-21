# DECISIONS.md

Architecture decision log. Record choices we have actually made, with rationale and open alternatives. Do not treat undecided items as settled.

## Conventions

- **Append-only.** Decisions are historical context. Do not silently rewrite or delete past ADRs.
- **Supersession.** Later ADRs may supersede earlier ones; mark status clearly (e.g. Superseded by ADR-NNN) rather than editing out the old choice.
- **Unresolved stays unresolved.** Open questions remain visibly open until a phase needs them and an ADR adopts a choice.
- **Recommendations ≠ decisions.** A suggestion in chat or docs is not settled until recorded here as Accepted (or equivalent).
- **Include reasoning.** Capture why, alternatives considered, and risks—not only the final choice.

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

**Status:** Superseded by ADR-013 (2026-09-17)

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

**Status:** Superseded by ADR-014 (2026-09-17)

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

## ADR-013 — Phase 2 live boundary is local MCP over stdio

**Status:** Accepted (2026-09-17)

**Decision:** Phase 2 replaces the in-process fake (ADR-008) with a real local MCP client/server boundary using official TypeScript MCP v2 packages `@modelcontextprotocol/client` and `@modelcontextprotocol/server`, over **stdio**. The MCP transport adapter implements the existing `Transport` interface. Process spawn, JSON-RPC framing, and `callTool` live only in the adapter; the interceptor stays protocol-agnostic. The local server exposes one deterministic tool (`lookup_company`). After record, the verifier fully stops the MCP process so live calls fail mechanically.

**Why:** Answers whether record/replay works at the MCP protocol boundary, not only against an in-process kill switch. Stdio gives real serialization, a separate server process, and unavailable-backend proof without port/network complexity.

**Alternatives considered:**
- Streamable HTTP — real MCP, but bind/port races and more teardown than needed for this proof.
- In-process MCP transport — less process lifecycle risk, but does not prove “server unavailable after shutdown.”
- Legacy monolithic `@modelcontextprotocol/sdk` (v1) — superseded by the split v2 client/server packages.

**Risk:** Child-process cleanup must be reliable or isolation proofs become flaky. Mitigation: adapter owns connect/close; verifier asserts direct live calls fail after stop.

---

## ADR-014 — Matching: structural equality, ordered consume

**Status:** Accepted (2026-09-17)

**Decision:** On strict replay, the next unused trace entry must match `toolName` (string equality) and `arguments` via **deterministic structural equality**. Cursor still advances in record order. Mismatch or exhausted trace → explicit `ReplayMismatchError`. No mode switch, fallback, or repair.

**Structural equality semantics:**
- Primitives and `null`/`undefined`: same type and `===` value (`5` ≠ `"5"`).
- Arrays: same length; elements compared in order (order is meaningful).
- Plain objects: same key set; key **order does not matter**; values compared structurally.
- No coercion, fuzzy matching, semantic matching, LLM matching, typo tolerance, or unordered-array treatment.

**Why:** Real tool payloads are JSON objects whose key order is not semantically meaningful. Phase 1 `JSON.stringify` equality (ADR-010) was acceptable for the first proof but fails equivalent reordered arguments. Structural equality keeps mismatches explainable and deterministic.

**Alternatives considered:**
- Keep JSON-stable / key-order-sensitive equality — rejected; fails on equivalent MCP-shaped payloads.
- Canonicalize then stringify — equivalent outcome, but an explicit recursive comparator documents the rules better.
- Fuzzy / semantic / LLM matching — banned; would hide drift we want to see.

---

## ADR-015 — MCP adapter returns normalized tool result, not protocol envelope

**Status:** Accepted (2026-09-17)

**Decision:** The MCP transport adapter’s `Transport.call` returns a stable tool-level result for the interceptor/trace: prefer `structuredContent` when the MCP `callTool` result provides it; otherwise a minimal replayable projection of content. The full MCP `CallToolResult` envelope is not stored in the trace. Trace shape remains `{ toolName, arguments, response }` (ADR-009).

**Why:** Keeps the core and traces tool-semantic (ADR-003). Protocol framing stays behind the adapter. Callers and replay compare business-shaped results, not SDK envelope fields.

**Alternatives considered:** Record the full `CallToolResult` — more faithful to the wire, but couples traces to MCP envelope shape and leaks protocol into the core/replay surface.

---

## ADR-016 — Phase 3 live boundary is remote Clay MCP over Streamable HTTP

**Status:** Accepted (2026-09-17)

**Decision:** Phase 3 replaces the local stdio MCP backend (ADR-013) as the *Clay proof* boundary with Clay’s hosted MCP endpoint (`https://api.clay.com/v3/mcp`) using the official TypeScript MCP client’s `StreamableHTTPClientTransport`. The Clay adapter still implements the existing generic `Transport` interface. OAuth, HTTP, MCP session headers, and Clay product semantics stay inside the adapter. The Phase 2 local stdio adapter remains as a non-Clay regression path.

**Why:** Answers whether the same interceptor/trace core can record a real authenticated Clay interaction and replay it with Clay entirely removed. Streamable HTTP matches Clay’s remote MCP interface; stdio cannot.

**Alternatives considered:**
- Reuse only stdio against a Clay-spawned local process — Clay does not offer self-hosted MCP.
- Hand-rolled HTTP JSON-RPC without the SDK — duplicates session/OAuth handling the SDK already owns.
- Change the generic `Transport` shape for sessions/auth — rejected until evidence shows `call(toolName, args)` is insufficient.

**Risk:** Remote auth and network flakiness. Mitigation: keep Phase 2 verify green; isolate Clay proof behind a separate verifier that requires local credentials.

---

## ADR-017 — Local CLI uses public PKCE-only OAuth via Dynamic Client Registration

**Status:** Accepted (2026-09-17)

**Decision:** Authenticate the Phase 3 CLI as a **public** OAuth client: Dynamic Client Registration with `token_endpoint_auth_method: "none"`, authorization-code grant, PKCE S256, loopback redirect (`http://127.0.0.1`), and scope `mcp`. No client secret is invented or required. Device-code is not used (Clay DCR does not accept that grant for registered clients). Interactive browser consent is required for the first authorization; do not fake or bypass it.

**Why:** Matches Clay’s documented path for local/native/CLI clients that cannot keep a secret. Loopback redirects are explicitly allowed. One developer, one workspace, one Phase 3 proof.

**Alternatives considered:**
- Confidential client with `client_secret` — inappropriate for a local CLI that cannot protect a secret.
- Device authorization grant — advertised by Clay’s AS metadata, but DCR only accepts `authorization_code` / `refresh_token`.
- Pre-registered / manually provisioned client — unnecessary; DCR is open and rate-limited for once-per-install use.

---

## ADR-018 — Credential persistence and trace isolation for Clay auth

**Status:** Accepted (2026-09-17)

**Decision:** Persist only what is needed across runs in a **gitignored** local store (`.clay-auth/`): DCR client registration metadata, access token (optional but useful), refresh token, and token expiry / required token metadata. PKCE verifier/challenge material stays **ephemeral** for the active authorization attempt (in-memory); do not persist it across process restarts unless a concrete SDK recovery requirement appears. On refresh-token rotation, replace the stored refresh token so the retired token is never reused. OAuth credentials, authorization codes, PKCE material, access/refresh tokens, Clay session identifiers, and auth headers must **never** be written into replay traces, fixtures, docs, or logs.

Broader redaction of arbitrary tool *payload* secrets remains open (see Open questions).

**Why:** Phase 3 is the first credential-bearing boundary. Trace artifacts must remain safe to inspect for replay proofs without leaking auth material. Ephemeral PKCE matches the single-process interactive flow.

**Alternatives considered:**
- Persist PKCE verifier to disk for crash recovery mid-auth — unnecessary for a short interactive CLI wait.
- Production keychain / multi-user auth service — banned for this phase.
- Embed tokens in env-only with no file — workable, but refresh rotation and DCR caching need durable local state for reruns.

---

## ADR-019 — Clay MCP uses legacy initialize negotiation; session stays in the adapter

**Status:** Accepted (2026-09-17)

**Decision:** Connect the Clay MCP client with protocol version negotiation `mode: 'legacy'` (SDK default): plain `initialize` handshake, no modern `server/discover` probe. Clay’s interface requires initialize and subsequent `Mcp-Session-Id` handling; the SDK’s Streamable HTTP transport owns session headers. Inspect negotiated era during development if useful; do **not** record protocol/era/session metadata in replay traces. After record, terminate/close the live session so replay cannot reach Clay.

**Why:** Clay’s documented remote MCP flow is initialize-then-session, not the 2026 modern discover era. Forcing modern negotiation because the client SDK supports it would risk incompatibility without benefit. Protocol metadata in traces would couple replay artifacts to transport details (conflicts with ADR-015).

**Alternatives considered:**
- `mode: 'auto'` — extra probe round-trip; falls back to legacy, but unnecessary once Clay is known to need initialize/session.
- Hand-manage `Mcp-Session-Id` outside the SDK — duplicates what Streamable HTTP already does.

---

## ADR-020 — First agent experiment lives outside the interceptor core

**Status:** Accepted (2026-09-18)

**Decision:** Put the first tool-using agent + Clay replay experiment under `experiments/agent-replay/`. The interceptor, trace format, and adapters stay unchanged. Agent code calls Clay only through `interceptor.call`.

**Why:** Proves replay usefulness for comparing agent policies without turning the foundation into an eval platform or coupling the core to a model provider.

**Alternatives considered:** Agent runner inside `src/` — rejected; blurs the interception boundary with provider/policy code.

---

## ADR-021 — Single LLM provider: OpenRouter via local `.env`

**Status:** Accepted (2026-09-18)

**Decision:** Use OpenRouter’s OpenAI-compatible Chat Completions API (fetch, no SDK) as the sole model provider for this experiment. Read `OPENROUTER_API_KEY` from a gitignored repo-root `.env` (or the process environment). Do not commit keys or put them in traces/artifacts.

**Why:** One provider keeps the boundary small. OpenRouter was the key the operator could supply. `.env` avoids exporting secrets into the shell history while remaining local-only.

**Alternatives considered:** Direct OpenAI — deferred when the operator preferred OpenRouter. Multi-provider abstraction — banned for this phase.

---

## ADR-022 — Agent metadata stays outside the tool-trace schema

**Status:** Accepted (2026-09-18)

**Decision:** Keep core JSONL trace entries as `{ toolName, arguments, response }`. Write agent version, final classification, observed tool sequence, and comparison text to separate gitignored artifacts under `.experiment-artifacts/`.

**Why:** No evidence yet that the core schema must expand. Mixing model outputs into the tool trace would blur environment freeze vs agent behavior.

---

## ADR-023 — First agent replay experiment: Outcome A with model nondeterminism

**Status:** Accepted (2026-09-18)

**Decision:** Record the first agent-level Clay experiment as complete: V1 live-record of `notion.so` ICP classification through `find-and-enrich-company` → `get-task-context`, then V1 and V2 strict replay against the same fail-closed trace. Clay credit booleans were unchanged; both replays had zero live Clay calls. V2 matched the tool sequence (Outcome A). V1 live vs V1 replay classifications differed (`weak_fit` vs `medium_fit`), so tool-environment freeze is proven while agent text/decisions remain nondeterministic.

**Why:** Answers whether replay is useful for comparing policies against a fixed Clay environment without building an eval platform. Honest reporting of nondeterminism is part of the claim.

**Next-replay lesson:** Strict sequential replay is enough when policies share a tool strategy. Hybrid/fork remains open for divergent tool strategies (still unresolved; see Open questions). Temperature/seed controls were not added — out of scope for proving environment freeze.

---

## ADR-024 — Labeled frozen-trace benchmark: recording decisions

**Status:** Accepted (2026-09-19)

**Decision:** Begin a small human-labeled correctness benchmark against frozen Clay evidence. This ADR settles the **recording subphase** only (deterministic freeze + seal + evidence cards). Gold labels, V1/V2 scoring, and result docs come later and must not precede human review of the six frozen cases.

**Active benchmark v1 roster (coverage intent, not gold):**

| Domain | Slot intent |
|--------|-------------|
| `circleci.com` | clear developer-infrastructure fit |
| `datadoghq.com` | clear developer-infrastructure fit |
| `hubspot.com` | clear non-fit (CRM / marketing) |
| `canva.com` | clear non-fit (design / creative tooling) |
| `notion.so` | borderline (productivity / collab) |
| `linear.app` | borderline (eng workflow adjacency) |

**Roster amendment (2026-09-20):** The original accepted roster used `figma.com` as the second clear-non-fit control. After deterministic recording, the frozen Figma evidence had identity/evidence-quality ambiguity (requested `figma.com`; returned domain/website `figma.bot`; description only a Config 2026 blurb) and was judged insufficiently clean for that control. Figma was **excluded** from benchmark v1 for evidence-quality reasons (not because of Figma’s real-world ICP classification). Artifacts remain under `cases/figma/` and are listed in `EXCLUDED_FROM_BENCHMARK_V1`. `canva.com` was recorded as the replacement clear-non-fit case. Subset re-recording uses `record.ts --only <id>`.

**Recording protocol (identical for every case):**

1. Through interceptor `record` mode only: `find-and-enrich-company({ companyIdentifier: <domain> })`
2. Then `get-task-context({ taskId })` using the returned `taskId`
3. No `companyDataPoints`, enrichments, subroutines, contacts tools, or mutations
4. No live agent / LLM participates in creating benchmark traces

**Notion:** Re-record into the benchmark artifact tree with the same deterministic recorder. The prior experiment trace under `.experiment-artifacts/agent-replay/` remains untouched for previous experiments.

**Artifacts:**

- Raw frozen traces + mechanically derived evidence cards: gitignored under `.experiment-artifacts/agent-benchmark/`
- After seal, compute SHA-256 of each frozen JSONL immediately
- A sanitized recording manifest (domains, hashes, protocol pins, redacted credits metadata — **no raw Clay payloads, no gold labels**) may be committed later; not until operators review the six freezes
- Evidence cards contain only fields needed for human labeling and must not include V1/V2 output or automatic gold labels

**Why:** Correctness vs consistency requires human gold applied to fixed evidence. Deterministic recording removes agent-driven tool drift from the freeze. Separating recording from labeling/scoring prevents gold contamination.

**Out of scope for this ADR:** eval platform/UI, LLM judges, hybrid/fork replay, changing V1/V2 policies, committing raw Clay traces, automatic gold assignment, V1/V2 benchmark runs.

**Alternatives considered:**
- Reuse the existing Notion agent-recorded freeze for protocol uniformity — rejected; all six cases must share the deterministic recorder
- V1 live-agent record for freezes — rejected; non-deterministic tool depth
- Commit raw traces — rejected (ADR-018 / open payload-redaction question)

---

# Open questions

Do not implement answers until a phase needs them. When settled, promote to an ADR.

### MCP client/server library

**Settled for Phase 2 by ADR-013** (stdio). **Settled for Phase 3 Clay by ADR-016** (`StreamableHTTPClientTransport` from the same `@modelcontextprotocol/client` v2 package). Local stdio remains the non-Clay regression adapter.

### Agent branches absent from the original trace

**Open.** Under strict replay these are mismatches (visible failures). That is acceptable for regression. Hybrid/fork modes would address exploration later—out of scope now.

### Replay modes beyond strict

**Open.** Possible later: hybrid (replay when matched, live otherwise), forked (branch a new trace from a parent). Not until strict mode is proven and a concrete use case demands them. Any non-strict mode must make live I/O explicit in API and logs.

### Secrets / redaction

**Partially settled by ADR-018** for auth/session material (must never enter traces). **Still open** for redacting secrets that may appear inside tool *payloads* before sharing traces. Do not commit real Clay traces without that broader policy.

### Trace schema versioning

**Open.** When format stabilizes, add an explicit schema version field and refuse unknown versions on read. Not a blocker for the first local fixture format.

### How Clay-specific the core should be

**Settled by ADR-003 + ADR-016 + ADR-019:** generic core and `Transport` unchanged; all Clay OAuth, HTTP, session, and MCP envelope handling lives in the Clay adapter. Revisit only if implementation evidence shows `call(toolName, args)` is insufficient.

### Language alternatives

**Settled for Phase 1 by ADR-007** (TypeScript/Node). Revisit if a primary caller is Python-first.
