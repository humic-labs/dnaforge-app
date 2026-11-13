import { withUserMessage } from '@waypoint/user-messages';
export class SavedDocumentCompletionError extends Error {
  constructor(
    message: string,
    readonly complete: () => Promise<void>,
    readonly saveConfirmed = true
  ) {
    super(message);
    this.name = 'SavedDocumentCompletionError';
    withUserMessage(
      this,
      saveConfirmed ? 'document.saveRefreshPending' : 'document.saveUnconfirmed'
    );
  }
}

export class UnconfirmedDocumentSaveError extends SavedDocumentCompletionError {
  constructor(message: string, complete: () => Promise<void>) {
    super(message, complete, false);
    this.name = 'UnconfirmedDocumentSaveError';
  }
}
