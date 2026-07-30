import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { VideoGenError } from './errors.js';
import type { OverlayPosition, TimelineOverlay } from './timeline.js';

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
