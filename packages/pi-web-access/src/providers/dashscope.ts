import type {
  FetchResponse,
  ImageSearchParams,
  ResolvedProvider,
  SearchResponse,
  SearchResult,
} from './base.js';
import { OpenAIProvider, type ResponsesApiStatus } from './openai.js';

// web_search_image returns a model-generated list; cap it as cheap insurance.
const MAX_IMAGE_RESULTS = 20;

interface ResponsesApiResult extends ResponsesApiStatus {
  output_text?: string;
  output?: Array<{ type: string; output?: unknown }>;
}

export class DashscopeProvider extends OpenAIProvider {
  // web_extractor / web_search_image are agent-style tools and can take minutes per call.
  protected readonly defaultTimeoutMs = 5 * 60_000;

  constructor() {
    super('dashscope');
  }

  override async fetch(targetUrl: string, provider: ResolvedProvider): Promise<FetchResponse> {
    const data = await this.postResponses<ResponsesApiResult>(provider, {
      model: provider.model ?? this.defaultModel,
      input: `Please fetch and return the full content at: ${targetUrl}`,
      tools: [{ type: 'web_search' }, { type: 'web_extractor' }],
    });

    const extracted: string[] = [];
    for (const item of data.output ?? []) {
      if (item.type === 'web_extractor_call' && typeof item.output === 'string' && item.output) {
        extracted.push(item.output);
      }
    }

    return {
      url: targetUrl,
      title: targetUrl,
      content: extracted.join('\n\n') || data.output_text || '',
    };
  }

  override async imageSearch(
    params: ImageSearchParams,
    provider: ResolvedProvider,
  ): Promise<SearchResponse> {
    const data = await this.postResponses<ResponsesApiResult>(provider, {
      model: provider.model ?? this.defaultModel,
      input: params.query,
      tools: [{ type: 'web_search_image' }],
    });

    const results: SearchResult[] = [];
    for (const item of data.output ?? []) {
      if (item.type !== 'web_search_image_call' || typeof item.output !== 'string') continue;
      try {
        const images = JSON.parse(item.output) as Array<{ title?: string; url?: string }>;
        for (const image of images) {
          if (image.url) {
            results.push({ title: image.title ?? image.url, url: image.url, content: '' });
          }
        }
      } catch {
        // Ignore malformed image search tool output.
      }
    }

    return {
      provider: provider.id,
      query: params.query,
      answer: data.output_text || undefined,
      results: results.slice(0, MAX_IMAGE_RESULTS),
    };
  }
}
