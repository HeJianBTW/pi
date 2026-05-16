# @amaster.ai/pi-attachments

Attachment preparation utilities for Pi Agent runtimes.

This package normalizes chat attachment inputs, stores or fetches uploaded files,
extracts model-readable text from common document formats, and produces
model-visible image payloads for supported bitmap images.

## Design

- The core package is transport-agnostic. Local uploads and proxied remote
  uploads are both represented as attachment sources.
- Platform authentication is injected through `AttachmentUploadAuth`; the
  package does not depend on a specific auth provider.
- Provider-specific image content is represented with a small structural type
  so callers can adapt it to their own model SDK.
- File parsing is best-effort. Text, SVG, CSV/TSV, PPTX, and legacy PPT fallbacks
  are handled locally. Other document formats can use the LiteParse parser when
  enabled.

## Supported Inputs

- Inline text: `txt`, `md`, `json`, `html`, `xml`, `svg`, `yaml`, source files,
  logs, CSV, and TSV.
- Bitmap images: `jpeg`, `png`, `gif`, and `webp`.
- Documents: `pdf`, `doc/docx`, `xls/xlsx/xlsm`, `ppt/pptx`, `odt`, `ods`,
  `odp`, and `rtf` when parsing is enabled.

## Public API

- `createAttachmentService(config)`
- `handleAttachmentRoutes(input)`
- `normalizeAttachments(value, maxCount)`
- `renderAttachmentPrompt(message, bundle)`
- `checkAttachmentHostDependencies()`

The package is ESM-only.
