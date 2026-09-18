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

# Focused unit tests
npm test
```

Do not capture verifier output with a bare `| tee` pipeline: without `pipefail`, a failing verifier can still yield exit status 0. Prefer `npm run verify -- --tee <file>`.

First-time Clay auth / tool discovery:

```bash
npm run clay:list-tools
```

LLM key for the agent experiment: paste `OPENROUTER_API_KEY=` into the gitignored repo-root `.env`.
