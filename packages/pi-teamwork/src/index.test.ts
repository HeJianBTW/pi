import { describe, expect, it, vi } from 'vitest';
import { initMulticaProvider, MulticaAdapter } from './adapters/multica.js';
import { ensureMulticaBinary } from './adapters/multica-installer.js';
import type { ExecFn } from './types.js';

function _mockExec(
  responses: Record<string, { stdout: string; stderr: string; code: number }>,
): ExecFn {
  return async (_cmd, args) => {
    const key = args.join(' ');
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}

function successExec(stdout = ''): ExecFn {
  return async () => ({ stdout, stderr: '', code: 0 });
}

function failExec(stderr = 'error', code = 1): ExecFn {
  return async () => ({ stdout: '', stderr, code });
}

describe('MulticaAdapter', () => {
  describe('listIssues', () => {
    it('returns parsed issues from JSON output', async () => {
      const issues = [
        { id: 'ISS-1', title: 'Bug fix', status: 'todo', priority: 'high' },
        { id: 'ISS-2', title: 'Feature', status: 'in_progress' },
      ];
      const adapter = new MulticaAdapter({}, successExec(JSON.stringify(issues)));
      const result = await adapter.listIssues();
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'ISS-1',
        title: 'Bug fix',
        status: 'todo',
        priority: 'high',
      });
      expect(result[1]).toMatchObject({ id: 'ISS-2', title: 'Feature', status: 'in_progress' });
    });

    it('passes filter flags to CLI', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        return { stdout: '[]', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({}, exec);
      await adapter.listIssues({ status: 'todo', assignee: 'alice', project: 'P1', limit: 5 });
      expect(calls[0]).toContain('--status');
      expect(calls[0]).toContain('todo');
      expect(calls[0]).toContain('--assignee');
      expect(calls[0]).toContain('alice');
      expect(calls[0]).toContain('--project');
      expect(calls[0]).toContain('P1');
      expect(calls[0]).toContain('--limit');
      expect(calls[0]).toContain('5');
    });

    it('returns empty array on non-array JSON', async () => {
      const adapter = new MulticaAdapter({}, successExec('{"not": "array"}'));
      expect(await adapter.listIssues()).toEqual([]);
    });

    it('returns empty array on invalid JSON', async () => {
      const adapter = new MulticaAdapter({}, successExec('not json'));
      expect(await adapter.listIssues()).toEqual([]);
    });

    it('throws on non-zero exit code', async () => {
      const adapter = new MulticaAdapter({}, failExec('command failed'));
      await expect(adapter.listIssues()).rejects.toThrow('multica issue failed: command failed');
    });
  });

  describe('getIssue', () => {
    it('returns a single issue', async () => {
      const issue = { id: 'ISS-1', title: 'Test', status: 'done', created_at: '2025-01-01' };
      const adapter = new MulticaAdapter({}, successExec(JSON.stringify(issue)));
      const result = await adapter.getIssue('ISS-1');
      expect(result).toMatchObject({
        id: 'ISS-1',
        title: 'Test',
        status: 'done',
        createdAt: '2025-01-01',
      });
    });

    it('returns undefined on null response', async () => {
      const adapter = new MulticaAdapter({}, successExec('null'));
      expect(await adapter.getIssue('ISS-X')).toBeUndefined();
    });
  });

  describe('createIssue', () => {
    it('passes title and optional fields', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({ id: 'ISS-NEW', title: 'New', status: 'todo' }),
          stderr: '',
          code: 0,
        };
      };
      const adapter = new MulticaAdapter({}, exec);
      const result = await adapter.createIssue({ title: 'New', priority: 'high', assignee: 'bob' });
      expect(result).toMatchObject({ id: 'ISS-NEW', title: 'New' });
      expect(calls[0]).toContain('--title');
      expect(calls[0]).toContain('New');
      expect(calls[0]).toContain('--priority');
      expect(calls[0]).toContain('high');
      expect(calls[0]).toContain('--assignee');
      expect(calls[0]).toContain('bob');
    });

    it('returns fallback issue on invalid JSON response', async () => {
      const adapter = new MulticaAdapter({}, successExec('ok'));
      const result = await adapter.createIssue({ title: 'Fallback' });
      expect(result).toMatchObject({ id: 'unknown', title: 'Fallback', status: 'todo' });
    });
  });

  describe('updateIssue', () => {
    it('calls status command separately from update', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        if (args.includes('get')) {
          return {
            stdout: JSON.stringify({ id: 'ISS-1', title: 'Updated', status: 'done' }),
            stderr: '',
            code: 0,
          };
        }
        return { stdout: '', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({}, exec);
      await adapter.updateIssue('ISS-1', { status: 'done', title: 'Updated' });
      expect(calls[0]).toContain('status');
      expect(calls[0]).toContain('done');
      expect(calls[1]).toContain('update');
      expect(calls[1]).toContain('--title');
      expect(calls[1]).toContain('Updated');
    });
  });

  describe('addComment', () => {
    it('sends comment content and returns parsed result', async () => {
      const exec: ExecFn = async () => ({
        stdout: JSON.stringify({ id: 'C-1', author: 'alice', created_at: '2025-01-01' }),
        stderr: '',
        code: 0,
      });
      const adapter = new MulticaAdapter({}, exec);
      const result = await adapter.addComment('ISS-1', 'hello');
      expect(result).toMatchObject({
        id: 'C-1',
        issueId: 'ISS-1',
        content: 'hello',
        author: 'alice',
      });
    });

    it('includes parentId when provided', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        return { stdout: '{}', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({}, exec);
      await adapter.addComment('ISS-1', 'reply', 'C-0');
      expect(calls[0]).toContain('--parent');
      expect(calls[0]).toContain('C-0');
    });
  });

  describe('listProjects', () => {
    it('maps project fields correctly', async () => {
      const projects = [{ id: 'P1', name: 'Alpha', description: 'desc', lead: 'bob' }];
      const adapter = new MulticaAdapter({}, successExec(JSON.stringify(projects)));
      const result = await adapter.listProjects();
      expect(result[0]).toMatchObject({
        id: 'P1',
        title: 'Alpha',
        description: 'desc',
        lead: 'bob',
      });
    });
  });

  describe('status', () => {
    it('returns parsed daemon status', async () => {
      const adapter = new MulticaAdapter(
        {},
        successExec(JSON.stringify({ running: true, agents: 3 })),
      );
      const result = await adapter.status();
      expect(result).toEqual({ running: true, agents: 3 });
    });

    it('wraps non-object output in raw field', async () => {
      const adapter = new MulticaAdapter({}, successExec('just text'));
      const result = await adapter.status();
      expect(result).toEqual({ raw: 'just text' });
    });
  });

  describe('workspace args', () => {
    it('adds --workspace-id when configured', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args);
        return { stdout: '[]', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({ workspace: 'ws-123' }, exec);
      await adapter.listIssues();
      expect(calls[0]).toContain('--workspace-id');
      expect(calls[0]).toContain('ws-123');
    });
  });

  describe('custom binary', () => {
    it('uses configured binary name', async () => {
      const cmds: string[] = [];
      const exec: ExecFn = async (cmd) => {
        cmds.push(cmd);
        return { stdout: '[]', stderr: '', code: 0 };
      };
      const adapter = new MulticaAdapter({ binary: '/usr/local/bin/multica-dev' }, exec);
      await adapter.listIssues();
      expect(cmds[0]).toBe('/usr/local/bin/multica-dev');
    });
  });
});

