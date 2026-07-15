# @amaster.ai/pi-memory-mem0

![pi-memory-mem0 preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-memory-mem0/preview.png)

Passive semantic memory extension powered by [Mem0](https://mem0.ai) — supports both Platform (cloud) and Open-Source (local) modes.

## How It Works

After each conversation turn, user + assistant messages are automatically sent to Mem0 for fact extraction and vector storage. Before the next turn, relevant memories are recalled via semantic search and injected into the system prompt.

**Zero effort required** — memory storage and recall are fully automatic.

## Two Modes

| Mode | Vector Store | Persistence | Dependencies | Use Case |
|------|-------------|-------------|--------------|----------|
| `platform` | Mem0 Cloud | Cloud-managed | `MEM0_API_KEY` | Quick start, multi-device sync |
| `open-source` | Mem0 OSS vector store | Vector-store managed | LLM + Embedding API | Data privacy, no Mem0 Cloud |

## Architecture (Open-Source Mode)

```
User ←→ Agent ←→ Mem0 OSS Memory
                        ↕
            Mem0 OSS Vector Store (source of truth)
```

- **Vector search**: `mem0ai` OSS `MemoryVectorStore`. Despite the provider name `memory`, it is backed by SQLite; `dbPath` selects an in-process SQLite database or a SQLite file.
- **LLM extraction**: Configured provider extracts facts from conversations
- **Persistence**: The default `dbPath` is `<home>/memories/mem0-vectors.db`, so Mem0 writes vectors and payloads directly to a durable SQLite file. No second snapshot is maintained.
- **Provider mapping**: Custom providers are automatically mapped to mem0-compatible providers (e.g. `openai`) via the pi model registry's `api` field.
- **Observation date**: `add()` accepts an optional `observedAt` (Date or string). In OSS mode it grounds mem0's extraction prompt so relative time references ("yesterday", "last week") resolve against the conversation's date rather than the system clock — important when ingesting historical conversations. Omit it and mem0 falls back to the current date (correct for live turns).

## Quick Start

### Platform Mode

```json
{
  "pi-memory-mem0": {
    "mode": "platform",
    "apiKey": "${MEM0_API_KEY}",
    "userId": "${USER}"
  }
}
```

### Open-Source Mode (Recommended)

Reuses API keys and base URLs from pi's configured model providers — **no extra environment variables needed**.

```json
{
  "pi-memory-mem0": {
    "mode": "open-source",
    "userId": "${USER}"
  }
}
```

Defaults to OpenAI `text-embedding-3-small` (embedding) + `gpt-4.1-nano` (extraction). API keys and base URLs are automatically resolved from pi's model registry.

### Custom Provider

When your model registry defines a custom provider with `api: "openai-completions"`, you can use it directly:

```json
{
  "pi-memory-mem0": {
    "mode": "open-source",
    "oss": {
      "llm": {
        "provider": "my-provider",
        "config": { "model": "deepseek-v4-pro" }
      },
      "embedder": {
        "provider": "my-provider",
        "config": { "model": "text-embedding-v4" }
      }
    }
  }
}
```

The extension automatically:
1. Resolves API key from the model registry
2. Injects `baseUrl` from the registry
3. Maps `api: "openai-completions"` → mem0 provider `"openai"`

### Fully Local (Ollama)

```json
{
  "pi-memory-mem0": {
    "mode": "open-source",
    "userId": "${USER}",
    "oss": {
      "llm": {
        "provider": "ollama",
        "config": { "model": "llama3", "url": "http://localhost:11434" }
      },
      "embedder": {
        "provider": "ollama",
        "config": { "model": "nomic-embed-text", "url": "http://localhost:11434" }
      }
    },
    "useRegistryKeys": false
  }
}
```

### External Vector Store (e.g. Qdrant)

For production workloads that need a dedicated vector database:

```json
{
  "pi-memory-mem0": {
    "mode": "open-source",
    "oss": {
      "vectorStore": {
        "provider": "qdrant",
        "config": { "url": "http://localhost:6333" }
      }
    }
  }
}
```

Supported vector store providers: `memory` (default), `qdrant`, `redis`, `pgvector`, `supabase`.

The configured vector store always owns persistence. To request an intentionally ephemeral SQLite database, set the `memory` provider's `config.dbPath` to `":memory:"`; no snapshot fallback is created.

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"platform"` \| `"open-source"` | `"platform"` | Operating mode |
| `apiKey` | string | — | Required for platform mode. Supports `${MEM0_API_KEY}` |
| `baseUrl` | string | `https://api.mem0.ai` | Custom platform endpoint |
| `userId` | string | `$USER` or `"default-user"` | Memory scoping identifier |
| `topK` | number | `5` | Max recalled memories per turn |
| `useRegistryKeys` | boolean | `true` | Whether OSS mode resolves keys from pi registry |
| `oss.llm` | object | OpenAI gpt-4.1-nano | OSS extraction model |
| `oss.embedder` | object | OpenAI text-embedding-3-small | OSS embedding model |
| `oss.vectorStore` | object | `memory` at `<home>/memories/mem0-vectors.db` | Custom vector store config |
| `oss.historyStore` | object | SQLite at `<home>/memories/mem0-history.db` | Custom mem0 history store config |
| `oss.historyDbPath` | string | `<home>/memories/mem0-history.db` | Shortcut for SQLite history DB path |
| `oss.disableHistory` | boolean | `false` | Disable mem0 operation history |

## Data Storage

| Mode | Vector Data | History |
|------|-------------|---------|
| Platform | Mem0 Cloud | Cloud-managed |
| Open-Source (default) | `<home>/memories/mem0-vectors.db` | `<home>/memories/mem0-history.db` |
| Open-Source (`memory`, `dbPath: ":memory:"`) | Process-local SQLite; lost on restart | `<home>/memories/mem0-history.db` |
| Open-Source (Qdrant) | Qdrant server | `<home>/memories/mem0-history.db` |

The `home` directory is resolved via `resolveHome()` from `@amaster.ai/pi-shared/settings` (defaults to `~/.pi/agent`).

## Provider Mapping

When a provider name doesn't match mem0's built-in list, the extension uses the model registry's `api` field to map it:

| Registry `api` field | Mapped to mem0 provider |
|---------------------|------------------------|
| `openai-completions`, `openai-responses` | `openai` |
| `anthropic-messages` | `anthropic` |
| `azure-*` | `azure_openai` |
| `google-*`, `gemini-*` | `gemini` |

This happens transparently — just configure the provider name as it appears in your `models.json`.

## Installation Notes

The default Open-Source mode depends on `better-sqlite3` (native addon, transitive dependency of `mem0ai`) for both the vector store and history. This remains true for `dbPath: ":memory:"`: it changes where SQLite stores pages, not which vector-store implementation is used.

**For pi-agent users**: pi-agent's `package.json` includes `better-sqlite3` in `pnpm.onlyBuiltDependencies` — it compiles automatically during `pnpm install`. No extra steps needed.

**For standalone users**: If your project's pnpm config blocks build scripts, add to your root `package.json`:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

If `better-sqlite3` fails to load (for example, because of a Node ABI mismatch), the default `memory` vector store cannot start. An external vector store can still be used with history disabled or configured to a working provider.

## Tools

| Tool | Description |
|------|-------------|
| `mem0_search` | Semantic search over long-term memories |
| `mem0_profile` | List all stored memories |
| `mem0_save` | Store a fact verbatim (bypasses LLM extraction) |

## Commands

```
/mem0 status          # Show current status
/mem0 search <query>  # Semantic search
/mem0 profile         # List all memories
```

## Relationship with pi-memory

`pi-memory-mem0` and `pi-memory` run **independently in parallel** as separate extensions:

- `pi-memory`: Active memory — agent explicitly manages via tools, local `.md` files, hard char limits
- `pi-memory-mem0`: Passive memory — automatic extraction and storage, semantic retrieval, no capacity limits

They do not interfere with each other and each injects into the system prompt separately.

## Dedup API

The package exports a standalone deduplication function used by pi-memory's dreaming job:

```ts
import { dedupMemories } from "@amaster.ai/pi-memory-mem0/dedup";

const result = await dedupMemories({
  userId: "my-user",
  config: { mode: "platform", apiKey: "..." },
});
// result: { total: 42, duplicatesRemoved: 3 }
```

Normalizes entries (case-insensitive, whitespace-collapsed), identifies exact duplicates, and deletes the older ones through the configured provider. In OSS mode those deletes go directly to the vector store.
