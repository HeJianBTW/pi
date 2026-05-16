# @amaster.ai/pi-turns

Core turn orchestration for Pi Agent.

This package owns turn concurrency, per-session queueing, cancellation,
active-turn steer/follow-up handling, prompt timeout guards, tool-result loop
guards, and runtime LLM generation observation.

It does not own HTTP routes, request parsing, storage adapter construction,
telemetry exporter construction, or server configuration. Host applications
provide logging, metrics counters, event recorders, stream sinks, transcript
persistence, and runtime prompt sessions through small injected interfaces.

## Design

- `TurnCoordinator` controls main-turn and subagent concurrency.
- `handleActiveChatTurn` accepts steer/follow-up input for an already active
  turn without knowing about HTTP.
- `promptChatTurn` runs a prompt against a Pi-compatible session, applies
  runtime guidance, enforces timeout/tool-result limits, and records model
  generation lifecycle events.

The package is runtime-agnostic but Pi-compatible: it expects a prompt session
with `prompt`, optional `abort`, optional `subscribe`, and message history.
