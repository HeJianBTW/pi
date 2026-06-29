import type { ApiStyle, ImageProviderAdapter } from '../types.js';
import { dashscopeAdapter } from './dashscope.js';
import { geminiAdapter } from './gemini.js';
import { openaiAdapter } from './openai.js';
import { openrouterAdapter } from './openrouter.js';

const ADAPTERS: Record<ApiStyle, ImageProviderAdapter> = {
  openai: openaiAdapter,
  gemini: geminiAdapter,
  dashscope: dashscopeAdapter,
  openrouter: openrouterAdapter,
};

export function getAdapter(api: ApiStyle): ImageProviderAdapter {
  const adapter = ADAPTERS[api];
  if (!adapter) throw new Error(`Unsupported api "${api}".`);
  return adapter;
}
