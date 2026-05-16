import type {
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeToolEvent,
} from '@amaster.ai/pi-types';

export type RuntimeTelemetryEvent =
  | RuntimeLifecycleEvent
  | RuntimeToolEvent
  | RuntimeLlmGenerationEvent;

export interface RuntimeEventExporter {
  publish(event: RuntimeTelemetryEvent): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export type TelemetryEnvironment = Record<string, string | undefined>;

export type TelemetryFetch = (
  input: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type TelemetryRedactor = (event: RuntimeTelemetryEvent) => RuntimeTelemetryEvent | undefined;

export type RuntimeTelemetryOptions = {
  serviceName?: string | undefined;
  serviceVersion?: string | undefined;
  includePayloads?: boolean;
  redactEvent?: TelemetryRedactor | undefined;
};

export class NoopRuntimeEventExporter implements RuntimeEventExporter {
  async publish(): Promise<void> {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export class CompositeRuntimeEventExporter implements RuntimeEventExporter {
  constructor(private readonly exporters: RuntimeEventExporter[]) {}

  async publish(event: RuntimeTelemetryEvent): Promise<void> {
    await Promise.allSettled(this.exporters.map((exporter) => exporter.publish(event)));
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.exporters.map((exporter) => exporter.flush?.()));
  }

  async close(): Promise<void> {
    await this.flush();
    await Promise.allSettled(this.exporters.map((exporter) => exporter.close?.()));
  }
}
