# @amaster.ai/pi-memory-mem0

Mem0 被动语义记忆扩展 — 支持 Platform (云端) 和 Open-Source (本地 SQLite) 双模式。

## 工作原理

每轮对话结束后，自动将 user + assistant 消息对发送给 Mem0 进行事实提取和向量化存储。下一轮开始前，自动用语义搜索召回相关记忆并注入 system prompt。

**你不需要做任何事** — 记忆的存储和召回完全自动。

## 两种模式

| 模式 | 存储位置 | 依赖 | 适用场景 |
|------|---------|------|---------|
| `platform` | Mem0 Cloud | MEM0_API_KEY | 快速上手，多设备同步 |
| `open-source` | 本地 SQLite (`~/.mem0/vector_store.db`) | LLM + Embedding API | 数据私有，零外部服务 |

## 快速开始

### Platform 模式

```json
{
  "pi-memory-mem0": {
    "mode": "platform",
    "apiKey": "${MEM0_API_KEY}",
    "userId": "${USER}"
  }
}
```

### Open-Source 模式 (推荐)

默认复用 pi 已配置的 model provider API key，**不需要额外设置环境变量**。

```json
{
  "pi-memory-mem0": {
    "mode": "open-source",
    "userId": "${USER}"
  }
}
```

默认使用 OpenAI `text-embedding-3-small` (embedding) + `gpt-4.1-nano` (提取)。API key 自动从 pi model registry 获取。

### 自定义 LLM / Embedding

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

### 纯本地 (Ollama)

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

## 配置参考

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mode` | `"platform"` \| `"open-source"` | `"platform"` | 运行模式 |
| `apiKey` | string | — | Platform 模式必须。支持 `${MEM0_API_KEY}` |
| `baseUrl` | string | `https://api.mem0.ai` | Platform 自定义端点 |
| `userId` | string | `$USER` 或 `"default-user"` | 记忆作用域 |
| `topK` | number | `5` | 每轮最多召回条数 |
| `useRegistryKeys` | boolean | `true` | OSS 模式是否从 pi registry 取 API key |
| `oss.llm` | object | OpenAI gpt-4.1-nano | OSS 提取模型 |
| `oss.embedder` | object | OpenAI text-embedding-3-small | OSS embedding 模型 |
| `oss.vectorStore` | object | SQLite (默认) | 自定义向量存储 |
| `oss.disableHistory` | boolean | `false` | 禁用操作历史记录 |

## 数据存储位置

| 模式 | 位置 |
|------|------|
| Platform | Mem0 Cloud (api.mem0.ai) |
| Open-Source | `~/.pi/agent/memories/mem0.db` (SQLite，和 pi-memory 的 MEMORY.md/USER.md 同目录) |

可通过 `oss.vectorStore.config.dbPath` 自定义路径。`PI_AGENT_HOME` 环境变量会改变默认目录。

## API Key 解析顺序 (OSS 模式)

LLM 和 Embedder 的 API key **各自独立解析**，按以下顺序：

1. settings.json 的 `oss.llm.config.apiKey` / `oss.embedder.config.apiKey` (显式配置)
2. pi model registry 的对应 provider key (`useRegistryKeys: true` 时)
3. 环境变量 (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY` 等，mem0 SDK 内部读取)

例如配置 `"llm": { "provider": "deepseek" }` + `"embedder": { "provider": "openai" }`，会分别从 pi registry 拿 deepseek 的 key 给 LLM，拿 openai 的 key 给 embedder。

### 通过代理 API 调用 (如 amaster)

如果你的 embedding/LLM 走统一代理（如 amaster credits），可以配 `baseUrl` 转发：

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

这样 key 从 pi registry 的 `openai` provider 解析，但实际请求发到 amaster 的端点。

## 提供的工具

| 工具 | 说明 |
|------|------|
| `mem0_search` | 语义搜索长期记忆 |
| `mem0_profile` | 列出用户所有记忆 |
| `mem0_save` | 手动存储一条事实（不经过 LLM 提取） |

## 命令

```
/mem0 status          # 查看状态
/mem0 search <query>  # 语义搜索
/mem0 profile         # 列出所有记忆
```

## 与 pi-memory 的关系

`pi-memory-mem0` 和 `pi-memory` 是**独立并行运行**的两个扩展：

- `pi-memory`：主动记忆，agent 通过工具显式管理，本地 `.md` 文件，有 char limit
- `pi-memory-mem0`：被动记忆，自动提取存储，语义检索，无容量限制

两者互不干扰，各自注入 system prompt。
