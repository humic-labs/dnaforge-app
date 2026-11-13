export type NativeDocumentPartialEffect = string | Readonly<Record<string, unknown>>;

export class NativeDocumentCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stateChanged: boolean | 'unknown',
    readonly partialEffects: readonly NativeDocumentPartialEffect[] = []
  ) {
    super(`${code}: ${message}`);
    this.name = 'NativeDocumentCommandError';
  }
}
