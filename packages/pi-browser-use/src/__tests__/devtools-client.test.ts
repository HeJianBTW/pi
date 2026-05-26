import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockClientConnect = vi.fn(() => Promise.resolve());
const mockClientClose = vi.fn(() => Promise.resolve());
let _listToolsCalls = 0;
const mockListTools = vi.fn((opts?: { cursor?: string }) => {
  _listToolsCalls++;
  if (!opts?.cursor) {
    return Promise.resolve({
      tools: [{ name: 'click', description: 'Click', inputSchema: {} }],
      nextCursor: 'page2',
    });
  }
  return Promise.resolve({
    tools: [{ name: 'fill', description: 'Fill', inputSchema: {} }],
    nextCursor: undefined,
  });
});
const mockCallTool = vi.fn((_req: { name: string; arguments: Record<string, unknown> }) =>
  Promise.resolve({ content: [{ type: 'text', text: 'done' }] }),
);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockClientConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClientClose;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    onerror: unknown;
    constructor(public opts: unknown) {}
  },
}));

const { DevToolsClient } = await import('../index.js');

describe('DevToolsClient', () => {
  beforeEach(() => {
    mockClientConnect.mockClear();
    mockClientClose.mockClear();
    mockListTools.mockClear();
    mockCallTool.mockClear();
    _listToolsCalls = 0;
  });

  describe('connect()', () => {
    test('creates transport and connects client', async () => {
      const client = new DevToolsClient();
      await client.connect();
      expect(mockClientConnect).toHaveBeenCalledTimes(1);
    });

    test('connects with default config args', async () => {
      const client = new DevToolsClient();
      await client.connect();
      expect(mockClientConnect).toHaveBeenCalled();
    });

    test('connects with custom config', async () => {
      const client = new DevToolsClient({ headless: true, channel: 'canary' });
      await client.connect();
      expect(mockClientConnect).toHaveBeenCalled();
    });
  });

  describe('listAllTools()', () => {
    test('paginates through all tool pages', async () => {
      const client = new DevToolsClient();
      await client.connect();

      const tools = await client.listAllTools();

      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe('click');
      expect(tools[1]!.name).toBe('fill');
      expect(mockListTools).toHaveBeenCalledTimes(2);
    });

    test('throws when not connected', async () => {
      const client = new DevToolsClient();
      await expect(client.listAllTools()).rejects.toThrow('Client not connected');
    });
  });

  describe('callTool()', () => {
    test('calls upstream tool with name and args', async () => {
      const client = new DevToolsClient();
      await client.connect();

      const result = await client.callTool('click', { uid: '1_2' });

      expect(mockCallTool).toHaveBeenCalledWith(
        { name: 'click', arguments: { uid: '1_2' } },
        undefined,
        { timeout: 60_000 },
      );
      expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    });

    test('throws when not connected', async () => {
      const client = new DevToolsClient();
      await expect(client.callTool('click', {})).rejects.toThrow('Client not connected');
    });
  });

  describe('close()', () => {
    test('closes the client', async () => {
      const client = new DevToolsClient();
      await client.connect();
      await client.close();
      expect(mockClientClose).toHaveBeenCalledTimes(1);
    });

    test('no-ops when already closed', async () => {
      const client = new DevToolsClient();
      await client.close();
      expect(mockClientClose).not.toHaveBeenCalled();
    });

    test('subsequent callTool throws after close', async () => {
      const client = new DevToolsClient();
      await client.connect();
      await client.close();
      await expect(client.callTool('click', {})).rejects.toThrow('Client not connected');
    });
  });
});
