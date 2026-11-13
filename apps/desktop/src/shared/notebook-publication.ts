export type NotebookPublicationState =
  | { status: 'settled'; canonicalFingerprint: string; projectionFingerprint: string }
  | { status: 'conflict'; canonicalFingerprint: string; reason: string }
  | { status: 'pending'; canonicalFingerprint: string; reason: string };
