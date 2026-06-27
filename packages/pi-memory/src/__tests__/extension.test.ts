import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import memoryExtension from '../extension.js';
import { MemoryStore } from '../store.js';

const { installMock, statusMock, uninstallMock } = vi.hoisted(() => ({
  installMock: vi.fn(),
  statusMock: vi.fn(),
  uninstallMock: vi.fn(),
}));

vi.mock('@amaster.ai/pi-shared/scheduler', () => ({
  install: installMock,
  status: statusMock,
  uninstall: uninstallMock,
}));

const TEST_ROOT = path.join(tmpdir(), 'pi-memory-extension-test');

describe('memoryExtension', () => {
  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    installMock.mockReset();
    statusMock.mockReset().mockResolvedValue('not-found');
    uninstallMock.mockReset();
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('registers the dream cron entry on session start', async () => {
    const dir = path.join(TEST_ROOT, `cron-${Date.now()}`);
    const store = new MemoryStore({ dir });
    await store.loadFromDisk();

    const eventHandlers: Record<
      string,
      Array<(event: unknown, ctx: unknown) => Promise<void>>
    > = {};
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        eventHandlers[event] ??= [];
        eventHandlers[event].push(handler);
      },
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    };
    const ctx = {
      cwd: dir,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) },
    };

    memoryExtension(pi as never, { store, dataDir: dir });
    for (const handler of eventHandlers.session_start ?? []) {
      await handler({}, ctx);
    }

    expect(installMock).toHaveBeenCalledWith({
      name: 'ai.pi.memory-dream',
      command: process.execPath,
      args: [expect.stringMatching(/cli\/dream\.js$/), '--once'],
      intervalSeconds: 4 * 3600,
      description: 'Pi memory consolidation and dedup',
    });
  });
});
