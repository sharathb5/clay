# clay-record-replay

Record/replay layer for tool-using agents.

Freeze tool responses from a live run, then replay them later against another version of the agent.

## Why

To answer:

> Did agent behavior change, or did the outside world change?

## Current status

**Phase 2 complete:**

- Official MCP TypeScript v2 client/server over local **stdio**
- Existing `Transport` interface unchanged; MCP details stay in the adapter
- Record mode performs a real MCP `callTool`
- Strict replay serves only from the JSONL trace after the MCP process is stopped
- Deterministic structural argument matching (object key order ignored; types and array order matter)
- Verified: reordered equivalent args replay; meaningfully different args mismatch
- Deliberate isolation and matching breaks shown to fail verification

**Phase 1** (in-process fake tool) established the interceptor/trace core; superseded as the live boundary by Phase 2.

**Phase 3 / Clay integration** has not been implemented.

See `AGENTS.md` for invariants and workflow, `DECISIONS.md` for architectural choices.

## Verification

```bash
npm run verify
```
