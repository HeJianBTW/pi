import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  normalizeScheduledTask,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  type TaskSchedulerScope,
} from './index.js';
import { readJsonFile, writeJsonFile } from './json-file.js';

export class JsonScheduledTaskStore implements ScheduledTaskStore {
  private loaded = false;
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(private readonly filePath: string) {}

  async list(_scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    await this.load();
    return Array.from(this.tasks.values());
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
    await writeJsonFile(this.filePath, Array.from(this.tasks.values()));
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
