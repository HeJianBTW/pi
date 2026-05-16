import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createAttachmentService } from './service.js';
import type { AttachmentServiceConfig } from './types.js';

describe('AttachmentService', () => {
  it('treats SVG uploads as text instead of model image content', async () => {
    const service = createAttachmentService(await testConfig());
    const stored = await service.store.putBuffer({
      data: Buffer.from('<svg><text>Hello SVG</text></svg>'),
      name: 'diagram.svg',
      mimeType: 'image/svg+xml',
      sessionId: 'session-1',
    });

    const bundle = await service.prepareForPrompt(
      [
        {
          id: 'svg-1',
          name: 'diagram.svg',
          mimeType: 'image/svg+xml',
          source: { kind: 'storedFile', attachmentId: stored.attachmentId },
        },
      ],
      { sessionId: 'session-1' },
    );

    expect(bundle.images).toEqual([]);
    expect(bundle.promptBlocks.join('\n')).toContain('Hello SVG');
  });

  it('extracts readable text from PPTX slide XML', async () => {
    const service = createAttachmentService(await testConfig());
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      [
        '<p:sld>',
        '<a:t>Quarterly Review</a:t>',
        '<a:t>Revenue &amp; pipeline are up</a:t>',
        '</p:sld>',
      ].join(''),
    );
    const stored = await service.store.putBuffer({
      data: await zip.generateAsync({ type: 'nodebuffer' }),
      name: 'review.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      sessionId: 'session-1',
    });

    const bundle = await service.prepareForPrompt(
      [
        {
          id: 'pptx-1',
          name: 'review.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          source: { kind: 'storedFile', attachmentId: stored.attachmentId },
        },
      ],
      { sessionId: 'session-1' },
    );

    const prompt = bundle.promptBlocks.join('\n');
    expect(bundle.failures).toEqual([]);
    expect(prompt).toContain('Slide 1:');
    expect(prompt).toContain('Quarterly Review');
    expect(prompt).toContain('Revenue & pipeline are up');
  });

  it('extracts fallback text from legacy PPT files', async () => {
    const service = createAttachmentService(await testConfig());
    const stored = await service.store.putBuffer({
      data: Buffer.from('binary\0\0Legacy PPT Title\0\0Important bullet text\0'),
      name: 'legacy.ppt',
      mimeType: 'application/vnd.ms-powerpoint',
      sessionId: 'session-1',
    });

    const bundle = await service.prepareForPrompt(
      [
        {
          id: 'ppt-1',
          name: 'legacy.ppt',
          mimeType: 'application/vnd.ms-powerpoint',
          source: { kind: 'storedFile', attachmentId: stored.attachmentId },
        },
      ],
      { sessionId: 'session-1' },
    );

    const prompt = bundle.promptBlocks.join('\n');
    expect(bundle.failures).toEqual([]);
    expect(prompt).toContain('Legacy PPT Title');
    expect(prompt).toContain('Important bullet text');
  });
});

async function testConfig(): Promise<AttachmentServiceConfig> {
  return {
    storageMode: 'local',
    uploadEndpoint: '/v1/attachments/upload',
    allowInsecureLocalUploadTls: true,
    localStoreDir: await mkdtemp(join(tmpdir(), 'pi-attachments-')),
    maxAttachmentCount: 10,
    maxBytes: 10 * 1024 * 1024,
    maxTextChars: 100_000,
    fetchTimeoutMs: 1000,
    parseEnabled: true,
    parser: 'basic',
    ocr: 'off',
    maxPages: 20,
    desktopEnabled: true,
  };
}
