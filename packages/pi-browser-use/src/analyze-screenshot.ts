/**
 * Optional vision-model integration.
 *
 * Takes a screenshot via the upstream take_screenshot tool, sends it to a
 * vision model, and returns the analysis as text. This lets the LLM identify
 * elements by visual attributes (color, layout, coordinates) when the
 * accessibility tree is insufficient.
 *
 * Two calling modes:
 * - Extension mode: uses pi-ai's complete() via the model registry (no raw fetch)
 * - CLI mode: uses raw fetch to OpenAI-compatible APIs (createFetchVisionCaller)
 */

import type { VisionModelConfig } from './config.js';
import type { DevToolsClient } from './index.js';

/** System prompt for the vision analysis model. */
export const VISUAL_SYSTEM_PROMPT = `You are a Visual Analysis Agent. You receive a screenshot of a browser page and an instruction.

Your job is to ANALYZE the screenshot and provide precise information that a browser automation agent can act on.

COORDINATE SYSTEM:
- Coordinates are pixel-based relative to the viewport
- (0,0) is top-left of the visible area
- Estimate element positions from the screenshot

RESPONSE FORMAT:
- For coordinate identification: provide exact (x, y) pixel coordinates
- For element identification: describe the element's visual location and appearance
- For layout analysis: describe the spatial relationships between elements
- Be concise and actionable

IMPORTANT:
- You are NOT performing actions — you are only providing visual analysis
- Include coordinates when possible so the caller can use click_at(x, y)
- If the element is not visible in the screenshot, say so explicitly`;

/**
 * Abstraction for calling a vision model.
 * Extension mode and CLI mode each provide their own implementation.
 */
export type VisionCaller = (
  instruction: string,
  imageBase64: string,
  mimeType: string,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Raw-fetch implementation for standalone CLI mode
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

function getApiKeyFromEnv(provider: string): string | undefined {
  const envMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
  };
  const envVar = envMap[provider.toLowerCase()];
  return envVar ? process.env[envVar] : undefined;
}

function getDefaultBaseUrl(provider: string): string {
  const urlMap: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
  };
  return urlMap[provider.toLowerCase()] ?? `https://api.${provider}.com/v1`;
}

/** Create a VisionCaller backed by raw fetch (OpenAI-compatible API). Used in CLI standalone mode. */
export function createFetchVisionCaller(visionConfig: VisionModelConfig): VisionCaller {
  return async (instruction: string, imageBase64: string, mimeType: string): Promise<string> => {
    const apiKey = visionConfig.apiKey ?? getApiKeyFromEnv(visionConfig.provider);
    if (!apiKey) {
      throw new Error(
        `No API key for vision model provider "${visionConfig.provider}". ` +
          `Set apiKey in visionModel config or the appropriate environment variable.`,
      );
    }

    const baseUrl = visionConfig.baseUrl ?? getDefaultBaseUrl(visionConfig.provider);

    const messages: ChatMessage[] = [
      { role: 'system', content: VISUAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this screenshot and respond to the following instruction:\n\n${instruction}`,
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
        ],
      },
    ];

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: visionConfig.model,
        messages,
        temperature: 0,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Vision model API error (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? '';
  };
}

// ---------------------------------------------------------------------------
// Main handler (framework-agnostic)
// ---------------------------------------------------------------------------

/**
 * Capture a screenshot via the upstream tool and analyze it with the provided vision caller.
 * The caller abstraction allows extension mode (pi-ai) and CLI mode (raw fetch) to share logic.
 */
export async function handleAnalyzeScreenshot(
  client: DevToolsClient,
  callVision: VisionCaller,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const instruction = String(args.instruction ?? '');

  try {
    const screenshotResult = await client.callTool('take_screenshot', {});

    let imageBase64 = '';
    let mimeType = 'image/png';
    if (screenshotResult.content && Array.isArray(screenshotResult.content)) {
      for (const item of screenshotResult.content) {
        if (item.type === 'image' && item.data) {
          imageBase64 = item.data;
          mimeType = item.mimeType ?? 'image/png';
          break;
        }
      }
    }

    if (!imageBase64) {
      return {
        content: [
          {
            type: 'text',
            text: 'Failed to capture screenshot for visual analysis. Use accessibility tree elements instead.',
          },
        ],
        isError: true,
      };
    }

    const analysis = await callVision(instruction, imageBase64, mimeType);

    if (!analysis) {
      return {
        content: [
          {
            type: 'text',
            text: 'Visual model returned no analysis. Use accessibility tree elements instead.',
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: `Visual Analysis Result:\n${analysis}` }],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    const isModelError =
      errorMsg.includes('404') ||
      errorMsg.includes('403') ||
      errorMsg.includes('not found') ||
      errorMsg.includes('permission');

    const fallbackMsg = isModelError
      ? 'Visual analysis model is not available. Use accessibility tree elements (uids from take_snapshot) for all interactions instead.'
      : `Visual analysis failed: ${errorMsg}. Use accessibility tree elements instead.`;

    return {
      content: [{ type: 'text', text: fallbackMsg }],
      isError: true,
    };
  }
}
