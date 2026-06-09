import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        { name: 'click', description: 'Click', inputSchema: { type: 'object' } },
        { name: 'take_snapshot', description: 'Snapshot', inputSchema: { type: 'object' } },
      ],
      nextCursor: undefined,
    }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@earendil-works/pi-ai', () => ({
  complete: vi.fn().mockResolvedValue({ text: 'mock' }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});

interface MockExtensionAPI {
  on: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
}

function createMockExtensionAPI(): MockExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
  };
}

const EXTENSIONS_DIR = join(__dirname, '..', 'packages');

const EXTENSION_PACKAGES = [
  'pi-security',
  'pi-telemetry',
  'pi-browser-use',
  'pi-computer-use',
] as const;

describe('Extension loading contract', () => {
  for (const pkgName of EXTENSION_PACKAGES) {
    describe(pkgName, () => {
      const pkgDir = join(EXTENSIONS_DIR, pkgName);
      const pkgJsonPath = join(pkgDir, 'package.json');

      it('declares "pi" field with extensions in package.json', () => {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        expect(pkgJson.pi).toBeDefined();
        expect(pkgJson.pi.extensions).toBeInstanceOf(Array);
        expect(pkgJson.pi.extensions.length).toBeGreaterThan(0);
      });

      it('exports a default function (extension factory)', async () => {
        const mod = await import(join(pkgDir, 'src', 'index.ts'));
        expect(typeof mod.default).toBe('function');
      });

      it('calls factory without throwing', async () => {
        const mod = await import(join(pkgDir, 'src', 'index.ts'));
        const pi = createMockExtensionAPI();
        // biome-ignore lint/suspicious/noExplicitAny: mock API
        expect(() => mod.default(pi as any)).not.toThrow();
      });
    });
  }

  describe('pi-security registrations', () => {
    it('registers tool_call + user_bash handlers and 3 commands', async () => {
      const mod = await import(join(EXTENSIONS_DIR, 'pi-security', 'src', 'index.ts'));
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      mod.default(pi as any);

      const onCalls = pi.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('session_shutdown');
      expect(onCalls).toContain('tool_call');
      expect(onCalls).toContain('user_bash');

      const cmdNames = pi.registerCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(cmdNames).toContain('pi-security-status');
      expect(cmdNames).toContain('pi-security-audit');
      expect(cmdNames).toContain('pi-security-reset');
    });
  });

  describe('pi-telemetry registrations', () => {
    it('registers all lifecycle event handlers', async () => {
      const mod = await import(join(EXTENSIONS_DIR, 'pi-telemetry', 'src', 'index.ts'));
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      mod.default(pi as any);

      const onCalls = pi.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('input');
      expect(onCalls).toContain('turn_start');
      expect(onCalls).toContain('turn_end');
      expect(onCalls).toContain('tool_execution_start');
      expect(onCalls).toContain('tool_execution_end');
      expect(onCalls).toContain('before_provider_request');
      expect(onCalls).toContain('after_provider_response');
      expect(onCalls).toContain('message_end');
      expect(onCalls).toContain('model_select');
      expect(onCalls).toContain('session_compact');
      expect(onCalls).toContain('session_shutdown');
    });
  });

  describe('pi-browser-use registrations', () => {
    it('registers session_start and session_shutdown handlers', async () => {
      const mod = await import(join(EXTENSIONS_DIR, 'pi-browser-use', 'src', 'index.ts'));
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      mod.default(pi as any);

      const onCalls = pi.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('session_shutdown');
    });

    it('registers browser_ prefixed tools after session_start', { timeout: 15000 }, async () => {
      const mod = await import(join(EXTENSIONS_DIR, 'pi-browser-use', 'src', 'index.ts'));
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      mod.default(pi as any);

      const sessionStartHandler = pi.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'session_start',
      )?.[1] as (...args: unknown[]) => Promise<void>;
      expect(sessionStartHandler).toBeDefined();

      await sessionStartHandler({ type: 'session_start', reason: 'startup' }, { cwd: process.cwd() });

      expect(pi.registerTool).toHaveBeenCalled();
      const toolNames = pi.registerTool.mock.calls.map((c: unknown[]) => c[0].name);
      expect(toolNames).toContain('browser_click');
      expect(toolNames).toContain('browser_take_snapshot');
    });
  });

  describe('pi-computer-use registrations', () => {
    it('registers session_start and session_shutdown handlers', async () => {
      const mod = await import(join(EXTENSIONS_DIR, 'pi-computer-use', 'src', 'index.ts'));
      const pi = createMockExtensionAPI();
      // biome-ignore lint/suspicious/noExplicitAny: mock API
      mod.default(pi as any);

      const onCalls = pi.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(onCalls).toContain('session_start');
      expect(onCalls).toContain('session_shutdown');
    });
  });
});
