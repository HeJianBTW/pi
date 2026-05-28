import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractMentions, skillSearchPaths, stripMentions } from './extension.js';

describe('extractMentions', () => {
  it('extracts unquoted @path file references', () => {
    const { mentions } = extractMentions('check @src/main.ts please');
    expect(mentions).toEqual([{ kind: 'file', ref: 'src/main.ts' }]);
  });

  it('extracts quoted @"path" file references', () => {
    const { mentions } = extractMentions('review @"/path with spaces/file.ts"');
    expect(mentions).toEqual([{ kind: 'file', ref: '/path with spaces/file.ts' }]);
  });

  it('extracts multiple file references and dedupes', () => {
    const { mentions } = extractMentions('@src/a.ts @src/b.ts @src/a.ts');
    expect(mentions).toEqual([
      { kind: 'file', ref: 'src/a.ts' },
      { kind: 'file', ref: 'src/b.ts' },
    ]);
  });

  it('ignores http URLs', () => {
    const { mentions } = extractMentions('see @https://example.com');
    expect(mentions).toEqual([]);
  });

  it('keeps line range syntax in the file reference', () => {
    const { mentions } = extractMentions('look at @src/main.ts#L10-20');
    expect(mentions).toEqual([{ kind: 'file', ref: 'src/main.ts#L10-20' }]);
  });

  it('extracts @skill:name as a skill mention', () => {
    const { mentions } = extractMentions('use @skill:react-page to draft a page');
    expect(mentions).toEqual([{ kind: 'skill', name: 'react-page' }]);
  });

  it('does not double-count a skill mention as a file mention', () => {
    const { mentions } = extractMentions('@skill:react-page');
    expect(mentions).toEqual([{ kind: 'skill', name: 'react-page' }]);
  });

  it('mixes skill and file mentions in order', () => {
    const { mentions } = extractMentions('load @skill:react-page and review @src/main.ts');
    expect(mentions).toEqual([
      { kind: 'skill', name: 'react-page' },
      { kind: 'file', ref: 'src/main.ts' },
    ]);
  });

  it('dedupes repeated skill mentions', () => {
    const { mentions } = extractMentions('@skill:react-page and @skill:react-page again');
    expect(mentions).toEqual([{ kind: 'skill', name: 'react-page' }]);
  });

  it('treats unknown namespaces as no-op (not as file mentions either)', () => {
    const { mentions } = extractMentions('@app:erp-prod hello');
    expect(mentions).toEqual([]);
  });

  it('handles @ at start of text', () => {
    const { mentions } = extractMentions('@file.ts');
    expect(mentions).toEqual([{ kind: 'file', ref: 'file.ts' }]);
  });

  it('groups skill mentions before file mentions regardless of textual order', () => {
    // Implementation detail: skills are matched first, then files. This means
    // the mentions array does NOT preserve the textual order — it groups by kind.
    // Downstream consumers must not rely on textual order.
    const { mentions } = extractMentions('review @src/main.ts then @skill:foo');
    expect(mentions).toEqual([
      { kind: 'skill', name: 'foo' },
      { kind: 'file', ref: 'src/main.ts' },
    ]);
  });

  it('matches @SKILL: case-insensitively', () => {
    const { mentions } = extractMentions('use @SKILL:foo here');
    expect(mentions).toEqual([{ kind: 'skill', name: 'foo' }]);
  });
});

describe('stripMentions', () => {
  it('removes file mentions', () => {
    expect(stripMentions('check @src/main.ts please')).toBe('check  please');
  });

  it('removes quoted mentions', () => {
    expect(stripMentions('review @"/tmp/file.ts" now')).toBe('review  now');
  });

  it('removes skill mentions', () => {
    expect(stripMentions('use @skill:react-page now')).toBe('use  now');
  });

  it('removes mixed mentions and trims', () => {
    expect(stripMentions('@skill:foo @a.ts @b.ts explain')).toBe('explain');
  });

  it('leaves text without mentions intact', () => {
    expect(stripMentions('plain message')).toBe('plain message');
  });
});

describe('skillSearchPaths', () => {
  it('returns project path before user (agent dir) path', () => {
    const cwd = '/tmp/fake-project';
    const paths = skillSearchPaths('react-page', cwd);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(resolve(cwd, '.pi/skills/react-page/SKILL.md'));
    expect(paths[1]!.endsWith(join('skills', 'react-page', 'SKILL.md'))).toBe(true);
  });

  it('honors PI_AGENT_HOME for user-level path', () => {
    const original = process.env.PI_AGENT_HOME;
    process.env.PI_AGENT_HOME = '/tmp/custom-agent';
    try {
      const paths = skillSearchPaths('foo', '/tmp/cwd');
      expect(paths[1]).toBe('/tmp/custom-agent/skills/foo/SKILL.md');
    } finally {
      if (original === undefined) delete process.env.PI_AGENT_HOME;
      else process.env.PI_AGENT_HOME = original;
    }
  });
});

