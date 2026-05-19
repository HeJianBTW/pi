import { loadPiSettings, type PiSettingsOptions } from '@amaster.ai/pi-shared/settings';
import { type TextContent as AiTextContent, complete } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import {
  handleAnalyzeScreenshot,
  VISUAL_SYSTEM_PROMPT,
  type VisionCaller,
} from './analyze-screenshot.js';
import {
  type BrowserUseConfig,
  configToArgs,
  resolveConfig,
  type VisionModelConfig,
} from './config.js';
import {
  augmentToolDescription,
  extractTextContent,
  postProcessToolResult,
} from './tool-augment.js';

export type { BrowserUseConfig, VisionModelConfig };
export { configToArgs, resolveConfig };

// All upstream tools are re-exported with this prefix to avoid name collisions with other extensions.
const TOOL_PREFIX = 'browser_';

// These upstream tools are noisy or slow; skip them during registration.
const EXCLUDED_TOOLS = new Set([
  'lighthouse_audit',
  'performance_analyze_insight',
  'performance_start_trace',
  'performance_stop_trace',
  'screencast_start',
  'screencast_stop',
  'install_extension',
  'list_extensions',
  'reload_extension',
  'trigger_extension_action',
  'uninstall_extension',
]);

const MCP_TIMEOUT_MS = 60_000;

/**
 * MCP client that spawns chrome-devtools-mcp as a subprocess and communicates
 * over stdio.  Owns the child-process lifecycle: connect() starts it, close() kills it.
 */
export class DevToolsClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: BrowserUseConfig;

  constructor(config?: BrowserUseConfig) {
    this.config = resolveConfig(config);
  }

  async connect(): Promise<void> {
    const args = configToArgs(this.config);

    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', ...args],
      stderr: 'pipe',
    });

    this.client = new Client({ name: 'pi-browser-use', version: '0.1.0' }, { capabilities: {} });

    this.transport.onerror = (error: Error) => {
      console.error(`[pi-browser-use] chrome-devtools-mcp transport error: ${error.message}`);
    };

    await this.client.connect(this.transport);
  }

  async listAllTools(): Promise<Tool[]> {
    if (!this.client) throw new Error('Client not connected');

    const allTools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined, {
        timeout: MCP_TIMEOUT_MS,
      });
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content?: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  }> {
    if (!this.client) throw new Error('Client not connected');

    return (await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: MCP_TIMEOUT_MS,
    })) as {
      content?: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      isError?: boolean;
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.transport = null;
  }
}

/** Read the pi-browser-use section from .pi/settings.json. */
function loadConfigFromFile(options?: PiSettingsOptions): BrowserUseConfig {
  return loadPiSettings<BrowserUseConfig>('pi-browser-use', {
    agentDir: getAgentDir(),
    ...options,
  });
}

/** Convert upstream MCP result into pi-agent TextContent[], applying post-processing. */
function toTextContent(
  result: {
    content?: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  },
  originalName: string,
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const textContent = extractTextContent(result.content);
  const processed = postProcessToolResult(originalName, textContent);

  const content: Array<{ type: 'text'; text: string }> = [];

  if (processed !== textContent) {
    content.push({ type: 'text', text: processed });
  } else if (result.content) {
    for (const item of result.content) {
      if (item.type === 'text' && item.text) {
        content.push({ type: 'text', text: item.text });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return result.isError ? { content, isError: true } : { content };
}

/**
 * pi-coding-agent extension entry point.
 *
 * On session_start: spawns chrome-devtools-mcp, discovers upstream tools,
 * and registers each one via pi.registerTool() with a "browser_" prefix.
 * On session_shutdown: tears down the subprocess.
 *
 * Config is loaded from config.json["pi-browser-use"] in the working directory.
 * If visionModel is configured, an additional analyze_screenshot tool is registered.
 */
export default function browserUseExtension(pi: ExtensionAPI): void {
  let config: BrowserUseConfig | undefined;
  let client: DevToolsClient | undefined;
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (!client) throw new Error('browser-use: session not started');
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
      const description = augmentToolDescription(originalName, tool.description ?? '');

      pi.registerTool({
        name: prefixedName,
        label: prefixedName,
        description,
        parameters: Type.Unsafe(tool.inputSchema),
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          _ctx: ExtensionContext,
        ) {
          await ensureConnected();
          const result = await client!.callTool(originalName, params);
          const { content } = toTextContent(result, originalName);
          return { content, details: undefined };
        },
      });
    }
  }

  /** Create a VisionCaller that uses pi-ai's complete() with the model registry. */
  function createPiVisionCaller(
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

  async function registerVisionTool(visionConfig: VisionModelConfig): Promise<void> {
    pi.registerTool({
      name: `${TOOL_PREFIX}analyze_screenshot`,
      label: `${TOOL_PREFIX}analyze_screenshot`,
      description:
        'Analyze the current page visually using a screenshot. Use when you need to identify elements by visual attributes (color, layout, position) not available in the accessibility tree, or when you need precise pixel coordinates for click_at.',
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
        const callVision = createPiVisionCaller(visionConfig, ctx);
        const result = await handleAnalyzeScreenshot(client!, callVision, params);
        const content: Array<{ type: 'text'; text: string }> = [];
        if (result.content) {
          for (const item of result.content) {
            if (item.type === 'text' && item.text) {
              content.push({ type: 'text', text: item.text });
            }
          }
        }
        if (content.length === 0) {
          content.push({ type: 'text', text: '' });
        }
        return { content, details: undefined };
      },
    });
  }

  pi.on('session_start', async (_event, ctx) => {
    config = resolveConfig(loadConfigFromFile({ cwd: ctx.cwd }));
    client = new DevToolsClient(config);
    connected = false;
    await registerUpstreamTools();
    if (config.visionModel) {
      await registerVisionTool(config.visionModel);
    }
  });

  pi.on('session_shutdown', async () => {
    if (connected && client) {
      await client.close();
      connected = false;
    }
  });
}
