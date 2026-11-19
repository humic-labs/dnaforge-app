import type { NativeDirtySettlementResult } from './native-dirty-documents';

export type SaveAllResult =
  | { status: 'saved' }
  | { status: 'cancelled' }
  | { status: 'failed'; failures: NativeDirtySettlementResult['failures'] };

export class SaveAllCancelled extends Error {
  constructor() {
    super('Saving the edited copy was cancelled.');
    this.name = 'SaveAllCancelled';
  }
}

export class SaveAllError extends Error {
  constructor(readonly failures: NativeDirtySettlementResult['failures']) {
    super(
      failures.map((failure) => failure.error).join('\n') ||
        'Some documents still have unsaved work.'
    );
    this.name = 'SaveAllError';
  }
}

export function failedSaveAllResult(error: unknown): Extract<SaveAllResult, { status: 'failed' }> {
  return {
    status: 'failed',
    failures:
      error instanceof SaveAllError && error.failures.length
        ? error.failures
        : [{ documentId: null, error: error instanceof Error ? error.message : String(error) }],
  };
}
