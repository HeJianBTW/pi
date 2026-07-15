# @amaster.ai/pi-goal

A Pi extension that lets Pi **keep working until a goal is met**. You don't have to write the completion condition yourself — run `/goal` with no argument and the extension derives a measurable condition from the conversation, shows it to you for a quick confirmation, then keeps the agent working (re-checking after each run) until the condition holds.

Modeled on Claude Code's stop-condition mechanism, with a token/iteration budget backstop borrowed from Codex's goal mode.

## How it works

1. **Set a goal.** Either give an explicit condition (`/goal all tests pass and lint is clean`) or let the extension derive one from the conversation (`/goal` with no argument).
2. **Derived goals are confirmed** in interactive (TUI) mode before they start, so a mis-derived goal can't run off on its own. Non-interactive modes skip the confirmation.
3. **After each agent run** (`agent_end`), a small evaluator model judges whether the condition is met:
   - **Met** → the goal is marked achieved and cleared. Pi stops.
   - **Not yet** → Pi is nudged to continue, told what still remains.
   - **Impossible** → Pi stops and tells you why.
4. **Backstops.** Continuation stops after `maxIterations` rounds or once an optional `tokenBudget` is exceeded, so a bad goal can't loop forever.

Goal state is session-scoped and held in memory (no cross-session persistence), matching Claude Code's behavior.

## Usage

```
/goal <condition>   Set an explicit completion condition.
/goal               No active goal → derive one from the conversation (with confirmation).
                    Active goal → show its status.
/goal clear         Clear the active goal (also: stop, off, reset, none, cancel).
```

## Configuration

Settings key: `pi-goal` (in `~/.pi/agent/settings.json`, agent dir, or project `.pi/settings.json`).

```json
{
  "pi-goal": {
    "model": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001" },
    "maxIterations": 10,
    "tokenBudget": 200000,
    "transcriptMaxChars": 8000,
    "requireConfirmForDerived": true
  }
}
```

| Key | Default | Purpose |
|-----|---------|---------|
| `model` | — | Provider/model for deriving and evaluating conditions. **Omit to disable the automatic engine** — `/goal <condition>` still sets a goal, but nothing auto-derives or auto-continues. |
| `maxIterations` | `10` | Max continuation rounds before Pi stops pushing. |
| `tokenBudget` | — | Optional hard token ceiling; the goal is paused (`budget_limited`) once exceeded. |
| `transcriptMaxChars` | `8000` | Max transcript chars fed to derive/evaluate. |
| `requireConfirmForDerived` | `true` | Ask before starting a derived goal (TUI only). |

Prefer a small, cheap model for `model` — the evaluator runs after every agent run.

## Relationship to Claude Code / Codex

- **Engine (from Claude Code):** goal = a stop condition; Pi keeps going until an evaluator judges it met. Passive — it drives continuation off `agent_end`, not a background scheduler.
- **Auto-derivation:** you don't have to phrase the condition; it's inferred and confirmed.
- **Budget backstop (from Codex):** token + iteration limits prevent runaway loops.
- **Not included:** Codex's idle auto-resume, pause/resume dialogs, file-backed objectives, and cross-session persistence.
