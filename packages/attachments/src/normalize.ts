import type { AttachmentSource, ChatAttachmentInput, NormalizedAttachment } from "./types.js";

export class AttachmentValidationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export function normalizeAttachments(value: unknown, maxCount: number): NormalizedAttachment[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AttachmentValidationError("attachments must be an array");
  }
  if (value.length > maxCount) {
    throw new AttachmentValidationError(`attachments must include at most ${maxCount} files`);
  }
  return value.map((raw, index) => normalizeAttachment(raw, index));
}

function normalizeAttachment(value: unknown, index: number): NormalizedAttachment {
  if (!value || typeof value !== "object") {
    throw new AttachmentValidationError(`attachment ${index + 1} must be an object`);
  }
  const candidate = value as Partial<ChatAttachmentInput>;
  const id = trimToUndefined(candidate.id);
  const name = trimToUndefined(candidate.name);
  if (!id) {
    throw new AttachmentValidationError(`attachment ${index + 1} id is required`);
  }
  if (!name) {
    throw new AttachmentValidationError(`attachment ${index + 1} name is required`);
  }
  const source = normalizeSource((candidate as { source?: unknown }).source, index);
  const mimeType = trimToUndefined(candidate.mimeType);
  const size = typeof candidate.size === "number" && Number.isFinite(candidate.size)
    ? Math.max(0, Math.floor(candidate.size))
    : undefined;
  return {
    id,
    name,
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    source,
  };
}

function normalizeSource(value: unknown, index: number): AttachmentSource {
  if (!value || typeof value !== "object") {
    throw new AttachmentValidationError(`attachment ${index + 1} source is required`);
  }
  const source = value as Record<string, unknown>;
  if (source.kind === "inlineText") {
    if (typeof source.text !== "string") {
      throw new AttachmentValidationError(`attachment ${index + 1} inline text is required`);
    }
    return {
      kind: "inlineText",
      text: source.text,
      ...(typeof source.truncated === "boolean" ? { truncated: source.truncated } : {}),
    };
  }
  if (source.kind === "remoteObject") {
    const url = trimToUndefined(typeof source.url === "string" ? source.url : undefined);
    if (!url) {
      throw new AttachmentValidationError(`attachment ${index + 1} remote url is required`);
    }
    const key = trimToUndefined(typeof source.key === "string" ? source.key : undefined);
    return { kind: "remoteObject", url, ...(key ? { key } : {}) };
  }
  if (source.kind === "storedFile") {
    const attachmentId = trimToUndefined(typeof source.attachmentId === "string" ? source.attachmentId : undefined);
    if (!attachmentId) {
      throw new AttachmentValidationError(`attachment ${index + 1} stored attachment id is required`);
    }
    return { kind: "storedFile", attachmentId };
  }
  throw new AttachmentValidationError(`attachment ${index + 1} source kind is invalid`);
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
