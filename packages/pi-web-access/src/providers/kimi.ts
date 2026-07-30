import { BaseProvider, getEnvironmentContext, SEARCH_SYSTEM_PROMPT } from './base.js';
import type { ResolvedProvider, SearchParams, SearchResponse } from './index.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOL_ROUNDS = 8;
const WEB_SEARCH_FORMULA = 'moonshot/web-search:latest';

interface KimiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface KimiResponse {
  choices: Array<{ finish_reason: string; message: KimiMessage }>;
}

interface KimiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface FormulaFiberResponse {
  status: string;
  context?: {
    output?: string;
    encrypted_output?: string;
  };
}

export class KimiProvider extends BaseProvider {
  readonly id = 'kimi' as const;

  override async search(params: SearchParams, provider: ResolvedProvider): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Kimi API key not configured. Set MOONSHOT_API_KEY env var or configure in settings.json.',
      );
    }

    const messages: KimiMessage[] = [
      { role: 'system', content: SEARCH_SYSTEM_PROMPT },
      { role: 'user', content: `${getEnvironmentContext()}\n\n${params.query}` },
    ];

    const tools = await this.loadTools(provider);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.callApi(messages, tools, provider);
      const choice = response.choices[0];
      if (!choice) throw new Error('Kimi API returned empty response');

      const toolCalls = choice.message.tool_calls ?? [];
      if (choice.finish_reason !== 'tool_calls' || toolCalls.length === 0) {
        return {
          provider: provider.id,
          query: params.query,
          answer: choice.message.content ?? '',
          results: [],
        };
      }

      messages.push(choice.message);
      for (const toolCall of toolCalls) {
        const fiber = await this.executeFormula(toolCall.function, provider);
        const content = fiber.context?.output || fiber.context?.encrypted_output;
        if (!content) throw new Error('Kimi Formula web search returned no output');
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content,
        });
      }
    }
    throw new Error(`Kimi Formula web search exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
  }

  private async callApi(
    messages: KimiMessage[],
    tools: KimiTool[],
    provider: ResolvedProvider,
  ): Promise<KimiResponse> {
    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: provider.model ?? 'kimi-k3',
      messages,
      tools,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(provider),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Kimi API error ${response.status}`);
    }
    return (await response.json()) as KimiResponse;
  }

  private async loadTools(provider: ResolvedProvider): Promise<KimiTool[]> {
    const baseUrl = provider.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/formulas/${WEB_SEARCH_FORMULA}/tools`, {
      headers: this.headers(provider),
      signal: AbortSignal.timeout(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Kimi API error ${response.status}`);
    }
    const data = (await response.json()) as { tools: KimiTool[] };
    if (!Array.isArray(data.tools) || data.tools.length === 0) {
      throw new Error('Kimi Formula web search returned no tools');
    }
    return data.tools;
  }

  private async executeFormula(
    toolCall: { name: string; arguments: string },
    provider: ResolvedProvider,
  ): Promise<FormulaFiberResponse> {
    const baseUrl = provider.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/formulas/${WEB_SEARCH_FORMULA}/fibers`, {
      method: 'POST',
      headers: this.headers(provider),
      body: JSON.stringify(toolCall),
      signal: AbortSignal.timeout(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Kimi API error ${response.status}`);
    }
    const fiber = (await response.json()) as FormulaFiberResponse;
    if (fiber.status !== 'succeeded') throw new Error('Kimi Formula web search failed');
    return fiber;
  }

  private headers(provider: ResolvedProvider): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    };
  }
}
