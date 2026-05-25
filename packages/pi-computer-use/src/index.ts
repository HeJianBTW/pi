import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { type ComputerUseConfig, loadConfigFromFile, resolveConfig } from './config.js';
import { CuaDriverClient } from './mcp-client.js';
import { createPiVisionCaller } from './vision.js';

export type { ComputerUseConfig };
export { loadConfigFromFile, resolveConfig };

const TOOL_PREFIX = 'computer_use_';

const EXCLUDED_TOOLS = new Set([
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_style',
  'get_agent_cursor_state',
  'set_recording',
  'get_recording_state',
  'replay_trajectory',
  'check_permissions',
  'get_config',
  'set_config',
  'move_cursor',
  'zoom',
  'type_text_chars',
  'page',
  'browser_eval',
]);

export default function computerUseExtension(pi: ExtensionAPI): void {
  let config: ComputerUseConfig | undefined;
  let client: CuaDriverClient | undefined;
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (!client) throw new Error('pi-computer-use: session not started');
    if (!connected) {
      await client.connect();
      connected = true;
    }
  }

  async function registerUpstreamTools(): Promise<void> {
    await ensureConnected();
    const upstreamTools = await client!.listAllTools();

    for (const tool of upstreamTools) {
      if (EXCLUDED_TOOLS.has(tool.name)) continue;

      const prefixedName = `${TOOL_PREFIX}${tool.name}`;
      const originalName = tool.name;

      pi.registerTool({
        name: prefixedName,
        label: prefixedName,
        description: tool.description ?? '',
        parameters: Type.Unsafe(tool.inputSchema),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          ctx: ExtensionContext,
        ) {
          await ensureConnected();
          const result = await client!.callTool(originalName, params);

          if (result.isError) {
            const errorText = result.content?.map((c) => c.text ?? '').join('') ?? '';
            if (errorText.includes('ax_not_granted')) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Accessibility permission not granted. The user needs to enable it in System Settings → Privacy & Security → Accessibility, then restart the app.',
                  },
                ],
                details: undefined,
                isError: true,
              };
            }
            if (errorText.includes('sc_not_granted')) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Screen Recording permission not granted. The user needs to enable it in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.',
                  },
                ],
                details: undefined,
                isError: true,
              };
            }
          }

          if (originalName === 'screenshot' && config?.visionModel) {
            const imageContent = result.content?.find((c) => c.type === 'image' && c.data);
            if (imageContent?.data) {
              const callVision = createPiVisionCaller(config.visionModel, ctx);
              const analysis = await callVision(
                'Describe the full screen: identify all visible windows, UI elements, buttons, text fields, and their positions.',
                imageContent.data,
                imageContent.mimeType ?? 'image/png',
              );
              return {
                content: [{ type: 'text' as const, text: analysis }],
                details: undefined,
              };
            }
          }

          const content: Array<{ type: 'text'; text: string }> = [];
          if (result.content) {
            for (const item of result.content) {
              if (item.type === 'text' && item.text) {
                content.push({ type: 'text', text: item.text });
              }
            }
          }
          if (content.length === 0) {
            content.push({ type: 'text', text: 'Action executed.' });
          }

          return result.isError
            ? { content, details: undefined, isError: true }
            : { content, details: undefined };
        },
      });
    }
  }

  async function registerVisionTool(): Promise<void> {
    if (!config?.visionModel) return;
    const visionConfig = config.visionModel;

    pi.registerTool({
      name: `${TOOL_PREFIX}analyze_screenshot`,
      label: `${TOOL_PREFIX}analyze_screenshot`,
      description:
        'Take a screenshot and analyze it visually using a vision model. Use when you need to identify elements by visual attributes (color, layout, position) or need precise pixel coordinates.',
      parameters: Type.Object({
        instruction: Type.Optional(
          Type.String({
            description:
              'What to identify or analyze visually (e.g., "Find the coordinates of the blue submit button").',
          }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        await ensureConnected();

        const screenshotResult = await client!.callTool('screenshot', {});
        const imageContent = screenshotResult.content?.find((c) => c.type === 'image' && c.data);

        if (!imageContent?.data) {
          return {
            content: [{ type: 'text' as const, text: 'Failed to capture screenshot.' }],
            details: undefined,
            isError: true,
          };
        }

        const callVision = createPiVisionCaller(visionConfig, ctx);
        const instruction =
          (params.instruction as string) ??
          'Describe the full screen: identify all visible windows, UI elements, buttons, text fields, and their positions.';
        const analysis = await callVision(
          instruction,
          imageContent.data,
          imageContent.mimeType ?? 'image/png',
        );

        return {
          content: [{ type: 'text' as const, text: analysis }],
          details: undefined,
        };
      },
    });
  }

  pi.on('session_start', async (_event, ctx) => {
    config = resolveConfig(loadConfigFromFile({ cwd: ctx.cwd }));
    client = new CuaDriverClient(config);
    connected = false;
    await registerUpstreamTools();
    await registerVisionTool();

    try {
      const permResult = await client!.callTool('check_permissions', {});
      const structured = (permResult as Record<string, unknown>).structuredContent as
        | { accessibility?: boolean; screen_recording?: boolean }
        | undefined;
      if (structured) {
        if (!structured.accessibility) {
          ctx.ui.notify(
            'pi-computer-use: Accessibility not granted. Go to System Settings → Privacy & Security → Accessibility to enable.',
            'warning',
          );
        }
        if (!structured.screen_recording) {
          ctx.ui.notify(
            'pi-computer-use: Screen Recording not granted. Go to System Settings → Privacy & Security → Screen & System Audio Recording to enable.',
            'warning',
          );
        }
      }
    } catch {
      // permission check is best-effort — do not block session start
    }
  });

  pi.on('session_shutdown', async () => {
    if (connected && client) {
      await client.close();
      connected = false;
    }
  });
}
