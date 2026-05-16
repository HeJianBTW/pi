export {
  type AttachmentDependencyCheck,
  checkAttachmentHostDependencies,
} from './diagnostics.js';
export {
  AttachmentValidationError,
  normalizeAttachments,
} from './normalize.js';
export { renderAttachmentPrompt } from './prompt.js';
export { handleAttachmentRoutes } from './routes.js';
export {
  type AttachmentService,
  createAttachmentService,
} from './service.js';
export type {
  AttachmentContext,
  AttachmentFailure,
  AttachmentServiceConfig,
  AttachmentSource,
  ChatAttachmentInput,
  NormalizedAttachment,
  PreparedAttachmentBundle,
  StoredAttachmentRecord,
} from './types.js';
export type { AttachmentUploadAuth } from './upload-proxy.js';
