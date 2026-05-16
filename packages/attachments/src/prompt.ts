import type { PreparedAttachmentBundle } from './types.js';

export function renderAttachmentPrompt(message: string, bundle: PreparedAttachmentBundle): string {
  if (bundle.attachments.length === 0) {
    return message;
  }
  const blocks =
    bundle.promptBlocks.length > 0 ? bundle.promptBlocks : ['No attachment content was available.'];
  const currentTurnImageGuidance =
    bundle.images.length > 0
      ? [
          'Current-turn image inputs are attached as model-visible image content.',
          'Ignore stale earlier statements that images were unsupported, unavailable, or could only be inspected with file tools.',
        ].join(' ')
      : undefined;
  return [
    message,
    '',
    'Uploaded attachments for this turn:',
    currentTurnImageGuidance,
    blocks.join('\n\n---\n\n'),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function attachmentHeader(input: {
  index: number;
  name: string;
  mimeType?: string;
  size?: number;
}): string {
  return [
    `Attachment ${input.index + 1}: ${input.name}`,
    input.mimeType ? `mimeType=${input.mimeType}` : undefined,
    input.size !== undefined ? `size=${input.size}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n\n[truncated after ${maxChars} characters]`;
}
