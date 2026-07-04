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
    judge-llm.ts        # LLM-judge a results/*.json → recallJudge
  src/
    loaders/locomo.ts   # forgiving JSON adapter
    judge.ts            # token-F1 helper (fast in-runner baseline)
  memory/
    run-mem0.ts         # pi-memory-mem0 runner (passive extraction)
    run-memory.ts       # pi-memory runner (real memory_add/replace/remove loop)
```

## Quick start

```bash
pnpm install
pnpm --filter @amaster.ai/pi-eval fetch:locomo

MODELS=/path/to/.pi/agent/models.json   # provides provider baseUrl + apiKey

# pi-memory-mem0 (OSS mode: extraction + embedding resolved from models.json)
pnpm --filter @amaster.ai/pi-eval eval:memory:mem0 -- \
  --mode oss --samples 2 --topk 10 --concurrency 2 --models "$MODELS"

# pi-memory (real write loop: LLM emits memory ops per session)
pnpm --filter @amaster.ai/pi-eval eval:memory:curated -- \
  --samples 2 --concurrency 2 --models "$MODELS"

# LLM-judge either result file → recallJudge
pnpm --filter @amaster.ai/pi-eval judge:llm -- \
  --input results/mem0-locomo-oss.json --llm-model deepseek-v4-pro \
  --concurrency 6 --models "$MODELS"
```

Platform mode for mem0 (`--mode platform`) reads `MEM0_API_KEY` instead.

## Datasets

- **LoCoMo** — multi-session conversational QA. Pulled from [snap-research/locomo](https://github.com/snap-research/locomo) (MIT). ~600 samples; runner takes `--samples N` for a slice.
- LongMemEval / MemBench — TODO. Same fetch-on-demand pattern.

We deliberately do **not** consume [OpenDataBox/MemoryData](https://github.com/OpenDataBox/MemoryData) directly — that repo has no license. We borrow its evaluation taxonomy (recall / conflict / multi-session / update) and pull data from each upstream.

## Why pi-memory and pi-memory-mem0 are evaluated differently

| Aspect              | pi-memory (curated)                       | pi-memory-mem0 (passive)              |
|---------------------|-------------------------------------------|---------------------------------------|
| Storage             | 2200 + 1375 char hard cap                 | Vector store (SQLite / cloud)         |
| Write decision      | LLM emits memory_add/replace/remove ops   | Background per-turn extraction        |
| Retrieval           | None — the whole snapshot is the context  | Semantic top-k search                 |
| What LoCoMo rewards  | —                                        | Storing every retrievable detail      |

Both runners produce a memory `blob` per question and the same LLM-judge asks
"does this memory contain the answer?" — so the numbers share a scale. But
**do not read them as a leaderboard.** LoCoMo asks 300+ fine-grained recall
questions (exact dates, who-did-what, multi-hop). pi-memory's whole design is
to *discard* most of that under a hard char budget and keep only high-value
facts (preferences, corrections, stable environment facts). It compresses 19
sessions of conversation into ~a few hundred chars on purpose. mem0's unbounded
vector store keeps everything, so it recalls arbitrary details far better.

The gap below reflects that mismatch, not that one is "better". A fair
pi-memory benchmark would measure long-term retention of a small set of
high-value facts, not exhaustive detail recall.

## Results (LoCoMo, 2-sample slice: conv-26 + conv-30, 304 QA)

Extraction/write + answer model: `deepseek-v4-flash`. Judge: `deepseek-v4-pro`.
Endpoint resolved from a pi `models.json` (`--models`).

| Runner            | literal recall | LLM-judge recall |
|-------------------|---------------:|-----------------:|
| pi-memory-mem0    |          ~0.39 |            ~0.44 |
| pi-memory         |          ~0.26 |            ~0.19 |

Notes:
- mem0's judge score was ~0.27 before two fixes: isolating mem0's SQLite vector
  store per run (it defaults to `~/.mem0/vector_store.db` and silently
  accumulates across runs, polluting recall) and wiring `observedAt` so
  extracted facts carry the conversation date, not the wall clock.
- LLM-judge has run-to-run variance (flash drifted ~10 points between runs; pro
  is steadier). Treat these as ±, not exact. Averaging multiple judge passes is
  a TODO.

## Status

Working, run manually (no CI hook). Open items:

- Only LoCoMo wired; LongMemEval / MemBench are TODO (same fetch-on-demand pattern).
- Multi-sample averaging to shrink variance (currently 2 samples).
- Judge variance reduction (multi-pass majority vote).
- Reasoning models need generous `max_tokens` (write loop uses 4096, judge 512) —
  content comes out empty if the budget is spent on reasoning_content.
