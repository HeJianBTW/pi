export default function bridgeProvider(pi) {
    const anthropicBaseUrl = trimToUndefined(process.env.ANTHROPIC_BASE_URL);
    const anthropicApiKey = trimToUndefined(process.env.ANTHROPIC_API_KEY);
    const modelIds = [
        ...parseList(process.env.ANTHROPIC_MODELS),
        trimToUndefined(process.env.ANTHROPIC_MODEL),
        trimToUndefined(process.env.ANTHROPIC_FLASH_MODEL),
        trimToUndefined(process.env.MODEL),
    ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
    if (!anthropicBaseUrl || !anthropicApiKey || modelIds.length === 0) {
        return;
    }
    pi.registerProvider('anthropic-compatible', {
        baseUrl: anthropicBaseUrl,
        apiKey: anthropicApiKey,
        models: modelIds.map((modelId) => createModelConfig(modelId, anthropicBaseUrl)),
    });
}
function createModelConfig(modelId, anthropicBaseUrl) {
    const common = {
        id: modelId,
        name: modelId,
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: parsePositiveIntegerEnv(process.env.MODEL_CONTEXT_WINDOW, 256000),
        maxTokens: parsePositiveIntegerEnv(process.env.MODEL_MAX_TOKENS, 32000),
    };
    if (modelId.toLowerCase().includes('kimi')) {
        return {
            ...common,
            api: 'openai-completions',
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
        api: 'anthropic-messages',
        compat: {
            supportsEagerToolInputStreaming: true,
            supportsLongCacheRetention: true,
        },
    };
}
function trimToUndefined(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function parseList(value) {
    return (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}
function parsePositiveIntegerEnv(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function toOpenAICompatibleBaseUrl(baseUrl) {
    const trimmed = baseUrl.replace(/\/+$/, '');
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}
//# sourceMappingURL=bridge-provider.js.map