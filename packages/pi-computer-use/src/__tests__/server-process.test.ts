import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockKill = vi.fn();
let processExitHandler: ((code: number | null) => void) | null = null;
let _processErrorHandler: ((err: Error) => void) | null = null;
let mockExitCode: number | null = null;

const mockSpawn = vi.fn((_cmd: string, _args: string[], _opts: object) => ({
  get exitCode() {
    return mockExitCode;
  },
  stderr: {
    on: vi.fn(),
  },
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') processExitHandler = handler as (code: number | null) => void;
    if (event === 'error') _processErrorHandler = handler as (err: Error) => void;
  }),
  kill: mockKill,
}));

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: object) => mockSpawn(cmd, args, opts),
}));

let wsProbeCallCount = 0;
let wsProbeSuccess: (index: number) => boolean = () => true;

vi.mock('ws', () => ({
  default: class MockWsProbe {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    off = vi.fn();
    on: (event: string, handler: (...args: unknown[]) => void) => void;

    constructor() {
      const idx = wsProbeCallCount++;
      const shouldSucceed = wsProbeSuccess(idx);
      this.on = (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'open' && shouldSucceed) {
          setTimeout(() => handler(), 0);
        }
        if (event === 'error' && !shouldSucceed) {
          setTimeout(() => handler(new Error('ECONNREFUSED')), 0);
        }
      };
    }
  },
}));

const { ComputerServerProcess } = await import('../server-process.js');

describe('ComputerServerProcess', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockKill.mockClear();
    processExitHandler = null;
    _processErrorHandler = null;
    mockExitCode = null;
    wsProbeCallCount = 0;
    wsProbeSuccess = () => true;
  });

  describe('start()', () => {
    test('spawns subprocess with default args', async () => {
      const server = new ComputerServerProcess();
      await server.start({});

      expect(mockSpawn).toHaveBeenCalledWith(
        'uvx',
        ['cua-computer-server', '--host', '127.0.0.1', '--port', '8000'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    });

    test('uses custom command, package, host, port', async () => {
      const server = new ComputerServerProcess();
      await server.start({
        command: 'pipx',
        package: 'my-server',
        host: '0.0.0.0',
        port: 9090,
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'pipx',
        ['my-server', '--host', '0.0.0.0', '--port', '9090'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    });

    test('appends extraArgs', async () => {
      const server = new ComputerServerProcess();
      await server.start({ extraArgs: ['--verbose', '--no-sandbox'] });

      expect(mockSpawn).toHaveBeenCalledWith(
        'uvx',
        [
          'cua-computer-server',
          '--host',
          '127.0.0.1',
          '--port',
          '8000',
          '--verbose',
          '--no-sandbox',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    });

    test('retries WS probe until success', async () => {
      wsProbeSuccess = (idx) => idx >= 2;

      const server = new ComputerServerProcess();
      await server.start({});

      expect(wsProbeCallCount).toBeGreaterThanOrEqual(3);
    });

    test('throws if process exits before ready', async () => {
      mockExitCode = 1;
      wsProbeSuccess = () => false;

      const server = new ComputerServerProcess();
      await expect(server.start({})).rejects.toThrow(
        'cua-computer-server exited with code 1 before becoming ready',
      );
    });
  });

  describe('stop()', () => {
    test('sends SIGTERM to subprocess', async () => {
      const server = new ComputerServerProcess();
      await server.start({});

      const stopPromise = server.stop();
      setTimeout(() => processExitHandler?.(0), 10);
      await stopPromise;

      expect(mockKill).toHaveBeenCalledWith('SIGTERM');
    });

    test('no-ops when no process is running', async () => {
      const server = new ComputerServerProcess();
      await server.stop();
      expect(mockKill).not.toHaveBeenCalled();
    });

    test('sends SIGKILL if process does not exit within grace period', async () => {
      const server = new ComputerServerProcess();
      await server.start({});

      const stopPromise = server.stop();
      // Don't call processExitHandler — simulate process not exiting
      await stopPromise;

      expect(mockKill).toHaveBeenCalledWith('SIGTERM');
      expect(mockKill).toHaveBeenCalledWith('SIGKILL');
    }, 10_000);
  });
});