describe('initMulticaProvider', () => {
  it('calls login when token is provided', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ token: 'my-token' }, exec);
    expect(calls[0]).toEqual(['--version']);
    expect(calls[1]).toEqual(['login', '--token', 'my-token']);
    expect(calls[2]).toEqual(['daemon', 'start']);
  });

  it('skips login when no token', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({}, exec);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['--version']);
    expect(calls[1]).toEqual(['daemon', 'start']);
  });

  it('continues even if login fails', async () => {
    let daemonStarted = false;
    const exec: ExecFn = async (_cmd, args) => {
      if (args.includes('login')) throw new Error('login failed');
      if (args.includes('start')) daemonStarted = true;
      return { stdout: '', stderr: '', code: 0 };
    };
    const { adapter } = await initMulticaProvider({ token: 'bad-token' }, exec);
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(daemonStarted).toBe(true);
  });

  it('continues even if daemon start fails', async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args.includes('start')) throw new Error('already running');
      return { stdout: '', stderr: '', code: 0 };
    };
    const { adapter } = await initMulticaProvider({}, exec);
    expect(adapter).toBeInstanceOf(MulticaAdapter);
  });

  it('returns a MulticaAdapter instance', async () => {
    const { adapter } = await initMulticaProvider({}, successExec());
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(adapter.name).toBe('multica');
  });

  it('skips install when autoInstall is false', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ autoInstall: false }, exec);
    expect(calls[0]).toEqual(['daemon', 'start']);
  });

  it('runs setup self-host when serverUrl is configured', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ serverUrl: 'https://api.example.com' }, exec);
    expect(calls).toContainEqual(['setup', 'self-host', '--server-url', 'https://api.example.com']);
  });

  it('runs setup self-host before login when both serverUrl and token are configured', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ serverUrl: 'https://api.example.com', token: 'my-token' }, exec);
    const setupIdx = calls.findIndex((a) => a[0] === 'setup');
    const loginIdx = calls.findIndex((a) => a[0] === 'login');
    expect(setupIdx).toBeGreaterThan(-1);
    expect(loginIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeLessThan(loginIdx);
  });

  it('continues even if setup self-host fails', async () => {
    let daemonStarted = false;
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === 'setup') throw new Error('setup failed');
      if (args.includes('start')) daemonStarted = true;
      return { stdout: '', stderr: '', code: 0 };
    };
    const { adapter } = await initMulticaProvider(
      { serverUrl: 'https://api.example.com', token: 'tk' },
      exec,
    );
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(daemonStarted).toBe(true);
  });

  it('returns adapter even when install fails', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: 'fail', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const { adapter, installResult } = await initMulticaProvider({}, exec);
    expect(adapter).toBeInstanceOf(MulticaAdapter);
    expect(installResult.installed).toBe(false);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('does not run setup or login when install fails', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const calls: { cmd: string; args: string[] }[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: 'fail', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ serverUrl: 'https://api.example.com', token: 'tk' }, exec);
    expect(calls.some((c) => c.args[0] === 'setup')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'login')).toBe(false);
    expect(calls.some((c) => c.args.includes('start'))).toBe(false);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('uses custom binary path for version check and all commands', async () => {
    const cmds: string[] = [];
    const exec: ExecFn = async (cmd, _args) => {
      cmds.push(cmd);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({ binary: '/opt/multica', token: 'tk', autoInstall: false }, exec);
    expect(cmds.every((c) => c === '/opt/multica')).toBe(true);
  });
});

