import type { IncomingMessage, ServerResponse } from "node:http";
import type { AttachmentContext } from "./types.js";
import type { AttachmentService } from "./service.js";
import { AttachmentHttpError, readRequestBody, writeJson } from "./http.js";
import { parseMultipartBoundary, parseMultipartFiles } from "./multipart.js";
import { proxyAttachmentUpload, type AttachmentUploadAuth } from "./upload-proxy.js";

export async function handleAttachmentRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  service: AttachmentService;
  uploadAuth: AttachmentUploadAuth;
  maxUploadBodyBytes: number;
  context: AttachmentContext;
}): Promise<boolean> {
  if (input.request.method === "POST" && input.url.pathname === "/v1/attachments/upload") {
    if (input.service.config.storageMode === "platform") {
      await proxyAttachmentUpload({
        request: input.request,
        response: input.response,
        uploadEndpoint: input.service.config.uploadEndpoint,
        allowInsecureLocalTls: input.service.config.allowInsecureLocalUploadTls,
        auth: input.uploadAuth,
        maxBodyBytes: input.maxUploadBodyBytes,
      });
      return true;
    }
    try {
      const files = await readMultipartFiles(input.request, input.maxUploadBodyBytes);
      const attachments = [];
      for (const file of files) {
        const record = await input.service.store.putBuffer({
          data: file.data,
          name: file.fileName,
          ...(file.contentType ? { mimeType: file.contentType } : {}),
          sessionId: input.context.sessionId,
        });
        attachments.push(toStoredAttachment(record));
      }
      writeJson(input.response, 200, { attachments, attachment: attachments[0] });
    } catch (error) {
      writeRouteError(input.response, error);
    }
    return true;
  }

  if (input.request.method === "POST" && input.url.pathname === "/v1/attachments/register-local") {
    if (!input.service.config.desktopEnabled) {
      writeJson(input.response, 404, { error: "local attachment registration is only available in desktop mode" });
      return true;
    }
    try {
      const body = JSON.parse((await readRequestBody(input.request, input.maxUploadBodyBytes)).toString("utf8")) as {
        files?: Array<{ path?: string; name?: string; mimeType?: string }>;
      };
      const files = Array.isArray(body.files) ? body.files : [];
      const attachments = [];
      for (const file of files) {
        if (!file.path) {
          throw new Error("file path is required");
        }
        const record = await input.service.store.putFile({
          sourcePath: file.path,
          ...(file.name ? { name: file.name } : {}),
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          sessionId: input.context.sessionId,
        });
        attachments.push(toStoredAttachment(record));
      }
      writeJson(input.response, 200, { attachments });
    } catch (error) {
      writeRouteError(input.response, error);
    }
    return true;
  }

  return false;
}

async function readMultipartFiles(request: IncomingMessage, maxBytes: number) {
  const boundary = parseMultipartBoundary(request.headers["content-type"]);
  if (!boundary) {
    throw new AttachmentHttpError(400, "multipart_boundary_required", "multipart boundary is required");
  }
  return parseMultipartFiles(await readRequestBody(request, maxBytes), boundary);
}

function toStoredAttachment(record: {
  attachmentId: string;
  name: string;
  mimeType?: string;
  size: number;
}) {
  return {
    id: record.attachmentId,
    name: record.name,
    ...(record.mimeType ? { mimeType: record.mimeType } : {}),
    size: record.size,
    source: { kind: "storedFile", attachmentId: record.attachmentId },
  };
}

function writeRouteError(response: ServerResponse, error: unknown): void {
  if (error instanceof AttachmentHttpError) {
    writeJson(response, error.statusCode, { error: error.message, code: error.code });
    return;
  }
  writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
}
