export class MolViewSpecSceneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stateChanged: boolean | 'unknown' = false
  ) {
    super(message);
    this.name = 'MolViewSpecSceneError';
  }
}
