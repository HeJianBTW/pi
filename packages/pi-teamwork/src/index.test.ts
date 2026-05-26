import { describe, expect, it } from 'vitest';
import { initMulticaProvider, MulticaAdapter } from './adapters/multica.js';
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
    expect(calls[0]).toEqual(['login', '--token', 'my-token']);
    expect(calls[1]).toEqual(['daemon', 'start']);
  });

  it('skips login when no token', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    };
    await initMulticaProvider({}, exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['daemon', 'start']);
  });

  it('continues even if login fails', async () => {
    let daemonStarted = false;
    const exec: ExecFn = async (_cmd, args) => {
      if (args.includes('login')) throw new Error('login failed');
      if (args.includes('start')) daemonStarted = true;
      return { stdout: '', stderr: '', code: 0 };
    };
    const provider = await initMulticaProvider({ token: 'bad-token' }, exec);
    expect(provider).toBeInstanceOf(MulticaAdapter);
    expect(daemonStarted).toBe(true);
  });

  it('continues even if daemon start fails', async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args.includes('start')) throw new Error('already running');
      return { stdout: '', stderr: '', code: 0 };
    };
    const provider = await initMulticaProvider({}, exec);
    expect(provider).toBeInstanceOf(MulticaAdapter);
  });

  it('returns a MulticaAdapter instance', async () => {
    const provider = await initMulticaProvider({}, successExec());
    expect(provider).toBeInstanceOf(MulticaAdapter);
    expect(provider.name).toBe('multica');
  });
});
