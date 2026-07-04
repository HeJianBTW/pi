# @amaster.ai/pi-eval

Internal eval harness for pi packages. **Private workspace package** — not published.

Domain runners live in subdirs (`memory/`, ...). Shared loaders, judge, and fetch scripts live at root so cross-domain reuse is free.

## Layout

```
tests/eval/
  package.json
  datasets/             # gitignored; populated by fetch scripts
  results/              # gitignored; per-runner JSON output
  scripts/
    fetch-locomo.ts     # pull LoCoMo JSON from upstream (MIT)
  src/
    loaders/locomo.ts   # forgiving JSON adapter
    judge.ts            # token-F1 baseline; LLM-judge hook TODO
  memory/
    run-mem0.ts         # pi-memory-mem0 runner
    run-memory.ts       # pi-memory runner (simplified probe)
```

## Quick start

```bash
pnpm install
pnpm --filter @amaster.ai/pi-eval fetch:locomo

# pi-memory-mem0 (needs MEM0_API_KEY for platform mode, or OSS mode wiring)
MEM0_API_KEY=... pnpm --filter @amaster.ai/pi-eval eval:memory:mem0 -- --samples 5 --topk 5

# pi-memory (no LLM needed for the heuristic baseline)
pnpm --filter @amaster.ai/pi-eval eval:memory:curated -- --samples 5
```

## Datasets

- **LoCoMo** — multi-session conversational QA. Pulled from [snap-research/locomo](https://github.com/snap-research/locomo) (MIT). ~600 samples; runner takes `--samples N` for a slice.
- LongMemEval / MemBench — TODO. Same fetch-on-demand pattern.

We deliberately do **not** consume [OpenDataBox/MemoryData](https://github.com/OpenDataBox/MemoryData) directly — that repo has no license. We borrow its evaluation taxonomy (recall / conflict / multi-session / update) and pull data from each upstream.

## Why pi-memory and pi-memory-mem0 are evaluated differently

| Aspect              | pi-memory (curated)                       | pi-memory-mem0 (passive)              |
|---------------------|-------------------------------------------|---------------------------------------|
| Storage             | 2200 + 1375 char hard cap                 | Vector store (cloud or local)         |
| Write decision      | LLM tool calls                            | Background extraction                 |
| Retrieval           | None — full file injected to prompt       | Semantic search                       |
| Primary metric      | Whether kept entries cover the answer     | Recall@k + answer F1                  |

A naive head-to-head would punish pi-memory for not being a vector store. The runners report different metrics on purpose.

## Status

Skeleton only. Open items:

- LoCoMo schema is forgivingly adapted; finalize after the real JSON lands.
- LLM-judge in `judge.ts` is stubbed — token-F1 only for now.
- `run-mem0.ts` defaults to platform mode; OSS mode needs a model-registry resolver wired in.
- `run-memory.ts` uses a heuristic writer, not the real `memory_add` LLM tool loop. Real loop = follow-up.
- No CI hook yet — runs are manual.
