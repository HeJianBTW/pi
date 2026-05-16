import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { RedisLockManager } from './redis-locks.js';

type MigrationRow = {
  migration_name: string;
  checksum: string;
};

export type DbMigrationResult = {
  applied: string[];
  skipped: string[];
};

export async function runDbMigrations(input: {
  databaseUrl: string;
  redisUrl: string;
  migrationsDir?: string;
  lockTimeoutSeconds?: number;
}): Promise<DbMigrationResult> {
  const prisma = new PrismaClient({ datasources: { db: { url: input.databaseUrl } } });
  const locks = new RedisLockManager(input.redisUrl);
  try {
    return await locks.withLock({
      key: 'pi:db-migration',
      ttlMs: Math.max(60_000, (input.lockTimeoutSeconds ?? 60) * 1000),
      timeoutMs: (input.lockTimeoutSeconds ?? 60) * 1000,
      retryMs: 500,
      task: async () => {
        await ensureMigrationTable(prisma);
        const migrations = await readMigrationFiles(input.migrationsDir ?? defaultMigrationsDir());
        const appliedRows = await prisma.$queryRawUnsafe<Array<MigrationRow>>(
          'SELECT migration_name, checksum FROM _prisma_migrations',
        );
        const appliedByName = new Map(appliedRows.map((row) => [row.migration_name, row.checksum]));
        const result: DbMigrationResult = { applied: [], skipped: [] };
        for (const migration of migrations) {
          const existingChecksum = appliedByName.get(migration.name);
          if (existingChecksum) {
            if (existingChecksum !== migration.checksum) {
              throw new Error(`Migration checksum mismatch for ${migration.name}`);
            }
            result.skipped.push(migration.name);
            continue;
          }
          const statements = splitSqlStatements(migration.sql);
          for (const statement of statements) {
            await prisma.$executeRawUnsafe(statement);
          }
          await prisma.$executeRawUnsafe(
            `INSERT INTO _prisma_migrations (
              id, checksum, migration_name, started_at, finished_at, applied_steps_count
            ) VALUES (?, ?, ?, NOW(3), NOW(3), ?)`,
            randomUUID(),
            migration.checksum,
            migration.name,
            statements.length,
          );
          result.applied.push(migration.name);
        }
        return result;
      },
    });
  } finally {
    await locks.disconnect();
    await prisma.$disconnect();
  }
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        current += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && !inBacktick && char === '-' && next === '-') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && !inBacktick && char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    current += char;
    const previous = sql[index - 1] ?? '';
    const escaped = previous === '\\' && sql[index - 2] !== '\\';
    if (!inDoubleQuote && !inBacktick && char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && !inBacktick && char === '"' && !escaped) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && char === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && !inBacktick && char === ';') {
      const statement = current.trim();
      if (statement) {
        statements.push(statement.slice(0, -1).trim());
      }
      current = '';
    }
  }
  const finalStatement = current.trim();
  if (finalStatement) {
    statements.push(finalStatement);
  }
  return statements.filter(Boolean);
}

async function ensureMigrationTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS _prisma_migrations (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      finished_at DATETIME(3),
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at DATETIME(3),
      started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      applied_steps_count INTEGER UNSIGNED NOT NULL DEFAULT 0
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function readMigrationFiles(
  migrationsDir: string,
): Promise<Array<{ name: string; sql: string; checksum: string }>> {
  const entries = await readdir(migrationsDir);
  const migrations: Array<{ name: string; sql: string; checksum: string }> = [];
  for (const entry of entries.sort()) {
    const dir = path.join(migrationsDir, entry);
    if (!(await stat(dir)).isDirectory()) {
      continue;
    }
    const sql = await readFile(path.join(dir, 'migration.sql'), 'utf8');
    migrations.push({
      name: entry,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  if (migrations.length === 0) {
    throw new Error(`No DB migrations found in ${migrationsDir}`);
  }
  return migrations;
}

function defaultMigrationsDir(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dirname, '../prisma/migrations/mysql');
}
