# Pi

Shared TypeScript packages for Pi runtime applications.

This repository contains the open-source runtime contracts, adapters, and
orchestration helpers that are consumed by Pi Agent and related applications.
The packages are intentionally small and composable: host applications provide
HTTP routing, authentication, model runtime setup, deployment configuration, and
product-specific UI.

## Packages

| Package | Purpose |
| --- | --- |
| `@amaster.ai/pi-types` | Shared runtime, transcript, event, artifact, scheduler, and telemetry types. |
| `@amaster.ai/pi-storage` | JSON-file and MySQL/Prisma persistence adapters for sessions, transcripts, events, memory, artifacts, subagents, and scheduled tasks. |
| `@amaster.ai/pi-attachments` | Attachment normalization, local/remote upload handling, document parsing, and model-readable attachment prompts. |
| `@amaster.ai/pi-telemetry` | Runtime telemetry contracts plus Langfuse and generic OTLP/HTTP exporters. |
| `@amaster.ai/pi-turns` | Turn concurrency, queueing, cancellation, active-turn handling, prompt timeout guards, and runtime event observation. |
| `@amaster.ai/pi-subagents` | Subagent spawning, child-session orchestration, role-aware prompts, routing hints, and cancellation helpers. |
| `@amaster.ai/pi-task-scheduler` | Scheduled task domain types, schedule parsing, process-local timers, runner hooks, and lock-aware task execution. |

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
pnpm add @amaster.ai/pi-types @amaster.ai/pi-storage
```

Most packages expose a root entry point. Some packages also expose focused
subpath entry points:

```ts
import { createRuntimeStorage } from "@amaster.ai/pi-storage";
import { JsonRuntimeStorage } from "@amaster.ai/pi-storage/json";
import { createRuntimeEventExporterFromEnv } from "@amaster.ai/pi-telemetry/langfuse";
import { createOtelRuntimeEventExporterFromEnv } from "@amaster.ai/pi-telemetry/otel";
```

See each package README for package-specific examples and public API notes.

## License

Apache-2.0
