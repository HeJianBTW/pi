# @amaster.ai/pi-telemetry

Runtime telemetry contracts and exporters for pi.

The root package exposes stable exporter contracts plus no-op and composite exporters. Provider-specific implementations live behind explicit subpath entry points so applications can depend on the smallest public surface they need.

## Entry Points

- `@amaster.ai/pi-telemetry`: stable contracts, `NoopRuntimeEventExporter`, and `CompositeRuntimeEventExporter`.
- `@amaster.ai/pi-telemetry/config`: `TelemetryConfig` type, `resolveConfig`, and `loadConfigFromFile`.
- `@amaster.ai/pi-telemetry/langfuse`: Langfuse SDK and ingestion API exporters.
- `@amaster.ai/pi-telemetry/otel`: generic OTLP/HTTP traces exporter.

## Configuration

Configuration is read from `.pi/settings.json` under the `"pi-telemetry"` key. Project-level settings (`.pi/settings.json` in the working directory) take priority over user-level settings (`~/.pi/agent/settings.json`).

```json
{
  "pi-telemetry": {
    "serviceName": "my-service",
    "serviceVersion": "1.0.0",
    "includePayloads": true,
    "langfuse": {
      "enabled": true,
      "publicKey": "pk-lf-...",
      "secretKey": "sk-lf-...",
      "baseUrl": "https://cloud.langfuse.com",
      "transport": "sdk",
      "flushAt": 20,
      "flushIntervalMs": 5000
    },
    "otel": {
      "enabled": true,
      "endpoint": "https://otel-collector.example.com",
      "headers": { "Authorization": "Bearer ..." },
      "flushAt": 20,
      "flushIntervalMs": 5000
    }
  }
}
```

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serviceName` | `string` | `"pi-server"` | Service name for traces |
| `serviceVersion` | `string` | — | Service version for traces |
| `includePayloads` | `boolean` | `true` | Include chat payloads, tool args, LLM I/O |

### Langfuse Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable Langfuse exporter |
| `publicKey` | `string` | — | Langfuse public API key |
| `secretKey` | `string` | — | Langfuse secret API key |
| `baseUrl` | `string` | `"https://cloud.langfuse.com"` | Langfuse server URL |
| `transport` | `"sdk" \| "ingestion"` | `"sdk"` | Transport mode |
| `flushAt` | `number` | `20` | Batch size before flush |
| `flushIntervalMs` | `number` | `5000` | Flush interval in ms |

### OTEL Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable OTEL exporter |
| `endpoint` | `string` | — | OTLP traces endpoint |
| `headers` | `Record<string, string>` | — | Request headers |
| `flushAt` | `number` | `20` | Batch size before flush |
| `flushIntervalMs` | `number` | `5000` | Flush interval in ms |
| `errorLabel` | `string` | — | Custom label for error messages |

When the endpoint does not end with `/v1/traces`, the exporter appends `/v1/traces`.

## Programmatic Usage

```ts
import { loadConfigFromFile, resolveConfig } from "@amaster.ai/pi-telemetry/config";
import { createLangfuseExporter } from "@amaster.ai/pi-telemetry/langfuse";
import { createOtelExporter } from "@amaster.ai/pi-telemetry/otel";

const config = resolveConfig(loadConfigFromFile());
const langfuse = createLangfuseExporter(config);
const otel = createOtelExporter(config);
```

## Privacy

Runtime events may include user prompts, assistant responses, tool arguments, tool outputs, and model inputs/outputs. Set `includePayloads: false` to strip these from exported telemetry. For finer control, construct an exporter directly and pass `redactEvent`.
