import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { isTextLikeAttachment } from './classify.js';
import type { ParseAttachmentInput, ParsedAttachment } from './types.js';

export interface AttachmentParser {
  parse(input: ParseAttachmentInput): Promise<ParsedAttachment>;
}

export class BasicAttachmentParser implements AttachmentParser {
  async parse(input: ParseAttachmentInput): Promise<ParsedAttachment> {
    if (isPptxAttachment(input.name, input.mimeType)) {
      return parsePptxText(input.path);
    }
    if (isLegacyPptAttachment(input.name, input.mimeType)) {
      return parseLegacyPptText(input.path);
    }
    if (!isTextLikeAttachment(input.name, input.mimeType)) {
      throw new Error(`No basic parser available for ${input.name}`);
    }
    const raw = await readFile(input.path, 'utf8');
    if (isDelimitedFile(input.name, input.mimeType)) {
      return {
        text: delimitedTextToMarkdown(raw, input.name.toLowerCase().endsWith('.tsv') ? '\t' : ','),
      };
    }
    return { text: raw };
  }
}

export class LiteParseAttachmentParser implements AttachmentParser {
  private readonly fallback = new BasicAttachmentParser();

  async parse(input: ParseAttachmentInput): Promise<ParsedAttachment> {
    if (isPptxAttachment(input.name, input.mimeType)) {
      return parsePptxText(input.path);
    }
    if (isTextLikeAttachment(input.name, input.mimeType)) {
      return this.fallback.parse(input);
    }
    const { LiteParse } = await import('@llamaindex/liteparse');
    const parser = new LiteParse({
      outputFormat: input.format ?? 'text',
      ocrEnabled: input.ocr !== 'off',
      maxPages: input.maxPages,
      preciseBoundingBox: input.format === 'json',
    });
    try {
      const result = await parser.parse(input.path, true);
      return {
        text: result.text,
        pageCount: result.pages.length,
      };
    } catch (error) {
      if (isLegacyPptAttachment(input.name, input.mimeType)) {
        return parseLegacyPptText(input.path);
      }
      throw error;
    }
  }
}

function isDelimitedFile(name: string, mimeType: string | undefined): boolean {
  const lowerMime = mimeType?.toLowerCase();
  return (
    lowerMime === 'text/csv' ||
    lowerMime === 'application/csv' ||
    lowerMime === 'text/tab-separated-values' ||
    /\.(csv|tsv)$/i.test(name)
  );
}

function isPptxAttachment(name: string, mimeType: string | undefined): boolean {
  const lowerMime = mimeType?.split(';')[0]?.trim().toLowerCase();
  return (
    lowerMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    /\.pptx$/i.test(name)
  );
}

function isLegacyPptAttachment(name: string, mimeType: string | undefined): boolean {
  const lowerMime = mimeType?.split(';')[0]?.trim().toLowerCase();
  return lowerMime === 'application/vnd.ms-powerpoint' || /\.ppt$/i.test(name);
}

async function parsePptxText(filePath: string): Promise<ParsedAttachment> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const slideEntries = Object.values(zip.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
  const slides: string[] = [];
  for (const entry of slideEntries) {
    const xml = await entry.async('text');
    const textRuns = extractPresentationText(xml);
    const text = textRuns.join('\n').trim();
    if (text) {
      slides.push(`Slide ${slideNumber(entry.name)}:\n${text}`);
    }
  }
  return {
    text: slides.join('\n\n') || '[No readable text found in presentation slides]',
    pageCount: slideEntries.length,
  };
}

async function parseLegacyPptText(filePath: string): Promise<ParsedAttachment> {
  const data = await readFile(filePath);
  const text =
    data
      .toString('latin1')
      .match(/[ -~\t]{4,}/g)
      ?.map((value) => value.trim())
      .filter((value, index, all) => value.length > 3 && all.indexOf(value) === index)
      .slice(0, 400)
      .join('\n') ?? '';
  return {
    text: text || '[No readable text found in legacy PowerPoint file]',
  };
}

function slideNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
}

function extractPresentationText(xml: string): string[] {
  return [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXmlText(match[1] ?? '').trim())
    .filter(Boolean);
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function delimitedTextToMarkdown(value: string, delimiter: string): string {
  const rows = value
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => splitDelimitedLine(line, delimiter));
  if (rows.length === 0) {
    return '';
  }
  const width = Math.max(...rows.map((row) => row.length), 1);
  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_value, index) => formatMarkdownCell(row[index])),
  );
  const header = normalized[0] ?? [];
  const body = normalized.slice(1);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function formatMarkdownCell(value: string | undefined): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}
