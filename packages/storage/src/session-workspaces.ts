import type { JsonObject, RuntimeSession } from '@amaster.ai/pi-shared';
import { PrismaClient } from '@prisma/client';

export type RuntimeSessionWithWorkspaceDir = RuntimeSession & {
  workspaceDir?: string;
};

export type SessionWorkspaceBinding = {
  sessionId: string;
  tenantId: string;
  userId?: string;
  workspaceId?: string;
  workspaceDir: string;
};

export class DbSessionWorkspaceStore {
  private readonly prisma: PrismaClient;

  constructor(databaseUrl: string) {
    this.prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl },
      },
    });
  }

  async get(input: {
    tenantId: string;
    sessionId: string;
    userId?: string;
  }): Promise<SessionWorkspaceBinding | undefined> {
    const row = await this.prisma.piAgentSession.findFirst({
      where: {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        deletedAt: null,
        ...(input.userId ? { userId: input.userId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!row) {
      return undefined;
    }
    const metadata = parseJsonObject(row.metadataJson);
    const session = parseJsonObject(metadata.session);
    const workspaceDir = trimToUndefined(session.workspaceDir);
    if (!workspaceDir) {
      return undefined;
    }
    return {
      sessionId: row.sessionId,
      tenantId: row.tenantId,
      ...(row.userId ? { userId: row.userId } : {}),
      ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      workspaceDir,
    };
  }
}

export function sessionWorkspaceFromRuntimeSession(
  session: RuntimeSession | undefined,
): SessionWorkspaceBinding | undefined {
  if (!session) {
    return undefined;
  }
  const workspaceDir = trimToUndefined((session as RuntimeSessionWithWorkspaceDir).workspaceDir);
  if (!workspaceDir || !session.tenantId) {
    return undefined;
  }
  return {
    sessionId: session.sessionId,
    tenantId: session.tenantId,
    ...(session.userId ? { userId: session.userId } : {}),
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    workspaceDir,
  };
}

function parseJsonObject(value: unknown): JsonObject {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : {};
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
