import { afterEach, describe, expect, it } from 'vitest';
import { DevToolsClient } from '../index.js';

const originalExecPath = process.execPath;
const originalPath = process.env.PATH;

describe('DevToolsClient real stdio transport', () => {
  afterEach(() => {
    process.execPath = originalExecPath;
    process.env.PATH = originalPath;
  });

  it('preserves a real spawn error code when the Node executable is missing', async () => {
    process.execPath = '/definitely-missing/pi-browser-use-node';
    const client = new DevToolsClient({ headless: true, sessionMode: 'isolated' });

    await expect(client.connect()).rejects.toThrow(
      'Browser connection failed. MCP subprocess failed (ENOENT).',
    );
  });

  it('initializes the real MCP subprocess and lists tools with ambient npx absent', async () => {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const client = new DevToolsClient({
      headless: true,
      sessionMode: 'isolated',
      ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    });

    try {
      const tools = await client.listAllTools();

      expect(tools.length).toBeGreaterThan(0);
      expect(tools.some((tool) => tool.name === 'navigate_page')).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});
