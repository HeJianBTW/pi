import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { type ComputerAction, dispatchAction } from './actions.js';
import { ComputerClient } from './computer-client.js';
import { type ComputerUseConfig, loadConfigFromFile, resolveConfig } from './config.js';
import { ComputerServerProcess } from './server-process.js';
import { createPiVisionCaller } from './vision.js';

export type { ComputerUseConfig };
export { loadConfigFromFile, resolveConfig };

export default function computerUseExtension(pi: ExtensionAPI): void {
  const config = resolveConfig(loadConfigFromFile());
  const serverProcess = new ComputerServerProcess();
  const client = new ComputerClient(config);
  let started = false;

  async function ensureRunning(): Promise<void> {
    if (started) return;
    if (config.mode !== 'external') {
      await serverProcess.start(config);
    }
    await client.connect();
    started = true;
  }

  pi.registerTool({
    name: 'computer_use',
    label: 'computer_use',
    description:
      'Control a computer desktop. Actions: screenshot, click, double_click, type, keypress, scroll, move, drag, wait, run_command. Each call executes one action and returns the resulting screen state.',
    promptSnippet:
      'computer_use — control a desktop: screenshot, click, type, scroll, keypress, drag, run_command',
    parameters: Type.Object({
      action: Type.Object({
        type: Type.String({
          description:
            'Action type: screenshot | click | double_click | type | keypress | scroll | move | drag | wait | run_command',
        }),
        x: Type.Optional(Type.Number({ description: 'X coordinate (click, double_click, move)' })),
        y: Type.Optional(Type.Number({ description: 'Y coordinate (click, double_click, move)' })),
        button: Type.Optional(
          Type.String({ description: 'Mouse button: left | right (default: left)' }),
        ),
        text: Type.Optional(Type.String({ description: 'Text to type (type action)' })),
        keys: Type.Optional(
          Type.Array(Type.String(), { description: 'Keys to press (keypress action)' }),
        ),
        scroll_x: Type.Optional(Type.Number({ description: 'Horizontal scroll amount' })),
        scroll_y: Type.Optional(Type.Number({ description: 'Vertical scroll amount' })),
        path: Type.Optional(
          Type.Array(Type.Tuple([Type.Number(), Type.Number()]), {
            description: 'Drag path as [[x,y], ...] coordinates',
          }),
        ),
        command: Type.Optional(Type.String({ description: 'Shell command (run_command action)' })),
      }),
    }),
    async execute(
      _toolCallId: string,
      params: { action: ComputerAction },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      await ensureRunning();

      if (params.action.type === 'screenshot') {
        const screenshotBase64 = await client.screenshot();
        if (config.visionModel) {
          const callVision = createPiVisionCaller(config.visionModel, ctx);
          const analysis = await callVision(
            'Describe the full screen: identify all visible windows, UI elements, buttons, text fields, and their positions.',
            screenshotBase64,
            'image/png',
          );
          return { content: [{ type: 'text' as const, text: analysis }], details: undefined };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Screenshot captured (no vision model configured to analyze it).',
            },
          ],
          details: undefined,
        };
      }

      const actionResult = await dispatchAction(client, params.action);

      if (config.autoScreenshot !== false) {
        const screenshotBase64 = await client.screenshot();
        if (config.visionModel) {
          const callVision = createPiVisionCaller(config.visionModel, ctx);
          const analysis = await callVision(
            'Describe the current screen state after the action. Focus on what changed and what is now visible.',
            screenshotBase64,
            'image/png',
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: `${actionResult}\n\nScreen state:\n${analysis}`,
              },
            ],
            details: undefined,
          };
        }
        return {
          content: [{ type: 'text' as const, text: actionResult ?? 'Action executed.' }],
          details: undefined,
        };
      }

      return {
        content: [{ type: 'text' as const, text: actionResult ?? 'Action executed.' }],
        details: undefined,
      };
    },
  });

  pi.on('session_start', async () => {
    // Lazy — actual startup happens on first tool call
  });

  pi.on('session_shutdown', async () => {
    if (started) {
      await client.close();
      await serverProcess.stop();
      started = false;
    }
  });
}
