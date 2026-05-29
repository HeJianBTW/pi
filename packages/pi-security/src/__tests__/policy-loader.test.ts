import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCapabilityExposed, resolveCapabilityPolicy } from '../index.js';
import { loadFilePolicies, loadPolicyDir } from '../policy-loader.js';

describe('loadPolicyDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `pi-policy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads valid JSON files as profiles', () => {
    writeFileSync(
      join(dir, 'reviewer.json'),
      JSON.stringify({
        extends: 'read-only',
        sandbox: 'workspace-write',
      }),
    );
    writeFileSync(join(dir, 'minimal.json'), JSON.stringify({ extends: 'full-access' }));

    const result = loadPolicyDir(dir);
    expect(result).toEqual({
      reviewer: { extends: 'read-only', sandbox: 'workspace-write' },
      minimal: { extends: 'full-access' },
    });
  });

  it('returns empty map for non-existent directory', () => {
    expect(loadPolicyDir('/non/existent/path')).toEqual({});
  });

  it('skips malformed JSON files', () => {
    writeFileSync(join(dir, 'bad.json'), '{ invalid json !!!');
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ extends: 'read-only' }));

    const result = loadPolicyDir(dir);
    expect(result).toEqual({ good: { extends: 'read-only' } });
  });

  it('skips non-JSON files', () => {
    writeFileSync(join(dir, 'notes.txt'), 'not a policy');
    writeFileSync(join(dir, 'valid.json'), JSON.stringify({ extends: 'full-access' }));

    const result = loadPolicyDir(dir);
    expect(Object.keys(result)).toEqual(['valid']);
  });

  it('skips non-object JSON values', () => {
    writeFileSync(join(dir, 'array.json'), JSON.stringify([1, 2, 3]));
    writeFileSync(join(dir, 'string.json'), JSON.stringify('hello'));
    writeFileSync(join(dir, 'null.json'), 'null');
    writeFileSync(join(dir, 'object.json'), JSON.stringify({ extends: 'default' }));

    const result = loadPolicyDir(dir);
    expect(Object.keys(result)).toEqual(['object']);
  });

  it('returns empty map for empty directory', () => {
    expect(loadPolicyDir(dir)).toEqual({});
  });

  it('uses filename without extension as profile name', () => {
    writeFileSync(join(dir, 'my-custom-profile.json'), JSON.stringify({ extends: 'read-only' }));

    const result = loadPolicyDir(dir);
    expect(result['my-custom-profile']).toEqual({ extends: 'read-only' });
    expect(result['my-custom-profile.json']).toBeUndefined();
  });

  it('loads files with full SecurityProfileConfig shape', () => {
    writeFileSync(
      join(dir, 'full.json'),
      JSON.stringify({
        extends: 'read-only',
        sandbox: 'workspace-write',
        approval: 'untrusted',
        rules: [
          {
            id: 'custom-rule',
            priority: 300,
            tools: ['*'],
            decision: { kind: 'ask', reason: 'test' },
          },
        ],
        defaultDecision: { kind: 'deny', reason: 'locked' },
      }),
    );

    const result = loadPolicyDir(dir);
    expect(result.full).toMatchObject({
      extends: 'read-only',
      sandbox: 'workspace-write',
      approval: 'untrusted',
      rules: [{ id: 'custom-rule' }],
      defaultDecision: { kind: 'deny', reason: 'locked' },
    });
  });
});

