import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ScheduledTask } from '@amaster.ai/pi-task-scheduler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonScheduledTaskStore } from './scheduler-json.js';

vi.mock('@amaster.ai/pi-task-scheduler', () => ({
  normalizeScheduledTask: (task: ScheduledTask): ScheduledTask => ({
    ...task,
    enabled: typeof task.enabled === 'boolean' ? task.enabled : true,
    runCount: Number.isFinite(task.runCount) ? task.runCount : 0,
    runHistory: Array.isArray(task.runHistory) ? task.runHistory : [],
  }),
}));

const TEST_DIR = path.join(tmpdir(), 'pi-storage-scheduler-json-test');
const filePath = path.join(TEST_DIR, 'tasks.json');

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: 'test-session',
    prompt: 'test prompt',
    type: 'interval',
    schedule: '10m',
    intervalSeconds: 600,
    enabled: true,
    model: { provider: 'test', model: 'test-model' },
    toolPolicyProfile: 'default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe('storage JsonScheduledTaskStore', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(filePath)) rmSync(filePath);
    if (existsSync(`${filePath}.bak`)) rmSync(`${filePath}.bak`);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('serializes concurrent creates without losing tasks', async () => {
    const store = new JsonScheduledTaskStore(filePath);
    const tasks = Array.from({ length: 20 }, (_, index) => makeTask({ id: `task-${index}` }));

    await Promise.all(tasks.map((task) => store.create(task)));

    const reloaded = await new JsonScheduledTaskStore(filePath).list();
    expect(reloaded.map((task) => task.id).sort()).toEqual(tasks.map((task) => task.id).sort());
  });
});
