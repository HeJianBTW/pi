import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

const RELEASE_REDIS_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const EXTEND_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export class RedisLockManager {
  readonly owner: string;
  private readonly redis: Redis;

  constructor(redisUrl: string, owner = `${process.pid}:${randomUUID()}`) {
    this.owner = owner;
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    this.redis.on("error", () => {
      // ioredis also rejects the operation promise; this prevents unhandled error events.
    });
  }

  async ping(): Promise<void> {
    if (this.redis.status === "wait") {
      await this.redis.connect();
    }
    await this.redis.ping();
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    if (this.redis.status === "wait") {
      await this.redis.connect();
    }
    const result = await this.redis.set(key, this.owner, "PX", ttlMs, "NX");
    return result === "OK";
  }

  async extend(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.eval(EXTEND_LOCK_SCRIPT, 1, key, this.owner, String(ttlMs));
    return Number(result) === 1;
  }

  async release(key: string): Promise<void> {
    await this.redis.eval(RELEASE_REDIS_LOCK_SCRIPT, 1, key, this.owner);
  }

  async withLock<T>(input: {
    key: string;
    ttlMs: number;
    timeoutMs: number;
    retryMs?: number;
    task: () => Promise<T>;
  }): Promise<T> {
    const startedAt = Date.now();
    const retryMs = input.retryMs ?? 50;
    for (;;) {
      if (await this.acquire(input.key, input.ttlMs)) {
        try {
          return await input.task();
        } finally {
          await this.release(input.key);
        }
      }
      if (Date.now() - startedAt >= input.timeoutMs) {
        throw new Error(`Timed out acquiring Redis lock: ${input.key}`);
      }
      await sleep(retryMs);
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit().catch(() => {
      this.redis.disconnect();
    });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
