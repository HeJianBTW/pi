import { BaseProvider } from './base.js';
import type { ResolvedProvider, SearchParams, SearchResponse, SearchResult } from './index.js';

const REQUEST_TIMEOUT_MS = 60_000;

export class GeminiProvider extends BaseProvider {
  readonly id = 'gemini' as const;

  override async search(params: SearchParams, provider: ResolvedProvider): Promise<SearchResponse> {
    if (!provider.apiKey) {
      throw new Error(
        'Gemini API key not configured. Set GEMINI_API_KEY env var or configure in settings.json.',
      );
    }

    const model = provider.model ?? 'gemini-2.5-flash';
    const url = `${provider.baseUrl.replace(/\/$/, '')}/models/${model}:generateContent`;
    const body = {
      contents: [{ parts: [{ text: params.query }] }],
      tools: [{ google_search: {} }],
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': provider.apiKey,
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
      throw new Error(`Gemini API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      candidates: Array<{
        content: { parts: Array<{ text: string }> };
        groundingMetadata?: { groundingChunks?: Array<{ web?: { uri: string; title: string } }> };
      }>;
    };
    const candidate = data.candidates[0];
    if (!candidate) throw new Error('Gemini API returned empty response');

    const answer = candidate.content.parts.map((p) => p.text).join('');
    const results: SearchResult[] = (candidate.groundingMetadata?.groundingChunks ?? [])
      .filter((c) => c.web)
      .map((c) => ({ title: c.web!.title, url: c.web!.uri, content: '' }));

    return { provider: provider.id, query: params.query, answer, results };
  }
}
