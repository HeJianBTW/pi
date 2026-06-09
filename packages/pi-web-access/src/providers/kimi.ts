import { BaseProvider } from './base.js';
import type { ResolvedProvider, SearchParams, SearchResponse } from './index.js';

const REQUEST_TIMEOUT_MS = 60_000;

interface KimiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
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

export class KimiProvider extends BaseProvider {
  readonly id = 'kimi' as const;

  override async search(params: SearchParams, provider: ResolvedProvider): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Kimi API key not configured. Set MOONSHOT_API_KEY env var or configure in settings.json.',
      );
    }

    const messages: KimiMessage[] = [
      {
        role: 'system',
        content:
          'You are a helpful assistant that searches the web to answer questions. Provide concise, factual answers based on web search results.',
      },
      { role: 'user', content: params.query },
    ];

    const firstResponse = await this.callApi(messages, provider);
    const firstChoice = firstResponse.choices[0];
    if (!firstChoice) throw new Error('Kimi API returned empty response');

    if (firstChoice.finish_reason === 'tool_calls' && firstChoice.message.tool_calls?.length) {
      const toolCall = firstChoice.message.tool_calls[0]!;
      messages.push(firstChoice.message);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolCall.function.arguments,
      });

      const secondResponse = await this.callApi(messages, provider);
      const answer = secondResponse.choices[0]?.message.content ?? '';
      return { provider: provider.id, query: params.query, answer, results: [] };
    }

    return {
      provider: provider.id,
      query: params.query,
      answer: firstChoice.message.content ?? '',
      results: [],
    };
  }

  private async callApi(
    messages: KimiMessage[],
    provider: ResolvedProvider,
  ): Promise<KimiResponse> {
    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: provider.model ?? 'kimi-k2.6',
      messages,
      tools: [{ type: 'builtin_function', function: { name: '$web_search' } }],
      thinking: { type: 'disabled' },
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Kimi API error ${response.status}: ${text}`);
    }
    return (await response.json()) as KimiResponse;
  }
}
