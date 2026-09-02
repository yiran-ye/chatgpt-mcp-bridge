export type ErrorCode =
  | 'INVALID_INPUT' | 'WORKSPACE_NOT_FOUND' | 'NOT_A_GIT_REPOSITORY'
  | 'PATH_OUTSIDE_WORKSPACE' | 'PATH_BLOCKED' | 'SENSITIVE_FILE' | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE' | 'BINARY_FILE' | 'INVALID_GIT_REF' | 'GIT_COMMAND_FAILED'
  | 'SEARCH_TOOL_UNAVAILABLE' | 'OUTPUT_LIMIT_EXCEEDED' | 'INVALID_CURSOR'
  | 'UNAUTHORIZED' | 'ORIGIN_NOT_ALLOWED' | 'TIMEOUT' | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = 'AppError'; }
}

export function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL_ERROR', '操作失败，服务器已隐藏内部细节');
}
