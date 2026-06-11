# @amaster.ai/pi-memory-mem0

Passive semantic memory extension powered by [Mem0](https://mem0.ai) — supports both Platform (cloud) and Open-Source (local SQLite) modes.

## How It Works

After each conversation turn, user + assistant messages are automatically sent to Mem0 for fact extraction and vector storage. Before the next turn, relevant memories are recalled via semantic search and injected into the system prompt.

**Zero effort required** — memory storage and recall are fully automatic.

## Two Modes

| Mode | Storage | Dependencies | Use Case |
|------|---------|--------------|----------|
| `platform` | Mem0 Cloud | `MEM0_API_KEY` | Quick start, multi-device sync |
| `open-source` | Local SQLite (`~/.pi/agent/memories/mem0.db`) | LLM + Embedding API | Data privacy, no external services |

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

Reuses API keys from pi's configured model providers by default — **no extra environment variables needed**.

```json
{
  "pi-memory-mem0": {
    "mode": "open-source",
    "userId": "${USER}"
  }
}
```

Defaults to OpenAI `text-embedding-3-small` (embedding) + `gpt-4.1-nano` (extraction). API keys are automatically resolved from pi's model registry.

### Custom LLM / Embedding

```json
{
  "pi-memory-mem0": {
    "mode": "open-source",
    "userId": "${USER}",
    "oss": {
      "llm": {
        "provider": "deepseek",
        "config": { "model": "deepseek-chat" }
      },
      "embedder": {
        "provider": "openai",
        "config": { "model": "text-embedding-3-small" }
      }
    }
  }
}
```

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
| `oss.vectorStore` | object | SQLite (default) | Custom vector store |
| `oss.disableHistory` | boolean | `false` | Disable operation history |

## Installation Notes

Open-Source mode depends on `better-sqlite3` (native addon, transitive dependency of `mem0ai`).

**For pi-agent users**: pi-agent's `package.json` includes `better-sqlite3` in `pnpm.onlyBuiltDependencies` — it compiles automatically during `pnpm install`. No extra steps needed.

**For standalone users**: If your project's pnpm config blocks build scripts, add to your root `package.json`:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

Or run `pnpm approve-builds` to approve manually.

**System requirements**: Node.js >= 22, build toolchain (macOS: Xcode CLI Tools, Linux: `build-essential`, Windows: `windows-build-tools`). In most cases, `better-sqlite3` downloads a prebuilt binary and does not require local compilation.

## Data Storage Location

| Mode | Location |
|------|----------|
| Platform | Mem0 Cloud (api.mem0.ai) |
| Open-Source | `~/.pi/agent/memories/mem0.db` (SQLite, alongside pi-memory's MEMORY.md/USER.md) |

Customizable via `oss.vectorStore.config.dbPath`. The `PI_AGENT_HOME` environment variable changes the default directory.

## API Key Resolution (OSS Mode)

LLM and Embedder API keys are **resolved independently**, in this order:

1. Explicit config in `oss.llm.config.apiKey` / `oss.embedder.config.apiKey`
2. Pi model registry key for the corresponding provider (when `useRegistryKeys: true`)
3. Environment variables (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, etc. — read by mem0 SDK internally)

For example, `"llm": { "provider": "deepseek" }` + `"embedder": { "provider": "openai" }` resolves the deepseek key for LLM and the openai key for embedder, each from pi's registry.

### Proxy API Calls (e.g. amaster)

If your embedding/LLM goes through a unified proxy (like amaster credits), configure `baseUrl` forwarding:

```json
{
  "pi-memory-mem0": {
    "mode": "open-source",
    "oss": {
      "llm": {
        "provider": "openai",
        "config": { "model": "deepseek-v4", "baseUrl": "https://credits.amaster.ai/v1" }
      },
      "embedder": {
        "provider": "openai",
        "config": { "model": "text-embedding-3-small", "baseUrl": "https://credits.amaster.ai/v1" }
      }
    }
  }
}
```

Keys resolve from pi registry's `openai` provider, but requests are sent to the amaster endpoint.

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
