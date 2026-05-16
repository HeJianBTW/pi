import type { IncomingMessage, ServerResponse } from 'node:http';

export class AttachmentHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentHttpError';
  }
}

export async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AttachmentHttpError(
      413,
      'request_body_too_large',
      `request body exceeds ${maxBytes} bytes`,
    );
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new AttachmentHttpError(
        413,
        'request_body_too_large',
        `request body exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.end();
    }
    return;
  }
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

export function getHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  const candidate = Array.isArray(value) ? value[0] : value;
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : undefined;
}
