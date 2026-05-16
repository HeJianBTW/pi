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

## Local Development With Pi Agent

Pi Agent normally consumes published `@amaster.ai/pi-*` packages from npm. To
jointly debug this repository with a sibling `../pi-agent` checkout, temporarily
add pnpm overrides in `../pi-agent/package.json`:

```json
{
  "pnpm": {
    "overrides": {
      "@amaster.ai/pi-types": "link:../pi/packages/types",
      "@amaster.ai/pi-attachments": "link:../pi/packages/attachments",
      "@amaster.ai/pi-storage": "link:../pi/packages/storage",
      "@amaster.ai/pi-subagents": "link:../pi/packages/subagents",
      "@amaster.ai/pi-task-scheduler": "link:../pi/packages/task-scheduler",
      "@amaster.ai/pi-telemetry": "link:../pi/packages/telemetry",
      "@amaster.ai/pi-turns": "link:../pi/packages/turns"
    }
  }
}
```

Then keep this repository compiling in watch mode:

```sh
cd ../pi
pnpm install
pnpm --filter @amaster.ai/pi-storage prisma:generate
pnpm exec tsc -b packages/* --watch
```

In the Pi Agent checkout:

```sh
cd ../pi-agent
pnpm install
pnpm typecheck
```

The package entry points read from `dist`, so keep the watch build running while
editing this repository. Remove the local overrides before committing Pi Agent
changes unless the change is explicitly about local linking.

## Releasing

Packages are published by the `Publish npm Packages` GitHub Actions workflow.
Publishing is only allowed from the `master` branch.

Before running the workflow, configure the repository secret:

- `NPM_TOKEN`: npm automation token with permission to publish `@amaster.ai/*`

Manual workflow inputs:

- `npm_tag`: `beta` or `latest`
- `version_bump`: `current`, `patch`, `minor`, or `major`

Use `current` only to resume an already-published local version. For a new
release after `0.1.0-beta.0`, use `patch` for the next beta patch or stable
promotion flow handled by the workflow.

The release workflow:

1. Installs dependencies with a frozen lockfile.
2. Computes the next version from npm dist-tags.
3. Runs `pnpm run pr-check`.
4. Publishes all public workspace packages with `pnpm publish -r --access public`.
5. Commits version changes, pushes `v<version>`, and creates a GitHub release.

## License

Apache-2.0
