/**
 * Pi Attachments Extension
 *
 * Intercepts user input containing @-references, reads referenced resources,
 * and injects their content into the prompt as context.
 *
 * Recognized references:
 * - @skill:<name> — load SKILL.md for a registered skill (project > user > global agent dir)
 * - @path/to/file.ts — unquoted file reference
 * - @"/path with spaces/file.pdf" — quoted file reference
 * - @file.ts#L10-20 — line range (parsed but range applied by LLM tools)
 *
 * Image files are encoded as base64 ImageContent for multimodal input.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentDir } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI, InputEventResult } from '@earendil-works/pi-coding-agent';
import { type AttachmentMeta, classifyAttachment, renderAttachmentContext } from './classify.js';

type ImageContent = { type: 'image'; mimeType: string; data: string };

const SKILL_NAMESPACE = 'skill';
const NAMESPACE_AT_RE = /(^|\s)@([a-z][a-z0-9_-]*):([^\s@"]+)/gi;
const QUOTED_AT_RE = /(^|\s)@"([^"]+)"/g;
const REGULAR_AT_RE = /(^|\s)@([^\s@"]+)/g;

type Mention = { kind: 'skill'; name: string } | { kind: 'file'; ref: string };

export default function piAttachmentsExtension(pi: ExtensionAPI): void {
  const maxTextChars = Number(process.env.PI_ATTACHMENT_MAX_TEXT_CHARS) || 128_000;

  pi.on('input', async (event, ctx): Promise<InputEventResult | undefined> => {
    const { mentions } = extractMentions(event.text);
    if (mentions.length === 0) return;

    const cwd = ctx.cwd;
    const attachments: AttachmentMeta[] = [];
    const images: ImageContent[] = [...(event.images ?? [])];
    const skillBlocks: string[] = [];
    const resolvedPaths = new Set<string>();
    const resolvedSkills = new Set<string>();

    for (const mention of mentions) {
      if (mention.kind === 'skill') {
        if (resolvedSkills.has(mention.name)) continue;
        resolvedSkills.add(mention.name);
        const block = await loadSkillBlock(mention.name, cwd);
        if (block) skillBlocks.push(block);
        continue;
      }

      const { filename } = parseFileReference(mention.ref);
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

    if (
      attachments.length === 0 &&
      skillBlocks.length === 0 &&
      images.length === (event.images?.length ?? 0)
    ) {
      return;
    }

    const cleanText = stripMentions(event.text);
    const context = await renderAttachmentContext(attachments, {
      maxTextChars,
      hasImages: images.length > 0,
    });

    const parts: string[] = [];
    if (skillBlocks.length > 0) parts.push(skillBlocks.join('\n\n'));
    if (cleanText) parts.push(cleanText);
    if (context) parts.push(`<system-reminder>\n${context}\n</system-reminder>`);
    const text = parts.join('\n\n');

    return {
      action: 'transform',
      text,
      ...(images.length > 0 ? { images } : {}),
    };
  });
}

export function extractMentions(content: string): { mentions: Mention[]; raw: string[] } {
  const mentions: Mention[] = [];
  const raw: string[] = [];
  const seenSkills = new Set<string>();
  const seenFiles = new Set<string>();
  const namespaceSpans: Array<[number, number]> = [];

  for (const match of content.matchAll(NAMESPACE_AT_RE)) {
    const ns = match[2]!.toLowerCase();
    const value = match[3]!;
    const start = match.index! + (match[1]?.length ?? 0);
    namespaceSpans.push([start, start + 1 + ns.length + 1 + value.length]);
    if (ns === SKILL_NAMESPACE) {
      if (!seenSkills.has(value)) {
        seenSkills.add(value);
        mentions.push({ kind: 'skill', name: value });
        raw.push(`@${ns}:${value}`);
      }
    }
  }

  const isInsideNamespace = (start: number, end: number) =>
    namespaceSpans.some(([s, e]) => start >= s && end <= e);

  for (const match of content.matchAll(QUOTED_AT_RE)) {
    const value = match[2]!;
    const start = match.index! + (match[1]?.length ?? 0);
    const end = start + 2 + value.length + 1;
    if (isInsideNamespace(start, end)) continue;
    if (!seenFiles.has(value)) {
      seenFiles.add(value);
      mentions.push({ kind: 'file', ref: value });
      raw.push(`@"${value}"`);
    }
  }

  for (const match of content.matchAll(REGULAR_AT_RE)) {
    const value = match[2]!;
    const start = match.index! + (match[1]?.length ?? 0);
    const end = start + 1 + value.length;
    if (isInsideNamespace(start, end)) continue;
    if (value.startsWith('http')) continue;
    if (seenFiles.has(value)) continue;
    seenFiles.add(value);
    mentions.push({ kind: 'file', ref: value });
    raw.push(`@${value}`);
  }

  return { mentions, raw };
}

export function stripMentions(content: string): string {
  return content
    .replace(NAMESPACE_AT_RE, '$1')
    .replace(QUOTED_AT_RE, '$1')
    .replace(REGULAR_AT_RE, '$1')
    .trim();
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

/**
 * Search order for `@skill:<name>`: project-level (`<cwd>/.pi/skills`) before
 * user-level (`<agentDir>/skills`). Matches `loadSkillsFromAllLocations` in
 * the pi-coding-agent SDK so a project skill overrides a user-installed one.
 */
export function skillSearchPaths(name: string, cwd: string): string[] {
  const projectDir = path.resolve(cwd, '.pi', 'skills', name);
  const userDir = path.resolve(resolveAgentDir(), 'skills', name);
  return [projectDir, userDir].map((dir) => path.join(dir, 'SKILL.md'));
}

async function loadSkillBlock(name: string, cwd: string): Promise<string | undefined> {
  for (const filePath of skillSearchPaths(name, cwd)) {
    try {
      const content = await readFile(filePath, 'utf8');
      const baseDir = path.dirname(filePath);
      const body = stripFrontmatter(content).trim();
      return [
        `<skill name="${escapeXmlAttribute(name)}" location="${escapeXmlAttribute(filePath)}">`,
        `References are relative to ${baseDir}.`,
        '',
        body,
        '</skill>',
      ].join('\n');
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const close = content.indexOf('\n---', 3);
  if (close === -1) return content;
  const after = close + '\n---'.length;
  return content.slice(content[after] === '\n' ? after + 1 : after);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
