import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeRequestContext, ToolCallRequest } from '@amaster.ai/pi-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSecurityPolicyEngineForProfile,
  isCapabilityExposed,
  resolveCapabilityPolicy,
  type SecurityConfig,
} from '../index.js';
import { loadFilePolicies } from '../policy-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = resolve(__dirname, '..', '..', 'examples');

const request: RuntimeRequestContext = {
  sessionId: 'session-1',
  conversationId: 'conversation-1',
  trigger: 'user',
  senderTrust: 'owner',
  interactive: true,
  model: { provider: 'test', model: 'test-model' },
};

function tool(
  name: string,
  source: ToolCallRequest['source'],
  args: ToolCallRequest['args'],
): ToolCallRequest {
  return { id: `${name}-1`, name, source, args };
}

describe('examples/reviewer.json', () => {
  let cwd: string;
  let projectPolicyDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    const base = join(tmpdir(), `pi-readme-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(base, 'project');
    projectPolicyDir = join(cwd, '.pi', 'policy');
    mkdirSync(projectPolicyDir, { recursive: true });
    mkdirSync(join(base, 'home'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = join(base, 'home');

    copyFileSync(join(EXAMPLES_DIR, 'reviewer.json'), join(projectPolicyDir, 'reviewer.json'));
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    rmSync(join(cwd, '..'), { recursive: true, force: true });
  });

  it('exposes workspace-write capabilities (read + write + bash)', () => {
    const filePolicies = loadFilePolicies({ cwd, projectTrusted: true });
    const policy = resolveCapabilityPolicy('reviewer', {}, filePolicies);
    expect(isCapabilityExposed('read', policy)).toBe(true);
    expect(isCapabilityExposed('write', policy)).toBe(true);
    expect(isCapabilityExposed('edit', policy)).toBe(true);
    expect(isCapabilityExposed('bash', policy)).toBe(true);
  });

  it('asks for approval on bash via custom rule', () => {
    const filePolicies = loadFilePolicies({ cwd, projectTrusted: true });
    const engine = createSecurityPolicyEngineForProfile('reviewer', {}, filePolicies);
    const result = engine.evaluate({
      request,
      toolCall: tool('bash', 'builtin', { command: 'ls' }),
    });
    expect(result.decision).toMatchObject({ kind: 'ask', reason: 'Shell needs approval' });
    expect(result.matchedRuleIds).toContain('ask-bash');
  });

  it('denies bash commands that touch external network', () => {
    const filePolicies = loadFilePolicies({ cwd, projectTrusted: true });
    const engine = createSecurityPolicyEngineForProfile('reviewer', {}, filePolicies);
    const result = engine.evaluate({
      request,
      toolCall: tool('bash', 'builtin', { command: 'curl https://example.test' }),
    });
    expect(result.decision).toMatchObject({ kind: 'deny', reason: 'External network is blocked' });
    expect(result.matchedRuleIds).toContain('deny-network');
  });

  it('asks for approval on workspace writes (inherited from on-request approval)', () => {
    const filePolicies = loadFilePolicies({ cwd, projectTrusted: true });
    const engine = createSecurityPolicyEngineForProfile('reviewer', {}, filePolicies);
    const result = engine.evaluate({
      request,
      workspaceDir: cwd,
      toolCall: tool('write', 'builtin', { path: join(cwd, 'a.txt'), content: 'x' }),
    });
    expect(result.decision.kind).toBe('ask');
    expect(result.matchedRuleIds).toContain('ask-workspace-write');
  });

  it('still denies secret reads (baseline rule inherited from read-only)', () => {
    const filePolicies = loadFilePolicies({ cwd, projectTrusted: true });
    const engine = createSecurityPolicyEngineForProfile('reviewer', {}, filePolicies);
    const result = engine.evaluate({
      request,
      toolCall: tool('read', 'builtin', {
        path: `${process.env.HOME ?? '/Users/me'}/.ssh/id_rsa`,
      }),
    });
    expect(result.decision).toMatchObject({ kind: 'deny' });
    expect(result.matchedRuleIds).toContain('deny-secrets');
  });
});

describe('examples/auto-review.settings.json', () => {
  const settings = JSON.parse(
    readFileSync(join(EXAMPLES_DIR, 'auto-review.settings.json'), 'utf-8'),
  ) as { 'pi-security': { profile: string; security: SecurityConfig } };
  const profileName = settings['pi-security'].profile;
  const config = settings['pi-security'].security;

  it('asks for approval on matching package install commands', () => {
    const engine = createSecurityPolicyEngineForProfile(profileName, config);
    const result = engine.evaluate({
      request,
      toolCall: tool('bash', 'builtin', { command: 'pnpm install lodash' }),
    });
    expect(result.decision).toMatchObject({ kind: 'ask', reason: 'Approve package install?' });
    expect(result.matchedRuleIds).toContain('ask-package-install');
  });

  it('does not match unrelated bash commands via argsRegex', () => {
    const engine = createSecurityPolicyEngineForProfile(profileName, config);
    const result = engine.evaluate({
      request,
      toolCall: tool('bash', 'builtin', { command: 'ls -la' }),
    });
    expect(result.matchedRuleIds).not.toContain('ask-package-install');
  });
});
