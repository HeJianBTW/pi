/**
 * Pi extension that registers a custom OpenAI-compatible provider for CI integration tests.
 *
 * Endpoint and credentials come from env vars set by the workflow. Both fields use pi's
 * `$VAR` config-value syntax — pi itself reads the env at request time, so the values
 * never appear in this file:
 *   PI_INTEGRATION_BASE_URL — provider base URL (OpenAI-compatible, must include /v1)
 *   PI_INTEGRATION_API_KEY  — API key value
 *
 * Used by .github/workflows/integration.yml to drive a single non-interactive
 * `pi -p` prompt through deepseek-v4-flash and verify all bundled extensions load.
 *
 * DeepSeek thinking-mode reference: https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 *   - effort levels accepted: "high" and "max" (low/medium/high → high; xhigh → max)
 *   - request shape: {"thinking": {"type": "enabled"}, "reasoning_effort": "max"}
 *   - that shape requires `thinkingFormat: "deepseek"` AND `supportsReasoningEffort: true`
 */

const PROVIDER_NAME = 'deepseek-integration';
const MODEL_ID = 'deepseek-v4-flash';

export default function integrationProvider(pi) {
  // Fail early at registration time if the workflow forgot to wire up secrets.
  // (pi would also error later at request time, but this gives a clearer message.)
  if (!process.env.PI_INTEGRATION_BASE_URL?.trim()) {
    throw new Error(
      '[integration-provider] PI_INTEGRATION_BASE_URL is not set; refusing to register provider',
    );
  }
  if (!process.env.PI_INTEGRATION_API_KEY) {
    throw new Error(
      '[integration-provider] PI_INTEGRATION_API_KEY is not set; refusing to register provider',
    );
  }

  pi.registerProvider(PROVIDER_NAME, {
    name: 'DeepSeek (CI integration)',
    baseUrl: '$PI_INTEGRATION_BASE_URL',
    apiKey: '$PI_INTEGRATION_API_KEY',
    authHeader: true,
    api: 'openai-completions',
    models: [
      {
        id: MODEL_ID,
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        thinkingLevelMap: {
          minimal: 'high',
          low: 'high',
          medium: 'high',
          high: 'high',
          xhigh: 'max',
        },
        compat: {
          thinkingFormat: 'deepseek',
          supportsReasoningEffort: true,
          supportsDeveloperRole: false,
          maxTokensField: 'max_tokens',
        },
      },
    ],
  });
}
