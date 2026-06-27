# @amaster.ai/pi-memory

![pi-memory preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-memory/preview.png)

Persistent curated memory for pi agents — `MEMORY.md` (the agent's own notes) and `USER.md` (what the agent knows about the user). Both are loaded from disk at session start, **frozen**, and injected into the system prompt for the entire session. Mid-session writes are durable on disk but do **not** mutate the system prompt — this preserves prefix-cache stability.

Modeled after hermes' default `MemoryStore` mechanism (no provider/manager abstraction).

## Storage

- Location: `<agentDir>/memories/MEMORY.md` and `<agentDir>/memories/USER.md`
- Entries separated by `\n§\n`
- Atomic writes via temp-file + rename
- Read-modify-write protected by `proper-lockfile`
- **Drift detection**: if the on-disk file contains content that wouldn't round-trip through the parser/serializer (or any single entry exceeds the per-store char limit), the mutation is refused and a `.bak.<unix-ts>` snapshot is taken for the user to recover from.

## Safety

Every write — and every system-prompt snapshot build — runs the content through the bundled `threat-patterns` scanner at the `strict` scope. Patterns cover prompt injection, role hijack, C2 framework names, exfiltration, persistence (SSH backdoor, agent-config edits), and invisible unicode.

| Action               | On match                                                                                                  |
|----------------------|-----------------------------------------------------------------------------------------------------------|
| `memory_add` / `memory_replace` | Reject with the matched pattern id; live state and disk unchanged.                              |
| Snapshot build (load) | Replace the entry with `[BLOCKED: <filename> entry contained threat pattern(s): <ids>...]`. The poisoned content **never** enters the system prompt. Live state keeps the original so `memory_read` / `memory_remove` can recover. |

## Tools

Four LLM-callable tools (separate, not action-multiplexed):

| Tool             | Purpose                                                                  |
|------------------|--------------------------------------------------------------------------|
| `memory_add`     | Append a new entry. Rejects empty / duplicate / over-limit / threat content. |
| `memory_replace` | Update an existing entry by short unique substring (`oldText`).          |
| `memory_remove`  | Delete an entry by short unique substring (`oldText`).                   |
| `memory_read`    | Return live entries, count, and `<percent>% — <chars>/<limit>` usage string. |

`target` is `'memory'` (the agent's own notes) or `'user'` (user profile facts).

## Defaults

| Store    | Char limit |
|----------|------------|
| MEMORY   | 2200       |
| USER     | 1375       |

These are total chars after `§`-joining all entries. The limit is enforced at write time, and at load time as a drift signal (single-entry overflow).

## Integration Modes

### Mode 1: Extension auto-discovery (standalone / CLI)

When installed as a dependency with the `pi.extensions` field declared in `package.json`, the runtime auto-discovers and loads the extension. The extension creates its own `MemoryStore` with file-based storage at `<agentDir>/memories/` — fully self-contained.

```
pi.extensions → session_start → load MEMORY.md/USER.md → freeze snapshot → register tools
              → before_agent_start → append snapshot to systemPrompt
              → session_shutdown → release
```

- **Storage**: `<agentDir>/memories/MEMORY.md` and `<agentDir>/memories/USER.md`
- **Lifecycle**: load on `session_start`, snapshot held until `session_shutdown`
- **Status command**: `/pi-memory-status` shows entry counts per file
- **LLM tools**: `memory_add`, `memory_replace`, `memory_remove`, `memory_read`

Configure via the `pi-memory` settings key:

```json
{
  "pi-memory": {
    "dataDir": "/custom/memory/path",
    "memoryCharLimit": 4000,
    "userCharLimit": 2000
  }
}
```

### Mode 2: Dependency import (host-controlled)

When the host process owns the `MemoryStore` (e.g. shared across agents, test fixtures, custom storage path), construct the store yourself and register tools directly:

```ts
import { MemoryStore, createMemoryTools } from "@amaster.ai/pi-memory";

const store = new MemoryStore({
  dir: "/var/lib/pi/agent-42/memories",
  memoryCharLimit: 4000,
});
await store.loadFromDisk();

// ToolDefinition[] — wire into your tool registry directly
const tools = createMemoryTools(store);

// System prompt fragment (frozen at loadFromDisk; safe to use repeatedly)
const promptBlock = store.formatAllForSystemPrompt();
```

You can also pass a pre-built store into the extension via `injectedConfig` to keep the extension lifecycle but use your own storage:

```ts
import memoryExtension from "@amaster.ai/pi-memory";

memoryExtension(pi, { store });
```

## Drift recovery

If `memory_add` / `memory_replace` / `memory_remove` returns `success: false` with `driftBackup: ".../MEMORY.md.bak.<ts>"`, the on-disk file no longer round-trips through the parser. This usually means a patch tool / shell append / manual edit / concurrent session wrote raw content that broke the `§`-delimited structure.

To recover:

1. Open the `.bak.<ts>` snapshot and identify content not yet captured as clean entries.
2. Add each missing entry via `memory_add`.
3. Either delete the original `MEMORY.md` (the next add will recreate it) or rewrite it as a clean `§`-delimited list.

The drift guard exists to prevent silent data loss — never bypass it by deleting `.bak.<ts>` snapshots blindly.

## Frozen snapshot

`loadFromDisk()` captures the system-prompt block once; subsequent `add` / `replace` / `remove` calls update **live state** but not the snapshot. Why:

- The system prompt is the prefix-cache key for every model call. Mutating it mid-session invalidates the entire prefix.
- Tool responses always reflect live state, so the model still sees its own writes — just via tool-result tail, not system-prompt head.
- The snapshot picks up changes on the **next** `loadFromDisk()` (typically the next session start).

## Lifecycle reference

| Hook                  | Behavior                                                                  |
|-----------------------|---------------------------------------------------------------------------|
| `session_start`       | Resolve `dataDir`, build `MemoryStore`, `loadFromDisk()`, capture snapshot, register 4 tools, set status `memory: loaded`/`memory: empty`. Auto-register dreaming cron job if not already installed. |
| `before_agent_start`  | Append snapshot to assembled `systemPrompt` (no-op when empty).           |
| `session_shutdown`    | Drop store + snapshot references.                                         |

## Dreaming (Periodic Memory Consolidation)

On first session start, pi-memory automatically registers a system-level scheduled task that periodically reviews recent conversations and consolidates durable facts into memory. No manual cron configuration needed.

### How it works

1. **System cron registration** — On first load, the extension registers a platform-native scheduled job:
   - macOS: `launchd` LaunchAgent
   - Linux: user `crontab` entry
   - Windows: Task Scheduler

2. **Gate check** — Each run checks whether enough time and sessions have elapsed since the last consolidation before proceeding.

3. **Phase 1 — Consolidation** — An agentic loop (using pi-agent-core) reviews recent conversation transcripts and updates `MEMORY.md`/`USER.md` via the memory tools. Follows a 4-phase prompt: Orient → Gather → Consolidate → Prune.

4. **Phase 2 — Dedup** — If `pi-memory-mem0` is configured, exact-duplicate entries in the vector store are identified and deleted.

### Configuration

Add to `settings.json` under the `pi-memory` key:

```json
{
  "pi-memory": {
    "dreaming": {
      "enabled": true,
      "intervalHours": 4,
      "minHoursSinceLastRun": 24,
      "minSessionsSinceLastRun": 5,
      "model": {
        "provider": "openai",
        "model": "gpt-4.1-mini"
      }
    }
  }
}
```

All fields are optional with sensible defaults. The `model` field accepts any provider/model pair configured in your `~/.pi/agent/models.json` (built-in or custom).

Set `"enabled": false` to disable dreaming and remove the scheduled task.

### CLI

The dreaming logic is also available as a standalone CLI:

```bash
# Run once (called by the system scheduler)
npx pi-memory-dream

# Or via the installed bin
pi-memory-dream
```
