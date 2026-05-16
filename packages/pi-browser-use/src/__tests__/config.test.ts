import { describe, expect, test } from 'vitest';
import { configToArgs, resolveConfig } from '../config.js';

describe('resolveConfig', () => {
  test('returns defaults when called with no args', () => {
    const config = resolveConfig();
    expect(config.categoryPerformance).toBe(false);
    expect(config.categoryNetwork).toBe(true);
    expect(config.categoryEmulation).toBe(true);
    expect(config.categoryExtensions).toBe(false);
    expect(config.experimentalVision).toBe(true);
    expect(config.experimentalScreencast).toBe(false);
    expect(config.experimentalMemory).toBe(false);
    expect(config.usageStatistics).toBe(false);
    expect(config.performanceCrux).toBe(false);
  });

  test('returns defaults when called with empty object', () => {
    const config = resolveConfig({});
    expect(config.categoryPerformance).toBe(false);
    expect(config.experimentalVision).toBe(true);
  });

  test('merges user config over defaults', () => {
    const config = resolveConfig({ headless: true, channel: 'canary' });
    expect(config.headless).toBe(true);
    expect(config.channel).toBe('canary');
    expect(config.categoryPerformance).toBe(false);
  });

  test('user values override defaults', () => {
    const config = resolveConfig({
      categoryPerformance: true,
      experimentalVision: false,
    });
    expect(config.categoryPerformance).toBe(true);
    expect(config.experimentalVision).toBe(false);
  });
});

describe('configToArgs', () => {
  test('empty config produces default flags', () => {
    const args = configToArgs({});
    expect(args).toContain('--category-performance=false');
    expect(args).toContain('--experimental-vision');
    expect(args).toContain('--no-usage-statistics');
    expect(args).toContain('--no-performance-crux');
  });

  test('boolean flags', () => {
    const args = configToArgs({ headless: true, isolated: true, autoConnect: true });
    expect(args).toContain('--headless');
    expect(args).toContain('--isolated');
    expect(args).toContain('--auto-connect');
  });

  test('value flags', () => {
    const args = configToArgs({
      channel: 'canary',
      viewport: '1280x720',
      browserUrl: 'http://localhost:9222',
      wsEndpoint: 'ws://localhost:9222',
      wsHeaders: '{"Authorization":"Bearer x"}',
      executablePath: '/usr/bin/chrome',
      userDataDir: '/tmp/chrome',
    });
    expect(args).toContain('--channel=canary');
    expect(args).toContain('--viewport=1280x720');
    expect(args).toContain('--browser-url=http://localhost:9222');
    expect(args).toContain('--ws-endpoint=ws://localhost:9222');
    expect(args).toContain('--ws-headers={"Authorization":"Bearer x"}');
    expect(args).toContain('--executable-path=/usr/bin/chrome');
    expect(args).toContain('--user-data-dir=/tmp/chrome');
  });

  test('slim flag', () => {
    const args = configToArgs({ slim: true });
    expect(args).toContain('--slim');
  });

  test('category toggles', () => {
    const args = configToArgs({
      categoryPerformance: true,
      categoryNetwork: false,
      categoryEmulation: false,
      categoryExtensions: true,
    });
    expect(args).not.toContain('--category-performance=false');
    expect(args).toContain('--category-network=false');
    expect(args).toContain('--category-emulation=false');
    expect(args).toContain('--category-extensions=true');
  });

  test('experimental flags', () => {
    const args = configToArgs({
      experimentalVision: true,
      experimentalScreencast: true,
      experimentalMemory: true,
    });
    expect(args).toContain('--experimental-vision');
    expect(args).toContain('--experimental-screencast');
    expect(args).toContain('--experimental-memory');
  });

  test('extraArgs passthrough', () => {
    const args = configToArgs({ extraArgs: ['--custom-flag', '--another=value'] });
    expect(args).toContain('--custom-flag');
    expect(args).toContain('--another=value');
  });

  test('headless false does not add flag', () => {
    const args = configToArgs({ headless: false });
    expect(args).not.toContain('--headless');
  });
});
