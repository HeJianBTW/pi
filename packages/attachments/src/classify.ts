import path from "node:path";

export function mimeTypeFromFileName(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".tsv")) return "text/tab-separated-values";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  return undefined;
}

export function fileExtension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

export function isImageMimeType(value: string | undefined): value is string {
  const normalized = normalizeMimeType(value);
  return normalized !== undefined && [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
  ].includes(normalized);
}

export function isTextLikeAttachment(name: string, mimeType: string | undefined): boolean {
  const resolved = normalizeMimeType(mimeType) ?? mimeTypeFromFileName(name);
  return (
    resolved?.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "image/svg+xml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript",
      "application/typescript",
      "application/sql",
      "application/csv",
    ].includes(resolved ?? "") ||
    /\.(csv|tsv|json|md|markdown|txt|html|xml|svg|yaml|yml|js|jsx|ts|tsx|css|sql|log)$/i.test(name)
  );
}

export function isDocumentAttachment(name: string, mimeType: string | undefined): boolean {
  if (isTextLikeAttachment(name, mimeType)) {
    return true;
  }
  const resolved = normalizeMimeType(mimeType) ?? mimeTypeFromFileName(name);
  return (
    [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.presentation",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/rtf",
    ].includes(resolved ?? "") ||
    /\.(pdf|doc|docx|odt|rtf|ppt|pptx|odp|xls|xlsx|xlsm|ods|csv|tsv)$/i.test(name)
  );
}

export function resolveAttachmentMimeType(name: string, mimeType: string | undefined): string | undefined {
  const fromName = mimeTypeFromFileName(name);
  const normalized = normalizeMimeType(mimeType);
  if (fromName && shouldPreferFileNameMimeType(name, normalized)) {
    return fromName;
  }
  return normalized ?? fromName;
}

export function normalizeMimeType(value: string | undefined): string | undefined {
  const trimmed = value?.split(";")[0]?.trim().toLowerCase();
  return trimmed || undefined;
}

function shouldPreferFileNameMimeType(name: string, mimeType: string | undefined): boolean {
  if (/\.(svg|ppt|pptx|doc|docx|xls|xlsx|pdf)$/i.test(name)) {
    return !mimeType ||
      mimeType === "application/octet-stream" ||
      mimeType === "text/plain" ||
      mimeType === "binary/octet-stream";
  }
  return false;
}
