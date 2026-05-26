import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { type ComputerUseConfig, loadConfigFromFile, resolveConfig } from './config.js';
import { CuaDriverClient } from './mcp-client.js';
import { createPiVisionCaller } from './vision.js';

export type { ComputerUseConfig };
export { loadConfigFromFile, resolveConfig };

const TOOL_PREFIX = 'computer_use_';

const PLATFORM = process.platform;

function permissionHint(): string {
  switch (PLATFORM) {
    case 'darwin':
      return 'Check that Accessibility and Screen Recording permissions are granted in System Settings → Privacy & Security.';
    case 'win32':
      return 'Try running the application as Administrator, or check that UI Automation access is not blocked by security software.';
    default:
      return 'Check that the process has access to the display server (X11/Wayland) and required input permissions are configured.';
  }
}

function accessibilityHint(): string {
  switch (PLATFORM) {
    case 'darwin':
      return 'Accessibility permission not granted. The user needs to enable it in System Settings → Privacy & Security → Accessibility, then restart the app.';
    case 'win32':
      return 'UI Automation access denied. Try running the application as Administrator.';
    default:
      return 'Input automation access denied. Check that AT-SPI or equivalent accessibility service is available.';
  }
}

function screenRecordingHint(): string {
  switch (PLATFORM) {
    case 'darwin':
      return 'Screen Recording permission not granted. The user needs to enable it in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.';
    case 'win32':
      return 'Screen capture failed. Try running the application as Administrator, or check that screen capture is not blocked by DRM or security policy.';
    default:
      return 'Screen capture failed. Check that the compositor allows screen capture (PipeWire portal or X11 access).';
  }
}

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
  'screenshot',
]);

