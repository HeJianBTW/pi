import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { getHeader, readRequestBody, writeJson } from "./http.js";

export type AttachmentUploadAuth = {
  enabled: boolean;
  baseUrl?: string;
  internalBaseUrl?: string;
  accessToken?: string;
  user?: unknown;
  userHeaders?: (user: unknown) => Record<string, string>;
};

export async function proxyAttachmentUpload(input: {
  request: IncomingMessage;
  response: ServerResponse;
  uploadEndpoint: string;
  allowInsecureLocalTls: boolean;
  auth: AttachmentUploadAuth;
  maxBodyBytes: number;
}): Promise<void> {
  if (input.auth.enabled && !input.auth.accessToken) {
    writeJson(input.response, 401, { error: "authentication is required for attachment upload" });
    return;
  }
  const targetUrl = resolveUploadUrl(input.uploadEndpoint, input.auth);
  const body = await readRequestBody(input.request, input.maxBodyBytes);
  const headers: Record<string, string> = {
    "content-length": String(body.length),
  };
  const contentType = getHeader(input.request, "content-type");
  if (contentType) {
    headers["content-type"] = contentType;
  }
  if (input.auth.accessToken) {
    headers.authorization = `Bearer ${input.auth.accessToken}`;
  }
  if (input.auth.user && input.auth.userHeaders) {
    Object.assign(headers, input.auth.userHeaders(input.auth.user));
  }
  let upstream: { status: number; contentType: string | undefined; body: Buffer };
  try {
    upstream = await proxyHttpRequest(targetUrl, headers, body, {
      allowInsecureLocalTls: input.allowInsecureLocalTls,
    });
  } catch (error) {
    writeJson(input.response, 502, {
      error: `attachment upload proxy failed: ${error instanceof Error ? error.message : String(error)}`,
      upstream: redactUrlForClient(targetUrl),
    });
    return;
  }
  input.response.writeHead(upstream.status, {
    "content-type": upstream.contentType ?? "application/json; charset=utf-8",
  });
  input.response.end(upstream.body);
}

function resolveUploadUrl(uploadEndpoint: string, auth: AttachmentUploadAuth): string {
  if (/^https?:\/\//i.test(uploadEndpoint)) {
    return uploadEndpoint;
  }
  const baseUrl = auth.internalBaseUrl ?? auth.baseUrl;
  if (!baseUrl) {
    throw new Error("upload endpoint must be absolute when upload base url is not configured");
  }
  return new URL(uploadEndpoint, baseUrl).toString();
}

function proxyHttpRequest(
  targetUrl: string,
  headers: Record<string, string>,
  body: Buffer,
  options: { allowInsecureLocalTls: boolean },
): Promise<{ status: number; contentType: string | undefined; body: Buffer }> {
  const url = new URL(targetUrl);
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
  const allowInsecureLocalTls = url.protocol === "https:" &&
    options.allowInsecureLocalTls &&
    isLocalUploadHost(url.hostname);
  return new Promise((resolve, reject) => {
    const upstream = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers,
      ...(allowInsecureLocalTls ? { agent: new HttpsAgent({ rejectUnauthorized: false }) } : {}),
    }, (upstreamResponse) => {
      const chunks: Buffer[] = [];
      upstreamResponse.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamResponse.on("error", reject);
      upstreamResponse.on("end", () => {
        const contentTypeHeader = upstreamResponse.headers["content-type"];
        resolve({
          status: upstreamResponse.statusCode ?? 502,
          contentType: Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader,
          body: Buffer.concat(chunks),
        });
      });
    });
    upstream.on("error", reject);
    upstream.end(body);
  });
}

export function isLocalUploadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local");
}

function redactUrlForClient(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}
