export const DEFAULT_MAX_BYTES = 64 * 1024;
export const HARD_MAX_BYTES = 128 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const;
export const WRITE_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
} as const;
export const COMMAND_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
} as const;