const FALLBACK_TOOLS: Array<{ name: string; description: string; inputSchema: object }> = [
  {
    name: 'click',
    description: 'Left-click against a target pid via element_index or x/y coordinates',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer', description: 'Target process ID' },
        x: { type: 'number', description: 'Window-local screenshot X coordinate' },
        y: { type: 'number', description: 'Window-local screenshot Y coordinate' },
        element_index: { type: 'integer', description: 'Element index from last get_window_state' },
        window_id: { type: 'integer', description: 'Target window ID. Required for element_index' },
        action: {
          type: 'string',
          description: 'AX action: press, show_menu, pick, confirm, cancel, open',
        },
        modifier: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys: cmd, shift, option/alt, ctrl',
        },
        from_zoom: {
          type: 'boolean',
          description: 'When true, x/y are in last zoom image coordinates',
        },
      },
      required: ['pid'],
    },
  },
  {
    name: 'double_click',
    description: 'Double-click at x/y or on an AX element via element_index',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer' },
        x: { type: 'number', description: 'Screen X coordinate (pixel path)' },
        y: { type: 'number', description: 'Screen Y coordinate (pixel path)' },
        element_index: { type: 'integer', description: 'Element index from last get_window_state' },
        window_id: {
          type: 'integer',
          description: 'CGWindowID. Required when element_index is used',
        },
      },
      required: ['pid'],
    },
  },
  {
    name: 'right_click',
    description: 'Right-click against a target pid via element_index or x/y coordinates',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer', description: 'Target process ID' },
        x: { type: 'number', description: 'X in window-local screenshot pixels' },
        y: { type: 'number', description: 'Y in window-local screenshot pixels' },
        element_index: {
          type: 'integer',
          description: 'Element index from last get_window_state. Routes through AXShowMenu',
        },
        window_id: {
          type: 'integer',
          description: 'CGWindowID. Required when element_index is used',
        },
        modifier: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys held during the right-click (pixel path only)',
        },
      },
      required: ['pid'],
    },
  },
  {
    name: 'type_text',
    description: 'Insert text into the target pid via AX or CGEvent fallback',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer', description: 'Target process ID' },
        text: { type: 'string', description: 'Text to insert at the target cursor' },
        element_index: { type: 'integer', description: 'Element index from last get_window_state' },
        window_id: {
          type: 'integer',
          description: 'CGWindowID. Required when element_index is used',
        },
        delay_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 200,
          description: 'Milliseconds between characters in CGEvent fallback. Default 30',
        },
      },
      required: ['pid', 'text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press and release a single key, delivered to the target pid',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer' },
        key: {
          type: 'string',
          description: 'Key name: return, tab, escape, up, down, left, right, space, delete, etc.',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys: cmd, shift, option/alt, ctrl, fn',
        },
        element_index: { type: 'integer' },
        window_id: { type: 'integer' },
      },
      required: ['pid', 'key'],
    },
  },
  {
    name: 'hotkey',
    description: 'Press a combination of keys simultaneously, e.g. ["cmd", "c"] for Copy',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer', description: 'Target process ID' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          description: 'Modifier(s) and one non-modifier key, e.g. ["cmd", "c"]',
        },
        window_id: {
          type: 'integer',
          description: 'When set, uses NSMenu path for native menu key dispatch',
        },
      },
      required: ['pid', 'keys'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the target pid focused region by synthesized keystrokes',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer' },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction',
        },
        amount: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Number of keystroke repetitions. Default: 3',
        },
        by: {
          type: 'string',
          enum: ['line', 'page'],
          description: 'Scroll granularity. Default: line',
        },
        element_index: { type: 'integer' },
        window_id: { type: 'integer' },
      },
      required: ['pid', 'direction'],
    },
  },
  {
    name: 'drag',
    description: 'Press-drag-release gesture from one point to another in window-local pixels',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer', description: 'Target process ID' },
        from_x: { type: 'number', description: 'Drag-start X in window-local screenshot pixels' },
        from_y: { type: 'number', description: 'Drag-start Y in window-local screenshot pixels' },
        to_x: { type: 'number', description: 'Drag-end X in window-local screenshot pixels' },
        to_y: { type: 'number', description: 'Drag-end Y in window-local screenshot pixels' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button. Default: left',
        },
        duration_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
          description: 'Duration of drag path. Default: 500',
        },
        steps: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Intermediate drag events. Default: 20',
        },
        modifier: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys held across the gesture',
        },
        window_id: { type: 'integer' },
        from_zoom: { type: 'boolean' },
      },
      required: ['pid', 'from_x', 'from_y', 'to_x', 'to_y'],
    },
  },
  {
    name: 'set_value',
    description: 'Set a value on a UI element (popups, sliders, steppers, date pickers)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer' },
        window_id: {
          type: 'integer',
          description:
            'CGWindowID for the window whose get_window_state produced the element_index',
        },
        element_index: { type: 'integer' },
        value: {
          type: 'string',
          description: 'New value. AX will coerce to the element native type',
        },
      },
      required: ['pid', 'window_id', 'element_index', 'value'],
    },
  },
  {
    name: 'get_screen_size',
    description: 'Return the logical size of the main display in points plus backing scale factor',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_cursor_position',
    description: 'Return the current mouse cursor position in screen points',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_accessibility_tree',
    description:
      'Return a lightweight desktop snapshot: running apps and visible windows with bounds and z-order',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_window_state',
    description:
      'Walk an app AX tree and return a Markdown rendering of its UI with actionable element indices',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer', description: 'Target process ID' },
        window_id: { type: 'integer', description: 'Target window ID from list_windows' },
        query: { type: 'string', description: 'Case-insensitive filter for tree_markdown' },
        capture_mode: {
          type: 'string',
          enum: ['som', 'vision', 'ax'],
          description: 'som=AX+screenshot (default), vision=screenshot only, ax=AX only',
        },
      },
      required: ['pid', 'window_id'],
    },
  },
  {
    name: 'list_windows',
    description: 'List all layer-0 top-level windows known to WindowServer',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pid: { type: 'integer', description: 'Optional pid filter' },
        on_screen_only: {
          type: 'boolean',
          description: 'When true, drop windows not on current Space. Default false',
        },
      },
    },
  },
  {
    name: 'list_apps',
    description: 'List macOS apps (running and installed) with state flags, pid, bundle_id',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'launch_app',
    description: 'Launch a macOS app in the background without stealing focus',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bundle_id: {
          type: 'string',
          description: 'App bundle identifier, e.g. com.apple.calculator. Preferred over name',
        },
        name: {
          type: 'string',
          description: 'App display name. Used only when bundle_id is absent',
        },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths or URLs to open with the app',
        },
        creates_new_application_instance: {
          type: 'boolean',
          description: 'Force a new app instance even if already running',
        },
      },
    },
  },
  {
    name: 'kill_app',
    description: 'Force-terminate a process by pid (kill -9 equivalent)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { pid: { type: 'integer', description: 'PID of the process to terminate' } },
      required: ['pid'],
    },
  },
];

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

  function registerTools(
    tools: Array<{ name: string; description?: string | undefined; inputSchema: unknown }>,
  ): void {
    for (const tool of tools) {
      if (EXCLUDED_TOOLS.has(tool.name)) continue;

      const prefixedName = `${TOOL_PREFIX}${tool.name}`;
      const originalName = tool.name;

      pi.registerTool({
        name: prefixedName,
        label: prefixedName,
        description: tool.description ?? '',
        parameters: Type.Unsafe(tool.inputSchema as object),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          ctx: ExtensionContext,
        ) {
          try {
            await ensureConnected();
          } catch (connErr) {
            const msg = connErr instanceof Error ? connErr.message : String(connErr);
            ctx.ui.notify(`pi-computer-use: cannot connect to cua-driver — ${msg}`, 'warning');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to connect to cua-driver: ${msg}. ${permissionHint()}`,
                },
              ],
              details: undefined,
              isError: true,
            };
          }

          const result = await client!.callTool(originalName, params);

          if (result.isError) {
            const errorText = result.content?.map((c) => c.text ?? '').join('') ?? '';
            const friendlyError = formatToolError(originalName, errorText, params);
            if (friendlyError) {
              return {
                content: [{ type: 'text' as const, text: friendlyError }],
                details: undefined,
                isError: true,
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

  function registerVisionTool(): void {
    if (!config?.visionModel) return;
    const visionConfig = config.visionModel;

    pi.registerTool({
      name: `${TOOL_PREFIX}analyze_screenshot`,
      label: `${TOOL_PREFIX}analyze_screenshot`,
      description:
        'Capture a screenshot using ScreenCaptureKit and analyze it visually using a vision model. Returns analysis for a single window in the requested format (default png).\n\n`window_id` is required. Get window ids from `list_windows`.\n\nRequires the Screen Recording TCC grant — call `check_permissions` first if unsure.',
      parameters: Type.Object({
        window_id: Type.Number({
          description: 'Required CGWindowID / kCGWindowNumber to capture.',
        }),
        instruction: Type.Optional(
          Type.String({
            description:
              'What to identify or analyze visually (e.g., "Find the coordinates of the blue submit button").',
          }),
        ),
        format: Type.Optional(
          Type.Union([Type.Literal('png'), Type.Literal('jpeg')], {
            description: 'Image format. Default: png.',
          }),
        ),
        quality: Type.Optional(
          Type.Number({
            description: 'JPEG quality 1-95; ignored for png.',
            minimum: 1,
            maximum: 95,
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
        try {
          await ensureConnected();
        } catch (connErr) {
          const msg = connErr instanceof Error ? connErr.message : String(connErr);
          ctx.ui.notify(`pi-computer-use: cannot connect to cua-driver — ${msg}`, 'warning');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to connect to cua-driver: ${msg}. ${permissionHint()}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }

        const screenshotArgs: Record<string, unknown> = { window_id: params.window_id };
        if (params.format) screenshotArgs.format = params.format;
        if (params.quality) screenshotArgs.quality = params.quality;

        const screenshotResult = await client!.callTool('screenshot', screenshotArgs);
        const imageContent = screenshotResult.content?.find((c) => c.type === 'image' && c.data);

        if (!imageContent?.data) {
          const errorText =
            screenshotResult.content
              ?.filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text)
              .join('\n') || 'Failed to capture screenshot.';
          const formatted = formatToolError('screenshot', errorText, params);
          return {
            content: [{ type: 'text' as const, text: formatted ?? errorText }],
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

    let upstreamTools:
      | Array<{ name: string; description?: string | undefined; inputSchema: unknown }>
      | undefined;

    try {
      await client.connect();
      connected = true;
      upstreamTools = await client.listAllTools();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        `pi-computer-use: cua-driver failed to start — ${msg}. Tools registered but may fail until permissions are granted.`,
        'warning',
      );
    }

    registerTools(upstreamTools ?? FALLBACK_TOOLS);
    registerVisionTool();

    if (connected) {
      try {
        const permResult = await client!.callTool('check_permissions', {});
        const structured = (permResult as Record<string, unknown>).structuredContent as
          | { accessibility?: boolean; screen_recording?: boolean }
          | undefined;
        if (structured) {
          if (!structured.accessibility) {
            ctx.ui.notify(`pi-computer-use: ${accessibilityHint()}`, 'warning');
          }
          if (!structured.screen_recording) {
            ctx.ui.notify(`pi-computer-use: ${screenRecordingHint()}`, 'warning');
          }
        }
      } catch {
        // permission check is best-effort
      }
    }
  });

  pi.on('session_shutdown', async () => {
    if (connected && client) {
      await client.close();
      connected = false;
    }
  });
}

function formatToolError(
  toolName: string,
  errorText: string,
  params: Record<string, unknown>,
): string | undefined {
  if (errorText.includes('ax_not_granted')) {
    return accessibilityHint();
  }
  if (errorText.includes('sc_not_granted')) {
    return screenRecordingHint();
  }

  if (toolName === 'screenshot' || errorText.includes('screencapture failed')) {
    const windowId = params.window_id;
    if (windowId !== undefined) {
      if (errorText.includes('screencapture failed')) {
        return [
          `Screenshot failed for window ${windowId}. Possible causes:`,
          `1. ${screenRecordingHint()}`,
          '2. The window_id is stale — the window may have been closed or recreated (e.g. after navigation in Electron apps). Re-fetch window list to get current IDs.',
          '3. The window is minimized or not yet rendered.',
          `Try capturing without window_id (full screen) as a fallback, or verify the window still exists.`,
        ].join('\n');
      }
      if (errorText.includes('empty output')) {
        return `Screenshot captured an empty image for window ${windowId}. The window may be minimized, fully transparent, or off-screen. Try restoring the window first.`;
      }
    } else {
      if (errorText.includes('screencapture failed')) {
        return `Screenshot failed for the main display. ${screenRecordingHint()}`;
      }
    }
  }

  return undefined;
}
