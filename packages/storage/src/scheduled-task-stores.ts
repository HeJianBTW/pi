import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  normalizeScheduledTask,
  type ScheduledTask,
  type ScheduledTaskModelConfig,
  type ScheduledTaskRunHistoryEntry,
  type ScheduledTaskStore,
  type SchedulerLock,
  type TaskSchedulerScope,
} from '@amaster.ai/pi-task-scheduler';
import { Prisma, PrismaClient } from '@prisma/client';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { RedisLockManager } from './redis-locks.js';

export class JsonScheduledTaskStore implements ScheduledTaskStore {
  private loaded = false;
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(private readonly filePath: string) {}

  async list(_scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    await this.load();
    return [...this.tasks.values()];
  }

  async get(taskId: string, _scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
    await this.load();
    return this.tasks.get(taskId);
  }

  async create(task: ScheduledTask): Promise<ScheduledTask> {
    await this.load();
    const normalized = normalizeScheduledTask(task);
    this.tasks.set(normalized.id, normalized);
    await this.save();
    return normalized;
  }

  async update(
    taskId: string,
    task: ScheduledTask,
    _scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    await this.load();
    if (!this.tasks.has(taskId)) {
      return undefined;
    }
    const normalized = normalizeScheduledTask(task);
    this.tasks.set(taskId, normalized);
    await this.save();
    return normalized;
  }

  async delete(taskId: string, _scope: TaskSchedulerScope = {}): Promise<boolean> {
    await this.load();
    if (!this.tasks.has(taskId)) {
      return false;
    }
    const deleted = this.tasks.delete(taskId);
    await this.save();
    return deleted;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const tasks = await readJsonFile<ScheduledTask[]>(this.filePath, []);
    this.tasks.clear();
    for (const rawTask of tasks) {
      const task = normalizeScheduledTask(rawTask);
      this.tasks.set(task.id, task);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.filePath, [...this.tasks.values()]);
  }
}

export class FileSchedulerLock implements SchedulerLock {
  private acquired = false;

  constructor(readonly path: string) {}

  acquire(): boolean {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const holder = this.holderPid();
    if (holder && holder !== process.pid) {
      return false;
    }
    try {
      unlinkSync(this.path);
    } catch {
      // Lock did not exist or was already removed between checks.
    }
    try {
      writeFileSync(this.path, String(process.pid), { flag: 'wx' });
      this.acquired = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.acquired = false;
        return false;
      }
      throw error;
    }
  }

  release(): void {
    if (!this.acquired) {
      return;
    }
    try {
      const pid = Number(readFileSync(this.path, 'utf8').trim());
      if (pid === process.pid) {
        unlinkSync(this.path);
      }
    } catch {
      // Lock was already gone; the scheduler is stopping anyway.
    }
    this.acquired = false;
  }

  isAcquired(): boolean {
    return this.acquired;
  }

  holderPid(): number | undefined {
    try {
      const pid = Number(readFileSync(this.path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        return pid;
      }
      unlinkSync(this.path);
      return undefined;
    } catch {
      return undefined;
    }
  }
}

export class RedisSchedulerLock implements SchedulerLock {
  readonly path: string;
  private acquired = false;
  private readonly locks: RedisLockManager;

  constructor(
    redisUrl: string,
    private readonly key = 'pi:scheduler:leader',
    private readonly ttlMs = 30_000,
  ) {
    this.path = `redis:${key}`;
    this.locks = new RedisLockManager(redisUrl);
  }

  async acquire(): Promise<boolean> {
    this.acquired = await this.locks.acquire(this.key, this.ttlMs);
    return this.acquired;
  }

  async extend(): Promise<boolean> {
    this.acquired = await this.locks.extend(this.key, this.ttlMs);
    return this.acquired;
  }

  async release(): Promise<void> {
    this.acquired = false;
    await this.locks.release(this.key);
  }

  isAcquired(): boolean {
    return this.acquired;
  }

  holderPid(): number | undefined {
    return this.acquired ? process.pid : undefined;
  }
}