describe('ensureMulticaBinary', () => {
  it('returns alreadyPresent when binary exists', async () => {
    const exec: ExecFn = async () => ({ stdout: 'multica 1.0.0', stderr: '', code: 0 });
    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: true });
  });

  it('attempts brew install on macOS/Linux when brew is available', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'which' && args[0] === 'brew')
        return { stdout: '/opt/homebrew/bin/brew', stderr: '', code: 0 };
      if (cmd === 'brew') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'brew' && c.args.includes('multica-ai/tap/multica'))).toBe(
      true,
    );

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('falls back to curl when brew is not available', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'which' && args[0] === 'brew') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'bash' && c.args[0] === '-c')).toBe(true);
    expect(calls.some((c) => c.cmd === 'brew')).toBe(false);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('falls back to curl when brew install fails', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'which' && args[0] === 'brew')
        return { stdout: '/opt/homebrew/bin/brew', stderr: '', code: 0 };
      if (cmd === 'brew') return { stdout: '', stderr: 'brew error', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'bash' && c.args[0] === '-c')).toBe(true);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('uses powershell on Windows', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'powershell') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'powershell' && c.args[0] === '-Command')).toBe(true);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when install fails and binary still not found', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which' && args[0] === 'brew') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') return { stdout: '', stderr: 'network error', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.alreadyPresent).toBe(false);
    expect(result.error).toBeDefined();

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when binary not on PATH after successful install', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which' && args[0] === 'brew')
        return { stdout: '/usr/bin/brew', stderr: '', code: 0 };
      if (cmd === 'brew') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('multica binary not found on PATH after installation');

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('handles exec throwing an exception', async () => {
    let callCount = 0;
    const exec: ExecFn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('command not found');
      throw new Error('still not found');
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.alreadyPresent).toBe(false);
  });

  it('uses custom binary name for version check', async () => {
    const cmds: string[] = [];
    const exec: ExecFn = async (cmd) => {
      cmds.push(cmd);
      return { stdout: 'multica 2.0', stderr: '', code: 0 };
    };
    await ensureMulticaBinary('/custom/path/multica', exec);
    expect(cmds[0]).toBe('/custom/path/multica');
  });

  it('does not attempt install when binary already exists', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
    };
    await ensureMulticaBinary('multica', exec);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['--version']);
  });

  it('handles brew exec throwing exception and falls back to curl', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'darwin' });

    const calls: { cmd: string; args: string[] }[] = [];
    let versionCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        versionCallCount++;
        if (versionCallCount === 1) return { stdout: '', stderr: '', code: 127 };
        return { stdout: 'multica 1.0.0', stderr: '', code: 0 };
      }
      if (cmd === 'which' && args[0] === 'brew')
        return { stdout: '/opt/homebrew/bin/brew', stderr: '', code: 0 };
      if (cmd === 'brew') throw new Error('brew crashed');
      if (cmd === 'bash') return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result).toEqual({ installed: true, alreadyPresent: false });
    expect(calls.some((c) => c.cmd === 'bash' && c.args[0] === '-c')).toBe(true);

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when curl fallback exec throws', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'which' && args[0] === 'brew') return { stdout: '', stderr: '', code: 1 };
      if (cmd === 'bash') throw new Error('network timeout');
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('network timeout');

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when Windows powershell install fails', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'powershell') return { stdout: '', stderr: 'access denied', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('access denied');

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('returns error when Windows powershell exec throws', async () => {
    const originalPlatform = process.platform;
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const exec: ExecFn = async (cmd, args) => {
      if (args[0] === '--version') return { stdout: '', stderr: '', code: 127 };
      if (cmd === 'powershell') throw new Error('powershell not found');
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await ensureMulticaBinary('multica', exec);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('powershell not found');

    vi.stubGlobal('process', { ...process, platform: originalPlatform });
    vi.unstubAllGlobals();
  });
});
