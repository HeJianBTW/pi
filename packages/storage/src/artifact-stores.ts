/**
 * Artifact metadata stores.
 *
 * Artifacts are generated files or large outputs stored outside chat messages.
 * Stores keep searchable metadata and stable references; payload bytes live in
 * workspace files, sandbox storage, or platform object storage.
 */
import { randomUUID } from 'node:crypto';
import type {
  RuntimeArtifact,
  RuntimeArtifactCreateInput,
  RuntimeArtifactListInput,
  RuntimeArtifactStore,
  RuntimeScope,
} from '@amaster.ai/pi-shared';
import { readJsonFile, writeJsonFile } from './json-file.js';

export class JsonFileArtifactStore implements RuntimeArtifactStore {
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async create(input: RuntimeArtifactCreateInput): Promise<RuntimeArtifact> {
    const artifact: RuntimeArtifact = {
      id: input.id ?? randomUUID(),
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      artifactType: input.artifactType,
      ...(input.name ? { name: input.name } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      storageUri: input.storageUri,
      ...(input.previewUri ? { previewUri: input.previewUri } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    await this.update((artifacts) => {
      artifacts.push(artifact);
    });
    return artifact;
  }

  async get(scope: RuntimeScope, id: string): Promise<RuntimeArtifact | undefined> {
    await this.writeTail.catch(() => undefined);
    const artifacts = await this.readAll();
    return artifacts.find(
      (artifact) =>
        artifact.id === id &&
        artifact.tenantId === scope.tenantId &&
        (!scope.userId || artifact.userId === scope.userId),
    );
  }

  async list(input: RuntimeArtifactListInput): Promise<RuntimeArtifact[]> {
    await this.writeTail.catch(() => undefined);
    const artifacts = await this.readAll();
    const filtered = artifacts.filter(
      (artifact) =>
        artifact.tenantId === input.tenantId &&
        (!input.userId || artifact.userId === input.userId) &&
        (!input.sessionId || artifact.sessionId === input.sessionId) &&
        (!input.turnId || artifact.turnId === input.turnId) &&
        (!input.toolCallId || artifact.toolCallId === input.toolCallId),
    );
    const limit = input.limit && input.limit > 0 ? input.limit : filtered.length;
    return filtered.slice(-limit);
  }

  async delete(scope: RuntimeScope, id: string): Promise<boolean> {
    let deleted = false;
    await this.update((artifacts) => {
      const index = artifacts.findIndex(
        (artifact) =>
          artifact.id === id &&
          artifact.tenantId === scope.tenantId &&
          (!scope.userId || artifact.userId === scope.userId),
      );
      if (index >= 0) {
        artifacts.splice(index, 1);
        deleted = true;
      }
    });
    return deleted;
  }

  private readAll(): Promise<RuntimeArtifact[]> {
    return readJsonFile<RuntimeArtifact[]>(this.filePath, []);
  }

  private async update(mutator: (artifacts: RuntimeArtifact[]) => void): Promise<void> {
    const pending = this.writeTail.then(async () => {
      const artifacts = await this.readAll();
      mutator(artifacts);
      await writeJsonFile(this.filePath, artifacts);
    });
    this.writeTail = pending.catch(() => undefined);
    await pending;
  }
}
