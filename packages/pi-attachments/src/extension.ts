/**
 * Pi Attachments Extension
 *
 * Intercepts user input containing @path references, reads the files,
 * classifies them, and injects their content into the prompt as context.
 * Image files are encoded as base64 ImageContent for multimodal input.
 *
 * Supports:
 * - @path/to/file.ts — unquoted file reference
 * - @"/path with spaces/file.pdf" — quoted file reference
 * - @file.ts#L10-20 — line range (parsed but range applied by LLM tools)
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI, InputEventResult } from '@earendil-works/pi-coding-agent';
import { type AttachmentMeta, classifyAttachment, renderAttachmentContext } from './classify.js';

type ImageContent = { type: 'image'; mimeType: string; data: string };

const QUOTED_AT_RE = /(^|\s)@"([^"]+)"/g;
const REGULAR_AT_RE = /(^|\s)@([^\s@"]+)/g;

export default function piAttachmentsExtension(pi: ExtensionAPI): void {
  const maxTextChars = Number(process.env.PI_ATTACHMENT_MAX_TEXT_CHARS) || 128_000;

  pi.on('input', async (event, ctx): Promise<InputEventResult | undefined> => {
    const mentions = extractAtMentions(event.text);
    if (mentions.length === 0) return;

    const cwd = ctx.cwd;
    const attachments: AttachmentMeta[] = [];
    const images: ImageContent[] = [...(event.images ?? [])];
    const resolvedPaths = new Set<string>();

    for (const mention of mentions) {
      const { filename } = parseFileReference(mention);
      const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(cwd, filename);
      if (resolvedPaths.has(absolutePath)) continue;
      resolvedPaths.add(absolutePath);

      try {
        const stats = await stat(absolutePath);
        if (stats.isDirectory()) {
          attachments.push({
            id: absolutePath,
            name: path.basename(absolutePath),
            path: absolutePath,
            mimeType: 'inode/directory',
          });
          continue;
        }

        const name = path.basename(absolutePath);
        const mimeType = guessMimeType(name);
        const kind = classifyAttachment(name, mimeType);

        if (kind === 'image') {
          try {
            const data = await readFile(absolutePath);
            images.push({
              type: 'image',
              mimeType: mimeType ?? 'image/png',
              data: data.toString('base64'),
            });
          } catch {
            // skip unreadable images
          }
        } else {
          attachments.push({
            id: absolutePath,
            name,
            path: absolutePath,
            ...(mimeType ? { mimeType } : {}),
            size: stats.size,
          });
        }
      } catch {
        // skip files that don't exist or can't be accessed
      }
    }

    if (attachments.length === 0 && images.length === (event.images?.length ?? 0)) {
      return;
    }

    const cleanText = stripAtMentions(event.text);
    const context = await renderAttachmentContext(attachments, {
      maxTextChars,
      hasImages: images.length > 0,
    });

    const text = context
      ? `${cleanText}\n\n<system-reminder>\n${context}\n</system-reminder>`
      : cleanText;

    return {
      action: 'transform',
      text,
      ...(images.length > 0 ? { images } : {}),
    };
  });
}

function extractAtMentions(content: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(QUOTED_AT_RE)) {
    const value = match[2]!;
    if (!seen.has(value)) {
      seen.add(value);
      mentions.push(value);
    }
  }

  for (const match of content.matchAll(REGULAR_AT_RE)) {
    const value = match[2]!;
    if (!seen.has(value) && !value.startsWith('http')) {
      seen.add(value);
      mentions.push(value);
    }
  }

  return mentions;
}

function stripAtMentions(content: string): string {
  return content.replace(QUOTED_AT_RE, '$1').replace(REGULAR_AT_RE, '$1').trim();
}

function parseFileReference(mention: string): {
  filename: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const hashIdx = mention.indexOf('#L');
  if (hashIdx === -1) {
    return { filename: mention };
  }
  const filename = mention.slice(0, hashIdx);
  const range = mention.slice(hashIdx + 2);
  const parts = range.split('-');
  const lineStart = Number(parts[0]) || undefined;
  const lineEnd = parts[1] ? Number(parts[1]) || undefined : undefined;
  return {
    filename,
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd ? { lineEnd } : {}),
  };
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  pdf: 'application/pdf',
  json: 'application/json',
  xml: 'application/xml',
};

function guessMimeType(name: string): string | undefined {
  const ext = name.toLowerCase().split('.').pop();
  return ext ? MIME_BY_EXT[ext] : undefined;
}
