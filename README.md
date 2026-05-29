# Pi

Shared TypeScript packages for Pi runtime applications.

This repository contains the open-source runtime contracts, adapters, and
orchestration helpers that are consumed by Pi Agent and related applications.
The packages are intentionally small and composable: host applications provide
HTTP routing, authentication, model runtime setup, deployment configuration, and
product-specific UI.

## Packages

| Category | Package | Purpose |
| --- | --- | --- |
| Core | `@amaster.ai/pi-shared` | Shared runtime types and contracts: settings loader, session/event/artifact types, turn and subagent types. |
| Core | `@amaster.ai/pi-storage` | JSON-file and MySQL/Prisma persistence adapters for sessions, transcripts, events, memory, artifacts, subagents, and scheduled tasks. |
| Extension | `@amaster.ai/pi-attachments` | Attachment normalization, local/remote upload handling, document parsing, and model-readable attachment prompts. |
| Extension | `@amaster.ai/pi-telemetry` | Runtime telemetry with Langfuse and OpenTelemetry exporters. |
| Extension | `@amaster.ai/pi-task-scheduler` | Cron-based scheduled task management with LLM-callable tools. |
| Extension | `@amaster.ai/pi-browser-use` | Browser automation wrapping chrome-devtools-mcp with `browser_`-prefixed tools. |
| Extension | `@amaster.ai/pi-computer-use` | Computer-use extension for CUA computer-server with desktop automation tools. |
| Extension | `@amaster.ai/pi-channels` | Native messaging channels: Feishu, WeCom, and webhooks. |
| Extension | `@amaster.ai/pi-memory` | Persistent curated memory (`MEMORY.md` + `USER.md`) injected into the system prompt as a frozen snapshot. |
| Extension | `@amaster.ai/pi-security` | Resource-aware security policy engine and tool authorization. |
| Extension | `@amaster.ai/pi-teamwork` | Team collaboration and issue management via Multica. |

Core packages provide types and persistence used by every host application.
Extension packages each register Pi runtime extensions via their `./extension`
subpath entry point and are loaded on demand.

Every package is ESM-only and published under the `@amaster.ai` npm scope.

## Requirements

- Node.js `>=24`
- pnpm `10.18.3`

Use Corepack when possible:

```sh
corepack enable
corepack install -g pnpm@10.18.3
```

## Development

Install dependencies:

```sh
pnpm install
```

Run the full local check:

```sh
pnpm run pr-check
```

Common commands:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @amaster.ai/pi-storage prisma:generate
```

`@amaster.ai/pi-storage` includes a Prisma schema at
`packages/storage/prisma/schema.prisma`. The root `build` and `typecheck`
scripts generate the Prisma client before compiling project references.

## Consuming Packages

Install only the packages your application needs:

```sh
pnpm add @amaster.ai/pi-shared @amaster.ai/pi-storage
```

Most packages expose a root entry point. Some packages also expose focused
subpath entry points:

```ts
import { createRuntimeStorage } from "@amaster.ai/pi-storage";
import { JsonRuntimeStorage } from "@amaster.ai/pi-storage/json";
import { loadPiSettings } from "@amaster.ai/pi-shared/settings";
import { createLangfuseExporter } from "@amaster.ai/pi-telemetry/langfuse";
import { createOtelExporter } from "@amaster.ai/pi-telemetry/otel";
import memoryExtension from "@amaster.ai/pi-memory/extension";
```

Extension packages register themselves through their `./extension` subpath
entry point. Host applications import these and pass them to the Pi runtime
during setup.

See each package README for package-specific examples and public API notes.

## License

Apache-2.0
