export type AttachmentJsonObject = { [key: string]: AttachmentJsonValue | undefined };
export type AttachmentJsonValue =
  | string
  | number
  | boolean
  | null
  | AttachmentJsonObject
  | AttachmentJsonValue[];

export type AttachmentImageContent = {
  type: 'image';
  mimeType: string;
  data: string;
};

export type AttachmentSource =
  | { kind: 'inlineText'; text: string; truncated?: boolean }
  | { kind: 'remoteObject'; url: string; key?: string }
  | { kind: 'storedFile'; attachmentId: string };

export type ChatAttachmentInput = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  source: AttachmentSource;
};

export type NormalizedAttachment = ChatAttachmentInput;

export type PreparedAttachmentBundle = {
  attachments: NormalizedAttachment[];
  images: AttachmentImageContent[];
  promptBlocks: string[];
  failures: AttachmentFailure[];
  telemetry: AttachmentJsonObject[];
};

export type AttachmentFailure = {
  attachmentId: string;
  name: string;
  reason: string;
};

export type AttachmentContext = {
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  sessionId: string;
  traceId?: string;
};

export type AttachmentServiceConfig = {
  storageMode: 'platform' | 'local';
  uploadEndpoint: string;
  allowInsecureLocalUploadTls: boolean;
  localStoreDir: string;
  maxAttachmentCount: number;
  maxBytes: number;
  maxTextChars: number;
  fetchTimeoutMs: number;
  parseEnabled: boolean;
  parser: 'liteparse' | 'basic';
  ocr: 'off' | 'auto';
  maxPages: number;
  desktopEnabled: boolean;
};

export type StoredAttachmentRecord = {
  attachmentId: string;
  name: string;
  mimeType?: string;
  size: number;
  path: string;
  createdAt: string;
};

export type ParseAttachmentInput = {
  path: string;
  name: string;
  mimeType?: string;
  format?: 'text' | 'json';
  ocr: 'off' | 'auto';
  maxPages: number;
};

export type ParsedAttachment = {
  text: string;
  pageCount?: number;
  warnings?: string[];
};
