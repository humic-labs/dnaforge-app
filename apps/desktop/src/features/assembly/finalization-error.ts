import type { ToolErrorReasonCode } from '../../shared/tool-error-reasons';

export class FinalizationPreconditionError extends Error {
  override readonly name = 'FinalizationPreconditionError';

  constructor(
    readonly reason: Extract<
      ToolErrorReasonCode,
      'stale_design' | 'draft_required' | 'output_exists'
    >,
    message: string
  ) {
    super(message);
  }
}

export function isFinalizationFilesystemError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const codes = new Set([
    'EACCES',
    'EPERM',
    'ENOENT',
    'EEXIST',
    'ENOSPC',
    'ENOTDIR',
    'EISDIR',
    'EROFS',
    'EIO',
    'EMFILE',
    'ENFILE',
    'ENAMETOOLONG',
    'EBUSY',
    'EXDEV',
  ]);
  if ('code' in error && typeof error.code === 'string' && codes.has(error.code)) return true;
  if ('message' in error && typeof error.message === 'string') {
    const code = error.message.match(/(?:^|Error: )([A-Z]+):/u)?.[1];
    return code !== undefined && codes.has(code);
  }
  return false;
}
