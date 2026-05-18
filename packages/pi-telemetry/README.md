# @amaster.ai/pi-telemetry

Runtime telemetry contracts and exporters for pi.

The root package exposes stable exporter contracts plus no-op and composite exporters. Provider-specific implementations live behind explicit subpath entry points so applications can depend on the smallest public surface they need.

## Entry Points

- `@amaster.ai/pi-telemetry`: stable contracts, `NoopRuntimeEventExporter`, and `CompositeRuntimeEventExporter`.
- `@amaster.ai/pi-telemetry/langfuse`: Langfuse SDK and ingestion API exporters.
- `@amaster.ai/pi-telemetry/otel`: generic OTLP/HTTP traces exporter.

## Langfuse

```ts
import { createRuntimeEventExporterFromEnv } from "@amaster.ai/pi-telemetry/langfuse";

const exporter = createRuntimeEventExporterFromEnv(process.env);
```

Telemetry is disabled unless credentials are present. Supported environment variables include:

- `LANGFUSE_ENABLED`
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`
- `LANGFUSE_TRANSPORT`
- `TELEMETRY_SERVICE_NAME`
- `TELEMETRY_SERVICE_VERSION`
- `TELEMETRY_INCLUDE_PAYLOADS`

Set `TELEMETRY_INCLUDE_PAYLOADS=false` to remove chat payloads, tool args, and LLM input/output from exported telemetry. For finer control, construct a Langfuse exporter directly and pass `redactEvent`.

## Generic OTEL

```ts
import { createOtelRuntimeEventExporterFromEnv } from "@amaster.ai/pi-telemetry/otel";

const exporter = createOtelRuntimeEventExporterFromEnv(process.env);
```

Supported generic OTEL environment variables include:

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_EXPORTER_OTLP_TRACES_HEADERS`
- `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`
- `OTEL_BSP_SCHEDULE_DELAY`
- `OTEL_SERVICE_NAME`
- `OTEL_RESOURCE_ATTRIBUTES`
- `OTEL_SDK_DISABLED`
- `TELEMETRY_INCLUDE_PAYLOADS`
- `TELEMETRY_SERVICE_VERSION`

When the endpoint does not end with `/v1/traces`, the exporter appends `/v1/traces`.
Use this entry point for any OTLP/HTTP collector, including Langfuse's OTEL endpoint.

## Privacy

Runtime events may include user prompts, assistant responses, tool arguments, tool outputs, and model inputs/outputs. Keep telemetry disabled by default in downstream applications unless users explicitly configure an exporter.
