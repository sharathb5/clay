# clay-record-replay

Record/replay layer for tool-using agents.

Freeze tool responses from a live run, then replay them later against another version of the agent.

## Why

To answer:

> Did agent behavior change, or did the outside world change?

Without a frozen tool environment, those two causes are entangled.

## Record vs strict replay

```
LIVE RECORD:   Agent → Interceptor → Live transport → append to trace → response
STRICT REPLAY: Agent → Interceptor → Trace only → response | explicit mismatch
```

| Mode | Behavior |
|------|----------|
| **record** | Forward each tool call to a live transport; append request + response to a trace |
| **strict_replay** | Serve only from a read-only trace; never call Clay, MCP, HTTP, or any live provider |

If a replay call cannot be matched, the run fails with an explicit mismatch. There is no silent live fallback.

Clay MCP (authenticated remote Streamable HTTP) is the real integration used for Phase 3 and the agent experiments. A local MCP stdio adapter covers deterministic verification without Clay credentials.

## Setup

```bash
npm install
```

Optional:

- Clay OAuth credentials for live Clay runs → gitignored `.clay-auth/` (via `npm run clay:list-tools`)
- `OPENROUTER_API_KEY` in a gitignored repo-root `.env` for agent / benchmark runs

## Verification

```bash
# Typecheck + unit tests + local MCP (no Clay credentials)
npm run verify:all

# Local MCP stdio only
npm run verify

# Same, while capturing output without hiding failures
npm run verify -- --tee /tmp/verify.log

# Authenticated Clay MCP (requires prior OAuth into .clay-auth/)
npm run verify:clay

# Focused unit tests
npm test

# Typecheck only
npm run typecheck
```

Do not capture verifier output with a bare `| tee` pipeline: without `pipefail`, a failing verifier can still yield exit status 0. Prefer `npm run verify -- --tee <file>`.

## Agent experiments

```bash
# First agent replay experiment (needs .clay-auth + OPENROUTER_API_KEY)
npm run experiment:agent-replay

# Frozen-trace variance (OPENROUTER_API_KEY; reuses an existing frozen trace; no Clay)
npm run experiment:agent-variance

# Labeled benchmark v1 (OPENROUTER_API_KEY; sealed freezes + gold; no Clay)
npm run experiment:agent-benchmark -- --runs 5
```

Real traces and run outputs stay in gitignored `.experiment-artifacts/`.

## Labeled frozen-trace benchmark v1

Human-labeled correctness check of two agent policies (V1 / V2) against six frozen Clay evidence cards.

**Purpose.** With the tool environment held fixed, measure agreement with sealed human gold labels, plus within-policy variance and between-policy differences.

**Cases** (gold labeled before any agent scoring):

| Domain | Human gold |
|--------|------------|
| `circleci.com` | `strong_fit` |
| `datadoghq.com` | `strong_fit` |
| `hubspot.com` | `weak_fit` |
| `canva.com` | `weak_fit` |
| `notion.so` | `weak_fit` |
| `linear.app` | `medium_fit` |

**Protocol.** Same two-call freeze per case (`find-and-enrich-company` → `get-task-context`). Scoring is replay-only against fail-closed Clay transport. OpenRouter `openai/gpt-4o-mini`; temperature/seed unset; `max_tokens` 512; `tool_choice` auto. **5** runs × **2** policies × **6** cases = **60** runs. Live Clay calls: **0**. Replay mismatches: **0**.

**Headline results** (agreement with sealed human labels):

| Policy | Correct / 30 | Accuracy | Modal-label accuracy (6 cases) |
|--------|--------------|----------|--------------------------------|
| V1     | 23           | 76.7%    | 5/6 (83.3%)                    |
| V2     | 25           | 83.3%    | 5/6 (83.3%)                    |

V2 had higher observed agreement with the six human-labeled frozen cases in this benchmark. The gap is concentrated on Notion (V1 consistently `medium_fit` vs gold `weak_fit`; V2 matched gold) and Linear (V1 matched gold `medium_fit`; V2 consistently `weak_fit`). HubSpot showed V1 within-policy variance (`weak_fit`/`medium_fit`); V2 was stable on gold.

**Limitations.** Six cases and five runs per policy; no statistical significance. Correctness means agreement with this sealed gold only. Model nondeterminism remains (temperature/seed unset).

**Approximate cost.** Combined ≈ $0.029.

Sealed gold + protocol metadata: `experiments/agent-benchmark/benchmark-v1.manifest.json`.

## Frozen-trace agent variance

Repeated strict replay of V1 and V2 against one frozen Notion (`notion.so`) Clay tool trace:

| Policy | strong_fit | medium_fit | weak_fit | unclear | Tool sequence |
|--------|------------|------------|----------|---------|---------------|
| V1     | 0          | 7 (70%)    | 3 (30%)  | 0       | 10/10 matched |
| V2     | 0          | 0          | 10 (100%)| 0       | 10/10 matched |

Freezing the tool environment removes Clay data drift as a confounder, so classification differences can be attributed to model variance or policy—not environment change.

## Layout

```
src/            interceptor, modes, trace read/write
adapters/       live transports (local MCP stdio; Clay MCP)
fixtures/       local MCP server for tests
scripts/        verification helpers
tests/          vertical slice + invariant proofs
experiments/    agent replay + labeled benchmark harness
```
