import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredAttachmentRecord } from "./types.js";
import { mimeTypeFromFileName } from "./classify.js";

export class LocalAttachmentStore {
  constructor(private readonly rootDir: string) {}

  async putFile(input: {
    sourcePath: string;
    name?: string;
    mimeType?: string;
    sessionId?: string;
  }): Promise<StoredAttachmentRecord> {
    const sourcePath = fileURLToPathIfNeeded(input.sourcePath);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`attachment source is not a file: ${input.sourcePath}`);
    }
    const name = sanitizeFileName(input.name ?? path.basename(sourcePath));
    const attachmentId = randomUUID();
    const dir = this.attachmentDir(input.sessionId, attachmentId);
    await mkdir(dir, { recursive: true });
    const targetPath = path.join(dir, name);
    await copyFile(sourcePath, targetPath);
    const record = createRecord({
      attachmentId,
      name,
      size: sourceStat.size,
      path: targetPath,
      ...optionalMimeType(input.mimeType ?? mimeTypeFromFileName(name)),
    });
    await writeRecord(dir, record);
    return record;
  }

  async putBuffer(input: {
    data: Buffer;
    name: string;
    mimeType?: string;
    sessionId?: string;
  }): Promise<StoredAttachmentRecord> {
    const name = sanitizeFileName(input.name);
    const attachmentId = randomUUID();
    const dir = this.attachmentDir(input.sessionId, attachmentId);
    await mkdir(dir, { recursive: true });
    const targetPath = path.join(dir, name);
    await writeFile(targetPath, input.data);
    const record = createRecord({
      attachmentId,
      name,
      size: input.data.byteLength,
      path: targetPath,
      ...optionalMimeType(input.mimeType ?? mimeTypeFromFileName(name)),
    });
    await writeRecord(dir, record);
    return record;
  }

  async readRecord(attachmentId: string): Promise<StoredAttachmentRecord> {
    const safeId = sanitizeId(attachmentId);
    const candidates = await findRecordCandidates(this.rootDir, safeId);
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(await readFile(candidate, "utf8")) as StoredAttachmentRecord;
        if (parsed.attachmentId === attachmentId) {
          return parsed;
        }
      } catch {
        // Keep looking for another candidate.
      }
    }
    throw new Error(`stored attachment not found: ${attachmentId}`);
  }

  private attachmentDir(sessionId: string | undefined, attachmentId: string): string {
    const sessionPart = sanitizeId(sessionId ?? "global");
    const hash = createHash("sha256").update(attachmentId).digest("hex").slice(0, 8);
    return path.join(this.rootDir, sessionPart, `${hash}-${sanitizeId(attachmentId)}`);
  }
}

function createRecord(input: {
  attachmentId: string;
  name: string;
  mimeType?: string;
  size: number;
  path: string;
}): StoredAttachmentRecord {
  return {
    attachmentId: input.attachmentId,
    name: input.name,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    size: input.size,
    path: input.path,
    createdAt: new Date().toISOString(),
  };
}

async function writeRecord(dir: string, record: StoredAttachmentRecord): Promise<void> {
  await writeFile(path.join(dir, "attachment.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function findRecordCandidates(rootDir: string, attachmentId: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const result: string[] = [];
  try {
    for (const sessionEntry of await readdir(rootDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(rootDir, sessionEntry.name);
      for (const attachmentEntry of await readdir(sessionDir, { withFileTypes: true })) {
        if (attachmentEntry.isDirectory() && attachmentEntry.name.endsWith(`-${attachmentId}`)) {
          result.push(path.join(sessionDir, attachmentEntry.name, "attachment.json"));
        }
      }
    }
  } catch {
    return [];
  }
  return result;
}

function sanitizeFileName(value: string): string {
  const base = path.basename(value).replace(/[^\w .@()+=[\]-]/g, "_").trim();
  return base || "attachment";
}

function optionalMimeType(mimeType: string | undefined): { mimeType?: string } {
  return mimeType ? { mimeType } : {};
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || "attachment";
}

function fileURLToPathIfNeeded(value: string): string {
  return value.startsWith("file://") ? fileURLToPath(value) : value;
}
