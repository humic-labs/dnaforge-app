let qualificationEphemeralAuthSourceCommit: string | null = null;

export function configureQualificationEphemeralAuth(sourceCommit: string | null): void {
  if (sourceCommit === null) return;
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('qualification ephemeral auth source must be one full lowercase Git SHA');
  }
  if (
    qualificationEphemeralAuthSourceCommit !== null &&
    qualificationEphemeralAuthSourceCommit !== sourceCommit
  ) {
    throw new Error('qualification ephemeral auth cannot change source during one process');
  }
  qualificationEphemeralAuthSourceCommit = sourceCommit;
}

export function isQualificationEphemeralAuthEnabled(): boolean {
  return qualificationEphemeralAuthSourceCommit !== null;
}
