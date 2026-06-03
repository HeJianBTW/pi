import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonRuntimeStorage } from './runtime-storage-json.js';

const tmpDirs: string[] = [];

describe('createJsonRuntimeStorage', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('creates local JSON stores by default', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-storage-'));
    tmpDirs.push(dir);

    const storage = createJsonRuntimeStorage(dir, {
      runtimeEvents: 10,
      toolEvents: 10,
      llmGenerationEvents: 10,
    });

    await expect(storage.store.listRuntimeSessions({ tenantId: 'tenant-1' })).resolves.toEqual([]);
    await expect(storage.transcripts.listTurns({ tenantId: 'tenant-1' })).resolves.toEqual([]);
    await expect(storage.timelineEvents.list({ tenantId: 'tenant-1' })).resolves.toEqual([]);
    const artifact = await storage.artifacts.create({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      artifactType: 'text',
      storageUri: 'file:///tmp/output.txt',
      name: 'output.txt',
    });
    await expect(storage.artifacts.get({ tenantId: 'tenant-1' }, artifact.id)).resolves.toEqual(
      artifact,
    );
    await expect(
      storage.artifacts.list({ tenantId: 'tenant-1', sessionId: 'session-1' }),
    ).resolves.toEqual([artifact]);
  });
});
