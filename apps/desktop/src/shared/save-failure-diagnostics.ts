const knownSaveErrors = new Set([
  'EACCES',
  'EPERM',
  'EIO',
  'ENOSPC',
  'EBUSY',
  'ENOENT',
  'EROFS',
  'ENOTDIR',
  'EMFILE',
  'ENFILE',
  'EXDEV',
  'FILE_DOCUMENT_CLIENT_NOT_READY',
  'RECOVERY_DECISION_REQUIRED',
  'STALE_FILE_DOCUMENT',
  'DIRTY_FILE_DRAFT',
  'FILE_DOCUMENT_BUSY',
  'FILE_SAVE_CAPTURE_LIMIT',
  'DOCUMENT_OPERATION_UNSUPPORTED',
  'DOCUMENT_ADMISSION_FAILED',
  'FILE_DOCUMENT_LEGACY_TARGET_UNSUPPORTED',
  'NOTEBOOK_EXTERNAL_CONFLICT',
  'NOTEBOOK_SAVE_FAILED',
  'NOTEBOOK_READ_ONLY',
]);

export function saveFailureErrorCode(error: unknown): string {
  try {
    let current = error;
    for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
      const code =
        current && typeof current === 'object'
          ? Object.getOwnPropertyDescriptor(current, 'code')?.value
          : undefined;
      if (typeof code === 'string' && knownSaveErrors.has(code)) return code.toLowerCase();
      const message =
        current instanceof Error ? current.message : typeof current === 'string' ? current : '';
      const unwrapped = message
        .replace(/^Error invoking remote method '[^'\n]{1,128}':\s*/, '')
        .replace(/^(?:Error:\s*){1,3}/, '');
      const prefix = /^([A-Z][A-Z0-9_]+)(?::|\s|$)/.exec(unwrapped)?.[1];
      if (prefix && knownSaveErrors.has(prefix)) return prefix.toLowerCase();
      current =
        current && typeof current === 'object'
          ? Object.getOwnPropertyDescriptor(current, 'cause')?.value
          : undefined;
    }
    return 'save_failed';
  } catch {
    return 'save_failed';
  }
}

export function saveFailureProperties(error: unknown, operationId: string) {
  return {
    feature_area: 'reliability',
    workflow: 'file',
    workflow_action: 'save',
    action_id: operationId,
    operation_id: operationId,
    effect_id: operationId,
    action_phase: 'error',
    workflow_status: 'failed',
    error_class: saveFailureErrorCode(error),
    occurred_at_ms: Date.now(),
    success: false,
  };
}
