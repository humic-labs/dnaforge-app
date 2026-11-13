import { buildFileDnaSequenceRef } from './dna-sequence';
import { emitLimsRegistrationChanged } from './events';
export { emitLimsRegistrationChanged, subscribeLimsRegistryChanged } from './events';
import {
  getLimsRegistrationBadgeCandidates,
  logLimsTelemetry,
  registerLimsEntity,
} from './operations';
import type { LimsEntity } from '../../shared/lims';

import type { RegisterableOpenSequenceKind } from './open-sequence-kind';
export {
  REGISTERABLE_OPEN_SEQUENCE_KINDS,
  isRegisterableOpenSequenceKind,
  type RegisterableOpenSequenceKind,
} from './open-sequence-kind';

export interface RegisterOpenSequenceFileInput {
  documentId: string;
  sourcePath: string;
  kind: RegisterableOpenSequenceKind;
  actor?: string | null;
}

export interface RegisterOpenSequenceFileResult {
  entity: LimsEntity;
  alreadyRegistered: boolean;
}

export async function registerOpenSequenceFile(
  input: RegisterOpenSequenceFileInput
): Promise<RegisterOpenSequenceFileResult> {
  const documentId = input.documentId.trim();
  const sourcePath = input.sourcePath.trim();
  if (!documentId) {
    throw new Error('No open sequence document to register.');
  }
  if (!sourcePath) {
    throw new Error('No open sequence file to register.');
  }
  if (!input.kind) {
    throw new Error('Choose a LIMS registration type before registering this sequence.');
  }

  const existing = (await getLimsRegistrationBadgeCandidates({ documentId }))[0];
  if (existing) {
    emitLimsRegistrationChanged({ documentId, entityId: existing.entity.id });
    await logRegisterConsult(documentId, existing.entity.id, true);
    return { entity: existing.entity, alreadyRegistered: true };
  }

  const sequence = await buildFileDnaSequenceRef(sourcePath, { documentId });
  const entity = await registerLimsEntity({
    kind: input.kind,
    name: sequenceEntityNameFromPath(sourcePath),
    fields: {
      sequence,
      ...defaultFieldsForKind(input.kind),
      notes: 'Registered from the open sequence tab.',
    },
    registrationStatus: 'registered',
    actor: input.actor ?? 'local-user',
  });

  emitLimsRegistrationChanged({ documentId, entityId: entity.id });
  await logRegisterConsult(documentId, entity.id, false);
  return { entity, alreadyRegistered: false };
}

export function sequenceEntityNameFromPath(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop()?.trim() ?? '';
  const stem = fileName.replace(/\.(?:gb|gbk|genbank|fa|fasta|fna|ffn)$/i, '');
  return stem || fileName || 'Sequence';
}

function defaultFieldsForKind(_kind: RegisterableOpenSequenceKind): Record<string, unknown> {
  return {};
}

async function logRegisterConsult(
  documentId: string,
  entityId: string,
  alreadyRegistered: boolean
): Promise<void> {
  await logLimsTelemetry({
    eventType: 'register_consulted',
    subjectTable: 'lims_entity',
    subjectId: entityId,
    payload: { documentId, alreadyRegistered },
    actor: 'local-user',
  }).catch(() => undefined);
}
