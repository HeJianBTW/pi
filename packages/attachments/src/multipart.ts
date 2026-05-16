export type MultipartFile = {
  fieldName: string;
  fileName: string;
  contentType?: string;
  data: Buffer;
};

export function parseMultipartBoundary(contentType: string | string[] | undefined): string | undefined {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  const match = value?.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] ?? match?.[2]?.trim();
}

export function parseMultipartFiles(body: Buffer, boundary: string): MultipartFile[] {
  const marker = `--${boundary}`;
  const text = body.toString("binary");
  const parts = text.split(marker).slice(1, -1);
  const files: MultipartFile[] = [];
  for (const part of parts) {
    const trimmed = part.replace(/^\r?\n/, "");
    const separator = trimmed.indexOf("\r\n\r\n");
    if (separator < 0) {
      continue;
    }
    const rawHeaders = trimmed.slice(0, separator);
    const contentStart = separator + 4;
    const rawContent = trimmed.slice(contentStart).replace(/\r\n$/, "");
    const headers = parsePartHeaders(rawHeaders);
    const disposition = headers.get("content-disposition") ?? "";
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const fileName = disposition.match(/filename="([^"]*)"/)?.[1];
    if (!name || !fileName) {
      continue;
    }
    const contentType = headers.get("content-type");
    files.push({
      fieldName: name,
      fileName,
      ...(contentType ? { contentType } : {}),
      data: Buffer.from(rawContent, "binary"),
    });
  }
  return files;
}

function parsePartHeaders(value: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}
