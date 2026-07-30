import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { VideoGenError } from './errors.js';
import type { OverlayPosition, TimelineOverlay, TimelineSubtitles } from './timeline.js';

/**
 * Text overlay rendering (C1): SVG template → PNG overlay via sharp.
 *
 * Chinese text is rendered by the LOCAL font stack (model never writes
 * pixels — that's the Codex/hypeframes lesson: model-generated CJK text
 * comes out garbled). Positioning follows Remotion's video-layout rule of a
 * ~8% safe margin.
 */

const FONT_STACK = 'PingFang SC, Hiragana Sans GB, Microsoft YaHei, Noto Sans CJK SC, sans-serif';
const SAFE_MARGIN_RATIO = 0.08;

export function hasCjkFont(): boolean {
  const listed = spawnSync('fc-list', [':lang=zh-cn', 'family'], {
    encoding: 'utf-8',
    timeout: 2_000,
  });
  if (listed.status === 0 && listed.stdout.trim()) return true;

  const windowsFonts = process.env.WINDIR ? join(process.env.WINDIR, 'Fonts') : '';
  return [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    windowsFonts && join(windowsFonts, 'msyh.ttc'),
    windowsFonts && join(windowsFonts, 'simsun.ttc'),
  ].some((path) => path !== '' && existsSync(path));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function estimatedTextWidth(text: string, fontSize: number): number {
  return Array.from(text).reduce((width, char) => {
    if (/\s/u.test(char)) return width + fontSize * 0.33;
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(
        char,
      ) ||
      /[MWmw@%&]/u.test(char)
    ) {
      return width + fontSize;
    }
    if (/[A-Z0-9]/u.test(char)) return width + fontSize * 0.75;
    return width + fontSize * 0.62;
  }, 0);
}

