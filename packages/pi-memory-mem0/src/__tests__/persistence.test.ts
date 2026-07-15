import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('MemoryVectorStore persistence', () => {
  const packageDir = fileURLToPath(new URL('../..', import.meta.url));
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `pi-memory-mem0-persistence-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    dbPath = join(tempDir, 'mem0-vectors.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads vectors from the same SQLite file after process restart', () => {
    const env = { ...process.env, MEM0_TEST_DB_PATH: dbPath };
    const writer = `
      import { MemoryVectorStore } from 'mem0ai/oss';
      const store = new MemoryVectorStore({ dimension: 3, dbPath: process.env.MEM0_TEST_DB_PATH });
      await store.insert(
        [[1, 0, 0]],
        ['persisted-id'],
        [{ user_id: 'test-user', memory: 'persisted-value' }],
      );
    `;
    const reader = `
      import { MemoryVectorStore } from 'mem0ai/oss';
      const store = new MemoryVectorStore({ dimension: 3, dbPath: process.env.MEM0_TEST_DB_PATH });
      const row = await store.get('persisted-id');
      process.stdout.write(JSON.stringify(row));
    `;

    execFileSync(process.execPath, ['--input-type=module', '--eval', writer], {
      cwd: packageDir,
      env,
      stdio: 'pipe',
      timeout: 30_000,
    });

    expect(existsSync(dbPath)).toBe(true);

    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', reader], {
      cwd: packageDir,
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });
    const row = JSON.parse(output) as {
      id: string;
      payload: { user_id: string; memory: string };
    };

    expect(row).toMatchObject({
      id: 'persisted-id',
      payload: { user_id: 'test-user', memory: 'persisted-value' },
    });
  }, 60_000);
});
