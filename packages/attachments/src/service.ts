import type { AttachmentContext } from "./types.js";
import type {
  AttachmentImageContent,
  AttachmentJsonObject,
  AttachmentServiceConfig,
  NormalizedAttachment,
  PreparedAttachmentBundle,
  StoredAttachmentRecord,
} from "./types.js";
import { isDocumentAttachment, isImageMimeType, resolveAttachmentMimeType } from "./classify.js";
import { LocalAttachmentStore } from "./local-store.js";
import { normalizeAttachments } from "./normalize.js";
import { BasicAttachmentParser, LiteParseAttachmentParser, type AttachmentParser } from "./parser.js";
import { attachmentHeader, truncateText } from "./prompt.js";
import { fetchRemoteAttachment } from "./remote-fetch.js";

export type AttachmentService = {
  readonly config: AttachmentServiceConfig;
  readonly store: LocalAttachmentStore;
  prepareForPrompt(attachments: unknown, context: AttachmentContext): Promise<PreparedAttachmentBundle>;
};

export function createAttachmentService(config: AttachmentServiceConfig): AttachmentService {
  const store = new LocalAttachmentStore(config.localStoreDir);
  const parser = config.parser === "liteparse"
    ? new LiteParseAttachmentParser()
    : new BasicAttachmentParser();
  return new DefaultAttachmentService(config, store, parser);
}

class DefaultAttachmentService implements AttachmentService {
  constructor(
    readonly config: AttachmentServiceConfig,
    readonly store: LocalAttachmentStore,
    private readonly parser: AttachmentParser,
  ) {}

  async prepareForPrompt(attachmentsInput: unknown, context: AttachmentContext): Promise<PreparedAttachmentBundle> {
    const attachments = normalizeAttachments(attachmentsInput, this.config.maxAttachmentCount);
    const images: AttachmentImageContent[] = [];
    const promptBlocks: string[] = [];
    const failures: PreparedAttachmentBundle["failures"] = [];
    const telemetry: AttachmentJsonObject[] = [];

    for (const [index, attachment] of attachments.entries()) {
      try {
        const result = await this.prepareAttachment(attachment, index, context);
        if (result.image) {
          images.push(result.image);
        }
        if (result.promptBlock) {
          promptBlocks.push(result.promptBlock);
        }
        telemetry.push(result.telemetry);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ attachmentId: attachment.id, name: attachment.name, reason });
        promptBlocks.push(`${attachmentHeader({ index, ...attachment })}\nContent: attachment could not be processed (${reason}).`);
        telemetry.push({ id: attachment.id, name: attachment.name, status: "failed", error: reason });
      }
    }

    return { attachments, images, promptBlocks, failures, telemetry };
  }

  private async prepareAttachment(
    attachment: NormalizedAttachment,
    index: number,
    context: AttachmentContext,
  ): Promise<{ image?: AttachmentImageContent; promptBlock?: string; telemetry: AttachmentJsonObject }> {
    const header = attachmentHeader({ index, ...attachment });
    if (attachment.source.kind === "inlineText") {
      const text = truncateText(attachment.source.text, this.config.maxTextChars);
      return {
        promptBlock: `${header}\nContent:\n${text}`,
        telemetry: attachmentTelemetry(attachment, { status: "inline_text", textBytes: text.length }),
      };
    }

    const local = await this.resolveToLocalFile(attachment, context);
    const mimeType = resolveAttachmentMimeType(local.name, local.mimeType ?? attachment.mimeType);
    if (isImageMimeType(mimeType)) {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(local.path);
      if (data.byteLength > this.config.maxBytes) {
        throw new Error(`attachment exceeds ${this.config.maxBytes} bytes`);
      }
      return {
        image: {
          type: "image",
          data: data.toString("base64"),
          mimeType,
        },
        promptBlock: `${header}\nContent: image upload is attached directly as model-visible image content. Do not call file tools for this uploaded image.`,
        telemetry: attachmentTelemetry(attachment, { status: "image", bytes: data.byteLength }),
      };
    }

    if (this.config.parseEnabled && isDocumentAttachment(local.name, mimeType)) {
      const parsed = await this.parser.parse({
        path: local.path,
        name: local.name,
        ...(mimeType ? { mimeType } : {}),
        format: "text",
        ocr: this.config.ocr,
        maxPages: this.config.maxPages,
      });
      const text = truncateText(parsed.text, this.config.maxTextChars);
      return {
        promptBlock: `${header}\nContent:\n${text}`,
        telemetry: attachmentTelemetry(attachment, {
          status: "parsed",
          textBytes: text.length,
          ...(parsed.pageCount !== undefined ? { pageCount: parsed.pageCount } : {}),
        }),
      };
    }

    return {
      promptBlock: `${header}\nContent: non-text attachment is available as metadata only.`,
      telemetry: attachmentTelemetry(attachment, { status: "metadata_only" }),
    };
  }

  private async resolveToLocalFile(
    attachment: NormalizedAttachment,
    context: AttachmentContext,
  ): Promise<StoredAttachmentRecord> {
    if (attachment.source.kind === "storedFile") {
      return this.store.readRecord(attachment.source.attachmentId);
    }
    if (attachment.source.kind === "remoteObject") {
      const fetched = await fetchRemoteAttachment({
        url: attachment.source.url,
        maxBytes: this.config.maxBytes,
        timeoutMs: this.config.fetchTimeoutMs,
        ...(attachment.mimeType ? { fallbackMimeType: attachment.mimeType } : {}),
      });
      return this.store.putBuffer({
        data: fetched.data,
        name: attachment.name,
        sessionId: context.sessionId,
        ...optionalMimeType(fetched.mimeType ?? attachment.mimeType),
      });
    }
    throw new Error("inline text attachment does not resolve to a local file");
  }
}

function optionalMimeType(mimeType: string | undefined): { mimeType?: string } {
  return mimeType ? { mimeType } : {};
}

function attachmentTelemetry(
  attachment: NormalizedAttachment,
  extra: AttachmentJsonObject,
): AttachmentJsonObject {
  return {
    id: attachment.id,
    name: attachment.name,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    sourceKind: attachment.source.kind,
    ...extra,
  };
}