describe('skill loading via extension input handler', () => {
  let tmpRoot: string;
  let cwd: string;
  let agentDir: string;
  let originalAgentHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'pi-attachments-test-'));
    cwd = join(tmpRoot, 'project');
    agentDir = join(tmpRoot, 'agent');
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    originalAgentHome = process.env.PI_AGENT_HOME;
    process.env.PI_AGENT_HOME = agentDir;
  });

  afterEach(async () => {
    if (originalAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = originalAgentHome;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function loadExtension(): Promise<{
    runInput: (text: string) => Promise<{ action: string; text?: string } | undefined>;
  }> {
    const ext = (await import('./extension.js')).default;
    let handler:
      | ((event: { text: string; images?: unknown[] }, ctx: { cwd: string }) => Promise<unknown>)
      | undefined;
    const fakeApi = {
      on: (event: string, fn: typeof handler) => {
        if (event === 'input') handler = fn;
      },
    };
    ext(fakeApi as never);
    if (!handler) throw new Error('input handler was not registered');
    return {
      runInput: async (text: string) => {
        const result = await handler!({ text }, { cwd });
        return result as { action: string; text?: string } | undefined;
      },
    };
  }

  it('loads SKILL.md from the user agent dir', async () => {
    const skillDir = join(agentDir, 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo\n---\nUse demo skill instructions.\n',
      'utf8',
    );

    const { runInput } = await loadExtension();
    const result = await runInput('@skill:demo do the thing');

    expect(result?.action).toBe('transform');
    const text = result?.text ?? '';
    expect(text).toContain('<skill name="demo"');
    expect(text).toContain('Use demo skill instructions.');
    expect(text).not.toContain('---\nname: demo');
    expect(text).toContain('do the thing');
    expect(text).not.toContain('@skill:demo');
  });

  it('prefers project-level SKILL.md over user-level', async () => {
    const userSkill = join(agentDir, 'skills', 'demo');
    const projectSkill = join(cwd, '.pi', 'skills', 'demo');
    await mkdir(userSkill, { recursive: true });
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(userSkill, 'SKILL.md'), 'USER VERSION', 'utf8');
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT VERSION', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('@skill:demo');

    expect(result?.text).toContain('PROJECT VERSION');
    expect(result?.text).not.toContain('USER VERSION');
  });

  it('returns undefined when neither file mentions nor skill mentions resolve', async () => {
    const { runInput } = await loadExtension();
    const result = await runInput('@skill:does-not-exist hi');
    // No skill block, no attachments, no images → handler returns undefined to leave input untouched
    expect(result).toBeUndefined();
  });

  it('renders directory listings for @dir mentions', async () => {
    const dir = join(cwd, 'mydir');
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await writeFile(join(dir, 'b.json'), '{}', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('look at @mydir');

    expect(result?.action).toBe('transform');
    const text = result?.text ?? '';
    expect(text).toContain('(directory)');
    expect(text).toContain('sub/');
    expect(text).toContain('a.txt');
    expect(text).toContain('b.json');
    expect(text).toContain('look at');
    expect(text).not.toContain('@mydir');
  });

  it('skips ignored directory entries (.git, node_modules)', async () => {
    const dir = join(cwd, 'proj');
    await mkdir(join(dir, '.git'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'README.md'), '# hi', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('@proj');
    const text = result?.text ?? '';

    expect(text).toContain('README.md');
    expect(text).not.toContain('.git/');
    expect(text).not.toContain('node_modules/');
  });

  it('emits skill block before clean text before attachment reminder', async () => {
    const skillDir = join(agentDir, 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'SKILL BODY', 'utf8');
    await writeFile(join(cwd, 'note.txt'), 'note contents', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('@skill:demo please summarise @note.txt');
    const text = result?.text ?? '';

    const skillIdx = text.indexOf('<skill name="demo"');
    const cleanIdx = text.indexOf('please summarise');
    const reminderIdx = text.indexOf('<system-reminder>');

    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(cleanIdx).toBeGreaterThanOrEqual(0);
    expect(reminderIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeLessThan(cleanIdx);
    expect(cleanIdx).toBeLessThan(reminderIdx);
  });

  it('renders SKILL.md with no frontmatter unchanged', async () => {
    const skillDir = join(agentDir, 'skills', 'plain');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# Plain Title\n\nbody line\n', 'utf8');

    const { runInput } = await loadExtension();
    const result = await runInput('@skill:plain');
    const text = result?.text ?? '';

    expect(text).toContain('# Plain Title');
    expect(text).toContain('body line');
  });

  it('preserves pre-existing event.images when only a skill is mentioned', async () => {
    const skillDir = join(agentDir, 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'BODY', 'utf8');

    // Re-implement loadExtension inline so we can pass images through.
    const ext = (await import('./extension.js')).default;
    let handler:
      | ((event: { text: string; images?: unknown[] }, ctx: { cwd: string }) => Promise<unknown>)
      | undefined;
    ext({
      on: (e: string, fn: typeof handler) => {
        if (e === 'input') handler = fn;
      },
    } as never);
    if (!handler) throw new Error('input handler not registered');

    const inputImage = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
    const result = (await handler(
      { text: '@skill:demo look at this', images: [inputImage] },
      { cwd },
    )) as { action: string; text?: string; images?: unknown[] } | undefined;

    expect(result?.action).toBe('transform');
    expect(result?.images).toEqual([inputImage]);
  });
});
