import { BaseProvider, getEnvironmentContext, SEARCH_SYSTEM_PROMPT } from './base.js';
import type { ResolvedProvider, SearchParams, SearchResponse, SearchResult } from './index.js';

const REQUEST_TIMEOUT_MS = 60_000;

export class OpenAIProvider extends BaseProvider {
  readonly id = 'openai' as const;

  override async search(params: SearchParams, provider: ResolvedProvider): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'OpenAI API key not configured. Set OPENAI_API_KEY env var or configure in settings.json.',
      );
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/responses`;
    const tool: Record<string, unknown> = { type: 'web_search' };
    if (params.includeDomains?.length || params.excludeDomains?.length) {
      const filters: Record<string, unknown> = {};
      if (params.includeDomains?.length) filters.allowed_domains = params.includeDomains;
      if (params.excludeDomains?.length) filters.blocked_domains = params.excludeDomains;
      tool.filters = filters;
    }

    const body = {
      model: provider.model ?? 'gpt-5.5',
      instructions: SEARCH_SYSTEM_PROMPT,
      input: `${getEnvironmentContext()}\n\n${params.query}`,
      tools: [tool],
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
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      output: Array<{
        type: string;
        content?: Array<{
          type: string;
          text: string;
          annotations?: Array<{ type: string; url?: string; title?: string }>;
        }>;
      }>;
    };

    let answer = '';
    const results: SearchResult[] = [];
    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        for (const block of item.content) {
          if (block.type === 'output_text') {
            answer += block.text;
            if (block.annotations) {
              for (const ann of block.annotations) {
                if (ann.type === 'url_citation' && ann.url)
                  results.push({ title: ann.title ?? ann.url, url: ann.url, content: '' });
              }
            }
          }
        }
      }
    }

    return { provider: provider.id, query: params.query, answer: answer || undefined, results };
  }
}
