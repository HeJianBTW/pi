import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  Prisma: {},
  PrismaClient: class {
    piAgentScheduledTask = {
      findMany: mocks.findMany,
    };
  },
}));

vi.mock('@amaster.ai/pi-task-scheduler', () => ({
  normalizeScheduledTask: (task: unknown) => task,
}));

const { DbScheduledTaskStore } = await import('../scheduler-db.js');

describe('DbScheduledTaskStore', () => {
  beforeEach(() => {
    mocks.findMany.mockReset().mockResolvedValue([]);
  });

  it('includes the owning session in list predicates', async () => {
    const store = new DbScheduledTaskStore('file:test.db');

    await store.list({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a' });

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
      },
      orderBy: { updatedAt: 'desc' },
    });
  });
});
