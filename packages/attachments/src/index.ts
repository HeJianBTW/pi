export {
  AttachmentValidationError,
  normalizeAttachments,
} from "./normalize.js";
export {
  createAttachmentService,
  type AttachmentService,
} from "./service.js";
export {
  renderAttachmentPrompt,
} from "./prompt.js";
export {
  handleAttachmentRoutes,
} from "./routes.js";
export type {
  AttachmentUploadAuth,
} from "./upload-proxy.js";
export {
  checkAttachmentHostDependencies,
  type AttachmentDependencyCheck,
} from "./diagnostics.js";
export type {
  AttachmentContext,
  AttachmentFailure,
  AttachmentServiceConfig,
  AttachmentSource,
  ChatAttachmentInput,
  NormalizedAttachment,
  PreparedAttachmentBundle,
  StoredAttachmentRecord,
} from "./types.js";
