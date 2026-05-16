export async function fetchRemoteAttachment(input: {
  url: string;
  fallbackMimeType?: string;
  maxBytes: number;
  timeoutMs: number;
}): Promise<{ data: Buffer; mimeType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > input.maxBytes) {
      throw new Error(`attachment exceeds ${input.maxBytes} bytes`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > input.maxBytes) {
      throw new Error(`attachment exceeds ${input.maxBytes} bytes`);
    }
    const mimeType = trimToUndefined(response.headers.get("content-type")?.split(";")[0]) ?? input.fallbackMimeType;
    return { data, ...(mimeType ? { mimeType } : {}) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`attachment fetch timed out after ${input.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
