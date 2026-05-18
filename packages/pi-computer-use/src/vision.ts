import { type TextContent as AiTextContent, complete } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { VisionModelConfig } from './config.js';

export const VISUAL_SYSTEM_PROMPT = `You are a Visual Analysis Agent for computer-use automation.
You receive screenshots of a desktop and instructions about what to identify or analyze.

Your responses must:
- Describe UI elements with their exact pixel coordinates (x, y) relative to the top-left corner (0, 0)
- Identify clickable elements (buttons, links, inputs, menus) and their bounding regions
- Describe the current state of the screen (active window, focused element, visible text)
- Note any dialogs, popups, or overlays that may block interaction
- Provide spatial relationships between elements

When reporting coordinates for click targets, give the CENTER point of the element.
Format coordinates as (x, y) inline with descriptions.

If an element is not visible on screen, explicitly state so.
Do NOT perform actions — only analyze and report what you see.`;

export type VisionCaller = (
  instruction: string,
  imageBase64: string,
  mimeType: string,
) => Promise<string>;

export function createPiVisionCaller(
  visionConfig: VisionModelConfig,
  ctx: ExtensionContext,
): VisionCaller {
  return async (instruction: string, imageBase64: string, mimeType: string): Promise<string> => {
    const model = ctx.modelRegistry.find(visionConfig.provider, visionConfig.model);
    if (!model) {
      throw new Error(
        `Vision model "${visionConfig.provider}/${visionConfig.model}" not found in model registry.`,
      );
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(`Auth failed for vision model: ${auth.error}`);
    }

    const options: Record<string, unknown> = {
      temperature: 0,
      maxTokens: 2048,
    };
    if (auth.apiKey) options.apiKey = auth.apiKey;
    if (auth.headers) options.headers = auth.headers;

    const result = await complete(
      model,
      {
        systemPrompt: VISUAL_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user' as const,
            content: [
              {
                type: 'text' as const,
                text: `Analyze this screenshot and respond to the following instruction:\n\n${instruction}`,
              },
              { type: 'image' as const, data: imageBase64, mimeType },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      options,
    );

    return result.content
      .filter((c): c is AiTextContent => c.type === 'text')
      .map((c) => c.text)
      .join('');
  };
}
