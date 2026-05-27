/**
 * Pi Attachments Extension
 *
 * Intercepts prompts with attachment metadata markers and renders
 * file contents into the prompt as context for the LLM.
 *
 * The server injects a `<pi-attachments>` XML block containing attachment
 * metadata (id, name, path, mimeType). This extension parses that block,
 * reads/classifies the files, and replaces the marker with rendered content.
 */
import type { BeforeAgentStartEventResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type AttachmentMeta, renderAttachmentContext } from './classify.js';

const ATTACHMENTS_TAG_RE = /<pi-attachments>([\s\S]*?)<\/pi-attachments>/;
const ATTACHMENT_ENTRY_RE = /<attachment\s+([^>]*)\/>/g;

export default function piAttachmentsExtension(pi: ExtensionAPI): void {
  const maxTextChars = Number(process.env.PI_ATTACHMENT_MAX_TEXT_CHARS) || 128_000;

  pi.on(
    'before_agent_start',
    async (event, _ctx): Promise<BeforeAgentStartEventResult | undefined> => {
      const match = ATTACHMENTS_TAG_RE.exec(event.prompt);
      if (!match) return;

      const attachmentsXml = match[1]!;
      const attachments = parseAttachmentEntries(attachmentsXml);
      if (attachments.length === 0) return;

      const hasImages = event.images !== undefined && event.images.length > 0;
      const context = await renderAttachmentContext(attachments, { maxTextChars, hasImages });
      if (!context) return;

      const reminder = `<system-reminder>\n${context}\n</system-reminder>`;

      return {
        message: {
          customType: 'attachment_context',
          content: reminder,
          display: false,
          details: { attachmentCount: attachments.length },
        },
      };
    },
  );
}

function parseAttachmentEntries(xml: string): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  for (const match of xml.matchAll(ATTACHMENT_ENTRY_RE)) {
    const attrs = parseXmlAttributes(match[1]!);
    if (!attrs.id || !attrs.name) continue;
    attachments.push({
      id: attrs.id,
      name: attrs.name,
      ...(attrs.path ? { path: attrs.path } : {}),
      ...(attrs.mimeType ? { mimeType: attrs.mimeType } : {}),
      ...(attrs.url ? { url: attrs.url } : {}),
      ...(attrs.size ? { size: Number(attrs.size) } : {}),
    });
  }
  return attachments;
}

function parseXmlAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of attrString.matchAll(/(\w+)="([^"]*)"/g)) {
    attrs[m[1]!] = m[2]!
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
  }
  return attrs;
}