describe('loadFilePolicies', () => {
  let projectDir: string;
  let userDir: string;
  let cwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    const base = join(
      tmpdir(),
      `pi-policy-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    cwd = join(base, 'project');
    userDir = join(base, 'home', '.pi', 'agent', 'policy');
    projectDir = join(cwd, '.pi', 'policy');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = join(base, 'home');
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(join(cwd, '..', 'home'), { recursive: true, force: true });
  });

  it('project-level policies override user-level policies', () => {
    writeFileSync(
      join(userDir, 'custom.json'),
      JSON.stringify({ extends: 'read-only', sandbox: 'read-only' }),
    );
    writeFileSync(
      join(projectDir, 'custom.json'),
      JSON.stringify({ extends: 'full-access', sandbox: 'full-access' }),
    );

    const result = loadFilePolicies(cwd);
    expect(result.custom).toEqual({ extends: 'full-access', sandbox: 'full-access' });
  });

  it('merges profiles from both directories', () => {
    writeFileSync(join(userDir, 'user-only.json'), JSON.stringify({ extends: 'read-only' }));
    writeFileSync(
      join(projectDir, 'project-only.json'),
      JSON.stringify({ extends: 'full-access' }),
    );

    const result = loadFilePolicies(cwd);
    expect(result['user-only']).toEqual({ extends: 'read-only' });
    expect(result['project-only']).toEqual({ extends: 'full-access' });
  });

  it('works when only user-level directory exists', () => {
    rmSync(projectDir, { recursive: true });
    writeFileSync(join(userDir, 'only-user.json'), JSON.stringify({ extends: 'read-only' }));

    const result = loadFilePolicies(cwd);
    expect(result['only-user']).toEqual({ extends: 'read-only' });
  });

  it('works when only project-level directory exists', () => {
    rmSync(userDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'only-project.json'),
      JSON.stringify({ extends: 'full-access' }),
    );

    const result = loadFilePolicies(cwd);
    expect(result['only-project']).toEqual({ extends: 'full-access' });
  });

  it('returns empty when neither directory exists', () => {
    rmSync(userDir, { recursive: true });
    rmSync(projectDir, { recursive: true });

    const result = loadFilePolicies(cwd);
    expect(result).toEqual({});
  });
});

describe('loadFilePolicies 3-layer with agentDir', () => {
  let base: string;
  let agentDir: string;
  let agentPolicyDir: string;
  let cwd: string;
  let projectPolicyDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    base = join(tmpdir(), `pi-policy-3layer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    agentDir = join(base, 'agent-config');
    agentPolicyDir = join(agentDir, 'policy');
    cwd = join(base, 'project');
    projectPolicyDir = join(cwd, '.pi', 'policy');
    mkdirSync(join(base, 'home', '.pi', 'agent', 'policy'), { recursive: true });
    mkdirSync(agentPolicyDir, { recursive: true });
    mkdirSync(projectPolicyDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = join(base, 'home');
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('agentDir policy is loaded via loadFilePolicies', () => {
    writeFileSync(
      join(agentPolicyDir, 'agent-profile.json'),
      JSON.stringify({
        sandbox: 'workspace-write',
        approval: 'on-request',
      }),
    );

    const result = loadFilePolicies(cwd, agentDir);
    expect(result['agent-profile']).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
  });

  it('project policy overrides agentDir policy', () => {
    writeFileSync(join(agentPolicyDir, 'custom.json'), JSON.stringify({ extends: 'read-only' }));
    writeFileSync(
      join(projectPolicyDir, 'custom.json'),
      JSON.stringify({ extends: 'full-access' }),
    );

    const result = loadFilePolicies(cwd, agentDir);
    expect(result.custom).toEqual({ extends: 'full-access' });
  });

  it('agentDir profile resolves to expected capabilities', () => {
    writeFileSync(
      join(agentPolicyDir, 'agent-profile.json'),
      JSON.stringify({
        extends: 'read-only',
        sandbox: 'workspace-write',
      }),
    );

    const filePolicies = loadFilePolicies(cwd, agentDir);
    const policy = resolveCapabilityPolicy('agent-profile', {}, filePolicies);
    expect(isCapabilityExposed('read', policy)).toBe(true);
    expect(isCapabilityExposed('write', policy)).toBe(true);
    expect(isCapabilityExposed('bash', policy)).toBe(false);
  });
});
