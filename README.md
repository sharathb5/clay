# clay-record-replay

Record/replay layer for tool-using agents.

Freeze tool responses from a live run, then replay them later against another version of the agent.

## Why

To answer:

> Did agent behavior change, or did the outside world change?

## Current status

**First agent replay experiment complete** (`npm run experiment:agent-replay`):

- Minimal OpenRouter-backed agent under `experiments/agent-replay/`
- V1 live record against Clay (`notion.so` developer-infrastructure ICP)
- V1 + V2 strict replay on the same frozen trace (fail-closed; zero live Clay)
- Outcome A: same tool sequence; policy comparison with environment held fixed
- Model nondeterminism observed (V1 live vs V1 replay classifications can differ)
- Real traces/outputs stay in gitignored `.experiment-artifacts/`

**Frozen-trace agent variance complete** (`npm run experiment:agent-variance`):

- 10× V1 and 10× V2 strict replay against the same Notion Clay trace (zero live Clay)
- Separates model sampling variance from policy effect with environment held fixed
- See [Frozen-trace agent variance](#frozen-trace-agent-variance) below

**Phase 3 complete:**

- Authenticated Clay MCP over remote Streamable HTTP (`https://api.clay.com/v3/mcp`)
- Public PKCE-only OAuth via Dynamic Client Registration; credentials in gitignored `.clay-auth/`
- Existing `Transport` interface unchanged; OAuth/session/HTTP stay in the Clay adapter
- Recorded a real Clay `get-credits-available` call through the interceptor
- Strict replay succeeds after session close + credential removal (no Clay, no OAuth)
- Trace contains no auth/session material; deliberate isolation break fails verification

**Phase 2** remains the local MCP stdio regression path (`npm run verify`).

**Phase 1** established the interceptor/trace core.

See `AGENTS.md` for invariants and workflow, `DECISIONS.md` for architectural choices.

## Frozen-trace agent variance

Repeated strict replay of V1 and V2 against one frozen Clay tool trace, with the question:

> When the Clay environment is held completely fixed, how much behavioral variance comes from model sampling versus the agent policy?

**Frozen environment.** Same Notion (`notion.so`) trace as the first agent experiment: `find-and-enrich-company` → `get-task-context`. SHA-256 `7c9e720161632f5e45f26c409ead74e362c75f6b274fb1b00992063fcc603e75` before and after; unchanged. Fail-closed transport; **0** live Clay calls; **0** replay mismatches. Policies unchanged from Outcome A. OpenRouter `openai/gpt-4o-mini`; temperature/seed unset; `max_tokens` 512; `tool_choice` auto.

**Observed distributions** (10 runs each):

| Policy | strong_fit | medium_fit | weak_fit | unclear | Tool sequence |
|--------|------------|------------|----------|---------|---------------|
| V1     | 0          | 7 (70%)    | 3 (30%)  | 0       | 10/10 matched |
| V2     | 0          | 0          | 10 (100%)| 0       | 10/10 matched |

**Interpretation.** Three distinct sources:

- **Environment variance** — removed; every run saw the same Clay evidence.
- **Model variance** — still present; V1 varied between `medium_fit` and `weak_fit` on identical tool results.
- **Policy effect** — V2 was `weak_fit` in all 10 runs; V1 was `weak_fit` in 3/10 and `medium_fit` in 7/10.

Under the same frozen Clay evidence and model configuration, V2 was more consistent with its stricter policy in this 10-run sample, while V1 exhibited classification variance. This does **not** say V2 is more correct or better: there is no human ground truth or evaluation rubric yet.

**Product insight.** Replay does more than make runs reproducible. Freezing the tool environment removes changing Clay data as a confounder, so a different classification can be attributed to model variance or policy—not to environment drift. Without replay, a later live run could mix all three.

**Limitations.** Sample of 10 runs per policy; no claim of statistical significance. Correctness is not established. Model nondeterminism remains (temperature/seed unset). Artifacts stay local under `.experiment-artifacts/agent-variance/`.

**Approximate cost.** V1 ≈ 38,162 tokens (~3,816/run, ~$0.0045). V2 ≈ 38,673 tokens (~3,867/run, ~$0.0046).

## Verification

```bash
# Local MCP stdio (no Clay credentials)
npm run verify

# Same, while capturing output without hiding failures
npm run verify -- --tee /tmp/verify.log

# Authenticated Clay MCP (requires prior OAuth into .clay-auth/)
npm run verify:clay

# First agent replay experiment (needs .clay-auth + OPENROUTER_API_KEY in .env)
npm run experiment:agent-replay

# Frozen-trace variance (OPENROUTER_API_KEY; reuses existing frozen trace; no Clay)
npm run experiment:agent-variance

# Focused unit tests
npm test
```

Do not capture verifier output with a bare `| tee` pipeline: without `pipefail`, a failing verifier can still yield exit status 0. Prefer `npm run verify -- --tee <file>`.

First-time Clay auth / tool discovery:

```bash
npm run clay:list-tools
```

LLM key for the agent experiment: paste `OPENROUTER_API_KEY=` into the gitignored repo-root `.env`.
