export class ProfileAlreadyOwnedError extends Error {
  constructor(readonly exitCode: 0 | 1) {
    super('Another DNAForge instance owns this profile.');
    this.name = 'ProfileAlreadyOwnedError';
  }
}
