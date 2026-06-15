import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { initLarkCli } from '../cli.js';

describe('initLarkCli', () => {
  let configDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    configDir = join(
      tmpdir(),
      `lark-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    originalEnv = { ...process.env };
    process.env.LARKSUITE_CLI_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(configDir, { recursive: true, force: true });
  });

  test('writes config.json with correct content', async () => {
    await initLarkCli({ appId: 'cli_abc', appSecret: 'secret123', domain: 'feishu' });

    const configFile = join(configDir, 'config.json');
    expect(existsSync(configFile)).toBe(true);

    const content = JSON.parse(readFileSync(configFile, 'utf-8'));
    expect(content.apps).toHaveLength(1);
    expect(content.apps[0].appId).toBe('cli_abc');
    expect(content.apps[0].appSecret).toBe('secret123');
    expect(content.apps[0].brand).toBe('feishu');
  });

  test('uses lark brand when domain is lark', async () => {
    await initLarkCli({ appId: 'cli_abc', appSecret: 'secret123', domain: 'lark' });

    const configFile = join(configDir, 'config.json');
    const content = JSON.parse(readFileSync(configFile, 'utf-8'));
    expect(content.apps[0].brand).toBe('lark');
  });

  test('defaults to feishu brand when domain is unset', async () => {
    await initLarkCli({ appId: 'cli_abc', appSecret: 'secret123' });

    const configFile = join(configDir, 'config.json');
    const content = JSON.parse(readFileSync(configFile, 'utf-8'));
    expect(content.apps[0].brand).toBe('feishu');
  });

  test('rejects when appId is missing', async () => {
    await expect(initLarkCli({ appSecret: 'secret123' })).rejects.toThrow(
      'appId and appSecret are required',
    );
  });

  test('rejects when appSecret is missing', async () => {
    await expect(initLarkCli({ appId: 'cli_abc' })).rejects.toThrow(
      'appId and appSecret are required',
    );
  });

  test('creates config directory if it does not exist', async () => {
    const nested = join(configDir, 'sub', 'dir');
    process.env.LARKSUITE_CLI_CONFIG_DIR = nested;

    await initLarkCli({ appId: 'cli_abc', appSecret: 'secret123' });

    expect(existsSync(join(nested, 'config.json'))).toBe(true);
  });
});
