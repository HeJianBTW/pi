import type { ApiStyle, ImageProviderAdapter } from '../types.js';
import { dashscopeAdapter } from './dashscope.js';
import { geminiAdapter } from './gemini.js';
import { openaiAdapter } from './openai.js';

// OpenRouter exposes an OpenAI-compatible image endpoint, so it reuses
// openaiAdapter — kept as a separate ApiStyle value so users can label intent
// in customProviders.api without affecting the wire format.
const ADAPTERS: Record<ApiStyle, ImageProviderAdapter> = {
  openai: openaiAdapter,
  gemini: geminiAdapter,
  dashscope: dashscopeAdapter,
  openrouter: openaiAdapter,
};

export function getAdapter(api: ApiStyle): ImageProviderAdapter {
  const adapter = ADAPTERS[api];
  if (!adapter) throw new Error(`Unsupported api "${api}".`);
  return adapter;
}
