import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ComputerUseConfig } from './config.js';

const MCP_TIMEOUT_MS = 60_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class CuaDriverClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: ComputerUseConfig;

  constructor(config: ComputerUseConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const binaryPath = await this.resolveBinaryPath();
    const args = ['mcp', ...(this.config.extraArgs ?? [])];

    this.transport = new StdioClientTransport({
      command: binaryPath,
      args,
      stderr: 'pipe',
    });

    this.transport.onerror = (error: Error) => {
      console.error(`[pi-computer-use] cua-driver transport error: ${error.message}`);
    };

    this.client = new Client({ name: 'pi-computer-use', version: '0.1.0' }, { capabilities: {} });

    await this.client.connect(this.transport);
  }

  async listAllTools(): Promise<Tool[]> {
    if (!this.client) throw new Error('CuaDriverClient not connected');

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
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  }> {
    if (!this.client) throw new Error('CuaDriverClient not connected');

    return (await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: MCP_TIMEOUT_MS,
    })) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
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

  private async resolveBinaryPath(): Promise<string> {
    if (this.config.mode === 'path' && this.config.binaryPath) {
      return this.config.binaryPath;
    }

    const platform =
      process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`;
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binPath = path.resolve(__dirname, '..', 'bin', platform, `cua-driver${ext}`);

    if (!existsSync(binPath)) {
      throw new Error(
        `[pi-computer-use] cua-driver binary not found at ${binPath}. ` +
          `Platform "${platform}" may not be supported, or set mode: "path" with binaryPath in config.`,
      );
    }

    return binPath;
  }
}
