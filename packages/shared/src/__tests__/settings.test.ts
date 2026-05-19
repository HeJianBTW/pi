import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('loadPiSettings env var resolution', () => {
  let tempDir: string;
  let settingsPath: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-settings-test-${Date.now()}`);
    mkdirSync(join(tempDir, '.pi'), { recursive: true });
    settingsPath = join(tempDir, '.pi', 'settings.json');
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadSettings<T>(key: string): Promise<T> {
    const mod = await import('../../src/settings.js');
    return mod.loadPiSettings<T>(key);
  }

  it('resolves ${VAR} to env value', async () => {
    process.env.TEST_MODEL = 'claude-opus';
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { name: '${TEST_MODEL}' },
    }));
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('claude-opus');
  });

  it('resolves ${VAR:-default} to default when env is unset', async () => {
    delete process.env.UNSET_VAR;
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { name: '${UNSET_VAR:-fallback-model}' },
    }));
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('fallback-model');
  });

  it('resolves ${VAR:-default} to env value when set', async () => {
    process.env.SET_VAR = 'actual-value';
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { name: '${SET_VAR:-fallback}' },
    }));
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('actual-value');
  });

  it('resolves ${VAR:-} to empty string when env is unset', async () => {
    delete process.env.EMPTY_VAR;
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { name: '${EMPTY_VAR:-}' },
    }));
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('');
  });

  it('resolves ${VAR:-} to empty string when env is empty', async () => {
    process.env.EMPTY_VAR = '';
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { name: '${EMPTY_VAR:-}' },
    }));
    const result = await loadSettings<{ name: string }>('myExt');
    expect(result.name).toBe('');
  });

  it('resolves env vars in nested objects', async () => {
    process.env.NESTED_VAL = 'deep';
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { outer: { inner: '${NESTED_VAL}' } },
    }));
    const result = await loadSettings<{ outer: { inner: string } }>('myExt');
    expect(result.outer.inner).toBe('deep');
  });

  it('resolves env vars in arrays', async () => {
    process.env.ARR_VAL = 'item1';
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { items: ['${ARR_VAL}', 'literal'] },
    }));
    const result = await loadSettings<{ items: string[] }>('myExt');
    expect(result.items).toEqual(['item1', 'literal']);
  });

  it('resolves multiple env vars in one string', async () => {
    process.env.HOST = 'localhost';
    process.env.PORT = '8080';
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { url: 'http://${HOST}:${PORT}/api' },
    }));
    const result = await loadSettings<{ url: string }>('myExt');
    expect(result.url).toBe('http://localhost:8080/api');
  });

  it('leaves non-string values untouched', async () => {
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { count: 42, enabled: true, empty: null },
    }));
    const result = await loadSettings<{ count: number; enabled: boolean; empty: null }>('myExt');
    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
    expect(result.empty).toBeNull();
  });

  it('handles default value containing :-', async () => {
    delete process.env.TRICKY_VAR;
    writeFileSync(settingsPath, JSON.stringify({
      myExt: { val: '${TRICKY_VAR:-a:-b}' },
    }));
    const result = await loadSettings<{ val: string }>('myExt');
    expect(result.val).toBe('a:-b');
  });
});
