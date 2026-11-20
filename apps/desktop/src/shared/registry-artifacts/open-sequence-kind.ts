import { entityKindNoun } from '@waypoint/scientific-artifacts/shared/entity-types';
import type { LimsEntityKind } from '../lims';

export const REGISTERABLE_OPEN_SEQUENCE_KINDS = [
  'sequence',
] as const satisfies readonly LimsEntityKind[];
export type RegisterableOpenSequenceKind = (typeof REGISTERABLE_OPEN_SEQUENCE_KINDS)[number];

export function isRegisterableOpenSequenceKind(
  kind: LimsEntityKind | string | null | undefined
): kind is RegisterableOpenSequenceKind {
  return REGISTERABLE_OPEN_SEQUENCE_KINDS.includes(kind as RegisterableOpenSequenceKind);
}

export function registryImportKindNoun(kind: string, plural = false): string {
  return entityKindNoun(kind === 'sequence' ? 'dna_sequence' : kind, plural);
}
