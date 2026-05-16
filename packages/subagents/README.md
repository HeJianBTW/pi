# @amaster.ai/pi-subagents

Core subagent orchestration for Pi Agent.

This package owns child-session orchestration, subagent tool definitions,
role-aware prompt building, routing hints, depth/concurrency guards, and active
session helpers. It does not own HTTP routes, authentication, storage adapter
construction, telemetry exporters, or server configuration.

Applications provide storage, runtime prompting, model availability checks,
logging, event recording, and cancellation behavior through injected callbacks.

## Design

- `createSubagentToolDefinitions` exposes the `sessions_spawn` tool.
- `spawnSubagentRun` creates and runs an isolated child session.
- `cancelActiveChildSubagents` marks active child runs as cancelled and aborts
  their live sessions when present.
- `applySubagentRoutingGuidance` adds optional parent-turn guidance when a user
  request appears decomposable.

The package keeps the execution model runtime-native: child work runs through
the host `PiAgentRuntime` rather than through a subprocess.
