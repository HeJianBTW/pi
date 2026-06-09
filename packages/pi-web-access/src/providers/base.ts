import type { BuiltInProviderId } from '../types.js';

// ─── Provider contract types ─────────────────────────────────────────────────

export interface ResolvedProvider {
  id: BuiltInProviderId;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}

export interface SearchParams {
  query: string;
  maxResults?: number;
  topic?: 'general' | 'news';
  timeRange?: 'day' | 'week' | 'month' | 'year';
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface SearchResponse {
  provider: string;
  query: string;
  answer?: string | undefined;
  results: SearchResult[];
}

export interface FetchResponse {
  url: string;
  title: string;
  content: string;
}

// ─── Provider interface & base class ─────────────────────────────────────────

export interface WebProvider {
  readonly id: BuiltInProviderId;
  search(params: SearchParams, provider: ResolvedProvider): Promise<SearchResponse>;
  fetch(url: string, provider: ResolvedProvider): Promise<FetchResponse>;
}

export abstract class BaseProvider implements WebProvider {
  abstract readonly id: BuiltInProviderId;

  async search(_params: SearchParams, _provider: ResolvedProvider): Promise<SearchResponse> {
    throw new Error(`${this.id} does not support web_search.`);
  }

  async fetch(_url: string, _provider: ResolvedProvider): Promise<FetchResponse> {
    throw new Error(`${this.id} does not support web_fetch.`);
  }
}
