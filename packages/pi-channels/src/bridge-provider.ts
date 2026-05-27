import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type CreditsModelCommonConfig = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

export default function bridgeProvider(pi: ExtensionAPI): void {
  const anthropicBaseUrl = trimToUndefined(process.env.ANTHROPIC_BASE_URL);
  const anthropicApiKey = trimToUndefined(process.env.ANTHROPIC_API_KEY);
  const modelIds = [
    ...parseList(process.env.ANTHROPIC_MODELS),
    trimToUndefined(process.env.ANTHROPIC_MODEL),
    trimToUndefined(process.env.ANTHROPIC_FLASH_MODEL),
    trimToUndefined(process.env.MODEL),
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  if (!anthropicBaseUrl || !anthropicApiKey || modelIds.length === 0) {
    return;
  }

  pi.registerProvider('anthropic-compatible', {
    baseUrl: anthropicBaseUrl,
    apiKey: anthropicApiKey,
    models: modelIds.map((modelId) => createModelConfig(modelId, anthropicBaseUrl)),
  });
}

function createModelConfig(modelId: string, anthropicBaseUrl: string) {
  const common = {
    id: modelId,
    name: modelId,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: parsePositiveIntegerEnv(process.env.MODEL_CONTEXT_WINDOW, 256000),
    maxTokens: parsePositiveIntegerEnv(process.env.MODEL_MAX_TOKENS, 32000),
  } satisfies CreditsModelCommonConfig;

  if (modelId.toLowerCase().includes('kimi')) {
    return {
      ...common,
      api: 'openai-completions' as const,
      baseUrl: toOpenAICompatibleBaseUrl(anthropicBaseUrl),
      thinkingLevelMap: {
        minimal: 'high',
        low: 'high',
        medium: 'high',
        high: 'high',
        xhigh: 'high',
      },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsStrictMode: false,
        maxTokensField: 'max_tokens',
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek',
        supportsLongCacheRetention: false,
      },
    };
  }

  return {
    ...common,
    api: 'anthropic-messages' as const,
    compat: {
      supportsEagerToolInputStreaming: true,
      supportsLongCacheRetention: true,
    },
  };
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toOpenAICompatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}