function wrapSubtitleLines(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const token of paragraph.match(/\s+|[^\s]+/gu) ?? []) {
      const candidate = line + token;
      if (line.trim() && estimatedTextWidth(candidate, fontSize) > maxWidth) {
        lines.push(line.trim());
        line = token.trimStart();
      } else {
        line = candidate;
      }
      while (estimatedTextWidth(line, fontSize) > maxWidth) {
        const chars = Array.from(line);
        let cut = 1;
        while (
          cut < chars.length &&
          estimatedTextWidth(chars.slice(0, cut + 1).join(''), fontSize) <= maxWidth
        ) {
          cut += 1;
        }
        lines.push(chars.slice(0, cut).join('').trim());
        line = chars.slice(cut).join('').trimStart();
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

function positionFor(
  pos: OverlayPosition | undefined,
  width: number,
  height: number,
  blockH: number,
): { x: number; y: number; anchor: 'start' | 'middle' } {
  const marginX = Math.round(width * SAFE_MARGIN_RATIO);
  const marginY = Math.round(height * SAFE_MARGIN_RATIO);
  if (pos === 'bottom-center') {
    return { x: Math.round(width / 2), y: height - marginY - blockH, anchor: 'middle' };
  }
  if (pos === 'top-left') {
    return { x: marginX, y: marginY, anchor: 'start' };
  }
  if (pos === 'center') {
    return { x: Math.round(width / 2), y: Math.round((height - blockH) / 2), anchor: 'middle' };
  }
  return { x: marginX, y: height - marginY - blockH, anchor: 'start' };
}

function overlaySvg(overlay: TimelineOverlay, width: number, height: number): string {
  const titleSize = Math.max(28, Math.round(height * 0.055));
  const subtitleSize = Math.max(20, Math.round(height * 0.032));
  const lineGap = Math.round(titleSize * 0.5);
  const blockH =
    (overlay.title ? titleSize : 0) +
    (overlay.title && overlay.subtitle ? lineGap : 0) +
    (overlay.subtitle ? subtitleSize : 0);
  const { x, y, anchor } = positionFor(overlay.position, width, height, blockH);

  const lines: string[] = [];
  let cursorY = y + titleSize;
  if (overlay.title) {
    lines.push(
      `<text x="${x}" y="${cursorY}" font-size="${titleSize}" font-weight="700" fill="#ffffff" text-anchor="${anchor}" font-family="${FONT_STACK}">${escapeXml(overlay.title)}</text>`,
    );
    cursorY += lineGap + (overlay.subtitle ? subtitleSize : 0);
  }
  if (overlay.subtitle) {
    lines.push(
      `<text x="${x}" y="${cursorY}" font-size="${subtitleSize}" font-weight="400" fill="rgba(255,255,255,0.85)" text-anchor="${anchor}" font-family="${FONT_STACK}">${escapeXml(overlay.subtitle)}</text>`,
    );
  }

  // Soft dark plate behind the text block for legibility over any image.
  const platePad = Math.round(titleSize * 0.45);
  const plateY = y - platePad;
  const plateH = blockH + platePad * 2;
  const plate = `<rect x="0" y="${plateY}" width="${width}" height="${plateH}" fill="rgba(0,0,0,0.32)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${plate}${lines.join('')}</svg>`;
}

/** Render an overlay to a PNG with alpha, sized to the video frame. */
export async function renderTextOverlay(opts: {
  overlay: TimelineOverlay;
  width: number;
  height: number;
  outPath: string;
}): Promise<string | null> {
  if (!opts.overlay.title && !opts.overlay.subtitle) return null;
  const text = `${opts.overlay.title ?? ''}${opts.overlay.subtitle ?? ''}`;
  if (/\p{Script=Han}/u.test(text) && !hasCjkFont()) {
    throw new VideoGenError(
      'A CJK font is required for Chinese text overlays. Install PingFang, Microsoft YaHei, Noto Sans CJK, or WenQuanYi, then retry.',
      'text-layer: CJK font missing',
    );
  }
  const svg = overlaySvg(opts.overlay, opts.width, opts.height);
  // Render the SVG at ~2x density for crisp text, then downscale to frame size.
  await sharp(Buffer.from(svg, 'utf-8'), { density: 150 })
    .resize(opts.width, opts.height)
    .png()
    .toFile(opts.outPath);
  return opts.outPath;
}

/** Render one narration cue as a branded, bottom-centered burned subtitle. */
export async function renderBurnedSubtitle(opts: {
  text: string;
  style: TimelineSubtitles;
  width: number;
  height: number;
  outPath: string;
}): Promise<string> {
  if (/\p{Script=Han}/u.test(opts.text) && !hasCjkFont()) {
    throw new VideoGenError(
      'A CJK font is required for burned Chinese subtitles. Install PingFang, Microsoft YaHei, Noto Sans CJK, or WenQuanYi, then retry.',
      'text-layer: CJK font missing',
    );
  }
  const fontSize = opts.style.fontSize ?? Math.max(20, Math.round(opts.height * 0.032));
  const lineHeight = Math.round(fontSize * 1.35);
  const margin = Math.round(opts.height * SAFE_MARGIN_RATIO);
  const padding = Math.round(fontSize * 0.5);
  const lines = wrapSubtitleLines(opts.text, fontSize, opts.width - margin * 2 - padding * 2);
  const blockHeight = Math.max(1, lines.length) * lineHeight;
  if (blockHeight + padding * 2 > opts.height - margin * 2) {
    throw new VideoGenError(
      'Burned subtitle text is too long to fit the video frame. Shorten the narration or reduce subtitles.fontSize.',
      'text-layer: subtitle too long',
    );
  }
  const plateY = opts.height - margin - blockHeight - padding;
  const textY = plateY + padding + fontSize;
  const textColor = opts.style.textColor ?? '#ffffff';
  const backgroundColor = opts.style.backgroundColor ?? '#000000';
  const backgroundOpacity = opts.style.backgroundOpacity ?? 0.55;
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${Math.round(opts.width / 2)}" y="${textY + index * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}">
    <rect x="0" y="${plateY}" width="${opts.width}" height="${blockHeight + padding * 2}" fill="${backgroundColor}" fill-opacity="${backgroundOpacity}"/>
    <text font-size="${fontSize}" font-weight="500" fill="${textColor}" text-anchor="middle" font-family="${FONT_STACK}">${tspans}</text>
  </svg>`;
  await sharp(Buffer.from(svg, 'utf-8'), { density: 150 })
    .resize(opts.width, opts.height)
    .png()
    .toFile(opts.outPath);
  return opts.outPath;
}