export class DbScheduledTaskStore implements ScheduledTaskStore {
  private readonly prisma: PrismaClient;

  constructor(databaseUrl: string) {
    this.prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl },
      },
    });
  }

  async list(scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    const rows = await this.prisma.piAgentScheduledTask.findMany({
      where: scheduledTaskWhere(scope),
      orderBy: { updatedAt: 'desc' },
    });
    return await Promise.all(rows.map((row) => this.taskFromPrisma(row)));
  }

  async get(taskId: string, scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
    const row = await this.prisma.piAgentScheduledTask.findFirst({
      where: scheduledTaskWhere(scope, { id: taskId }),
    });
    return row ? await this.taskFromPrisma(row) : undefined;
  }

  async create(task: ScheduledTask): Promise<ScheduledTask> {
    const normalized = normalizeScheduledTask(task);
    await this.prisma.piAgentScheduledTask.create({
      data: scheduledTaskPrismaData(normalized),
    });
    await this.syncTaskRuns(normalized);
    return (await this.get(normalized.id)) ?? normalized;
  }

  async update(
    taskId: string,
    task: ScheduledTask,
    scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    const normalized = normalizeScheduledTask(task);
    const result = await this.prisma.piAgentScheduledTask.updateMany({
      where: scheduledTaskWhere(scope, { id: taskId }),
      data: scheduledTaskPrismaData(normalized),
    });
    if (result.count === 0) {
      return undefined;
    }
    await this.syncTaskRuns(normalized);
    return await this.get(taskId, scope);
  }

  async delete(taskId: string, scope: TaskSchedulerScope = {}): Promise<boolean> {
    const result = await this.prisma.piAgentScheduledTask.updateMany({
      where: scheduledTaskWhere(scope, { id: taskId }),
      data: { deletedAt: new Date(), updatedAt: new Date() },
    });
    return result.count > 0;
  }

  private async taskFromPrisma(row: PrismaRecord): Promise<ScheduledTask> {
    return normalizeScheduledTask({
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      sessionId: row.sessionId,
      ...(row.name ? { name: row.name } : {}),
      prompt: row.prompt,
      type: row.taskType,
      schedule: row.schedule ?? '',
      intervalSeconds: row.intervalSeconds ?? 0,
      enabled: Boolean(row.enabled),
      model: parseModel(row.modelJson),
      toolPolicyProfile: row.toolPolicyProfile ?? 'scheduled',
      ...(row.workspaceDir ? { workspaceDir: row.workspaceDir } : {}),
      ...(row.description ? { description: row.description } : {}),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      ...(row.lastRunAt ? { lastRunAt: toIso(row.lastRunAt) } : {}),
      ...(row.nextRunAt ? { nextRunAt: toIso(row.nextRunAt) } : {}),
      runCount: Number(row.runCount ?? 0),
      ...(row.lastStatus ? { lastStatus: row.lastStatus } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
      runHistory: await this.listRunHistory(row.id),
    });
  }

  private async listRunHistory(taskId: string): Promise<ScheduledTaskRunHistoryEntry[]> {
    const rows = await this.prisma.piAgentTaskRun.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    return rows.map(taskRunHistoryFromPrisma).reverse();
  }

  private async syncTaskRuns(task: ScheduledTask): Promise<void> {
    for (const entry of task.runHistory ?? []) {
      const status = entry.status;
      await this.prisma.piAgentTaskRun.upsert({
        where: { id: entry.id },
        create: taskRunPrismaCreate(task, entry, status),
        update: taskRunPrismaUpdate(task, entry, status),
      });
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Prisma record shape is dynamic
type PrismaRecord = Record<string, any>;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scheduledTaskWhere(
  scope: TaskSchedulerScope,
  extra: Prisma.PiAgentScheduledTaskWhereInput = {},
): Prisma.PiAgentScheduledTaskWhereInput {
  return {
    deletedAt: null,
    ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    ...(scope.userId ? { userId: scope.userId } : {}),
    ...extra,
  };
}

function scheduledTaskPrismaData(
  task: ScheduledTask,
): Prisma.PiAgentScheduledTaskUncheckedCreateInput {
  return {
    id: task.id,
    tenantId: task.tenantId ?? 'default',
    userId: task.userId ?? 'system',
    workspaceId: task.workspaceId ?? null,
    sessionId: task.sessionId,
    name: task.name ?? null,
    description: task.description ?? null,
    prompt: task.prompt,
    taskType: task.type,
    schedule: task.schedule,
    intervalSeconds: task.intervalSeconds,
    enabled: task.enabled,
    modelJson: jsonInput(task.model),
    toolPolicyProfile: task.toolPolicyProfile,
    workspaceDir: task.workspaceDir ?? null,
    lastRunAt: task.lastRunAt ? toDate(task.lastRunAt) : null,
    nextRunAt: task.nextRunAt ? toDate(task.nextRunAt) : null,
    runCount: BigInt(task.runCount),
    lastStatus: task.lastStatus ?? null,
    lastError: task.lastError ?? null,
    createdAt: toDate(task.createdAt),
    updatedAt: toDate(task.updatedAt),
    deletedAt: null,
  };
}

function taskRunPrismaCreate(
  task: ScheduledTask,
  entry: ScheduledTaskRunHistoryEntry,
  status: ScheduledTaskRunHistoryEntry['status'],
): Prisma.PiAgentTaskRunUncheckedCreateInput {
  return {
    id: entry.id,
    tenantId: task.tenantId ?? 'default',
    userId: task.userId ?? 'system',
    workspaceId: task.workspaceId ?? null,
    taskId: task.id,
    sessionId: entry.sessionId ?? task.sessionId,
    status,
    message: entry.message ?? null,
    errorJson: errorJson(task, entry),
    startedAt: status === 'running' ? toDate(entry.createdAt) : null,
    endedAt:
      status === 'success' || status === 'error' ? toDate(task.lastRunAt ?? task.updatedAt) : null,
    createdAt: toDate(entry.createdAt),
  };
}

function taskRunPrismaUpdate(
  task: ScheduledTask,
  entry: ScheduledTaskRunHistoryEntry,
  status: ScheduledTaskRunHistoryEntry['status'],
): Prisma.PiAgentTaskRunUncheckedUpdateInput {
  return {
    sessionId: entry.sessionId ?? task.sessionId,
    status,
    message: entry.message ?? null,
    errorJson: errorJson(task, entry),
    endedAt:
      status === 'success' || status === 'error' ? toDate(task.lastRunAt ?? task.updatedAt) : null,
  };
}

function errorJson(
  task: ScheduledTask,
  entry: ScheduledTaskRunHistoryEntry,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return entry.status === 'error'
    ? jsonInput({ message: entry.message ?? task.lastError ?? 'Scheduled task failed' })
    : Prisma.JsonNull;
}

function taskRunHistoryFromPrisma(row: PrismaRecord): ScheduledTaskRunHistoryEntry {
  return {
    id: row.id,
    status: row.status,
    createdAt: toIso(row.createdAt),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.message ? { message: row.message } : {}),
  };
}

function parseModel(value: unknown): ScheduledTaskModelConfig {
  if (typeof value === 'string') {
    try {
      return parseModel(JSON.parse(value) as unknown);
    } catch {
      return { provider: 'unknown', model: 'unknown' };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { provider: 'unknown', model: 'unknown' };
  }
  const raw = value as Partial<ScheduledTaskModelConfig>;
  return {
    provider: typeof raw.provider === 'string' ? raw.provider : 'unknown',
    model: typeof raw.model === 'string' ? raw.model : 'unknown',
    ...(isThinkingLevel(raw.thinkingLevel) ? { thinkingLevel: raw.thinkingLevel } : {}),
    ...(typeof raw.authProfileId === 'string' ? { authProfileId: raw.authProfileId } : {}),
    ...(raw.reasoning === true ? { reasoning: true } : {}),
  };
}

function isThinkingLevel(
  value: unknown,
): value is NonNullable<ScheduledTaskModelConfig['thinkingLevel']> {
  return (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  );
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
