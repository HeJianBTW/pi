import type { ApiStyle, BuiltInProviderId } from './types.js';

/**
 * Built-in known image models. Maps a model id (or alias) to its built-in
 * provider. Custom providers may add or override entries via settings.
 */
export type BuiltInModelEntry = {
  id: string;
  aliases?: string[];
  provider: BuiltInProviderId;
  /** Remote model id sent to the provider (defaults to id). */
  remoteId?: string;
};

export const BUILT_IN_MODELS: BuiltInModelEntry[] = [
  // OpenAI image generation.
  {
    id: 'gpt-image-2',
    aliases: ['gpt-image'],
    provider: 'openai',
    remoteId: 'gpt-image-2',
  },

  // Google Gemini "Nano Banana" image generation. The `nano-banana` alias
  // points at the most recent stable release; older variants stay addressable
  // by their full id.
  {
    id: 'gemini-3-pro-image',
    aliases: ['nano-banana-pro'],
    provider: 'gemini',
    remoteId: 'gemini-3-pro-image',
  },
  {
    id: 'gemini-3-pro-image-preview',
    provider: 'gemini',
    remoteId: 'gemini-3-pro-image-preview',
  },
  {
    id: 'gemini-3.1-flash-image',
    aliases: ['nano-banana', 'nano-banana-3'],
    provider: 'gemini',
    remoteId: 'gemini-3.1-flash-image',
  },
  {
    id: 'gemini-3.1-flash-image-preview',
    provider: 'gemini',
    remoteId: 'gemini-3.1-flash-image-preview',
  },
  {
    id: 'gemini-2.5-flash-image',
    aliases: ['nano-banana-2', 'gemini-image'],
    provider: 'gemini',
    remoteId: 'gemini-2.5-flash-image',
  },
  {
    id: 'gemini-2.0-flash-image',
    provider: 'gemini',
    remoteId: 'gemini-2.0-flash-image',
  },

  // Alibaba Qwen-Image / WanX series via DashScope. The `qwen-image-2` and
  // `qwen-image` aliases point at the most recent stable Qwen image release.
  {
    id: 'qwen-image-2.0-pro',
    aliases: ['qwen-image-pro'],
    provider: 'dashscope',
    remoteId: 'qwen-image-2.0-pro',
  },
  {
    id: 'qwen-image-2.0',
    aliases: ['qwen-image-2', 'qwen-image'],
    provider: 'dashscope',
    remoteId: 'qwen-image-2.0',
  },
];

export const DEFAULT_BASE_URL: Record<BuiltInProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  dashscope: 'https://dashscope.aliyuncs.com/api/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

export const DEFAULT_API_STYLE: Record<BuiltInProviderId, ApiStyle> = {
  openai: 'openai',
  gemini: 'gemini',
  dashscope: 'dashscope',
  openrouter: 'openrouter',
};

export const ENV_VARS: Record<BuiltInProviderId, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export const PROVIDER_DISPLAY_NAME: Record<BuiltInProviderId, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  dashscope: 'Alibaba DashScope',
  openrouter: 'OpenRouter',
};
