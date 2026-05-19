import { loadPiSettings } from '@amaster.ai/pi-shared/settings';

export interface LangfuseConfig {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  transport?: 'sdk' | 'ingestion';
  flushAt?: number;
  flushIntervalMs?: number;
}

export interface OtelConfig {
  enabled?: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  flushAt?: number;
  flushIntervalMs?: number;
  errorLabel?: string;
}

export interface TelemetryConfig {
  serviceName?: string;
  serviceVersion?: string;
  includePayloads?: boolean;

  langfuse?: LangfuseConfig;
  otel?: OtelConfig;
}

const DEFAULTS: TelemetryConfig = {
  serviceName: 'pi-server',
  includePayloads: true,
};

export function resolveConfig(config?: TelemetryConfig): TelemetryConfig {
  return { ...DEFAULTS, ...config };
}

export function loadConfigFromFile(): TelemetryConfig {
  return loadPiSettings<TelemetryConfig>('pi-telemetry');
}
