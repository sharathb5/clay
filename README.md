# clay-record-replay

Record/replay layer for tool-using agents.

Freeze tool responses from a live run, then replay them later against another version of the agent.

## Why

To answer:

> Did agent behavior change, or did the outside world change?

## Current status

**Phase 1 complete:**

- TypeScript / Node
- Generic transport boundary
- Record mode
- Strict replay mode
- JSONL trace
- Exact ordered matching
- Local deterministic fake tool
- Replay verified with live execution unavailable
- Deliberate isolation break shown to fail verification

**Phase 2** has not been implemented.

See `AGENTS.md` for invariants and workflow, `DECISIONS.md` for architectural choices.

## Verification

```bash
npm run verify
```
