import type { AcceptedAssemblyVersion } from '../assembly/public/accepted-types';
import type { DesignPrimer } from '../design/public/types';
import { archiveLimsEntity, queryLimsEntities } from './operations';
import type { LimsEntity } from '../../shared/lims';
import {
  assemblyPrimerAnnealing,
  assemblyPrimerArtifactStem,
} from '../assembly/public/primer-artifacts';
import type { SequencePackageDocument } from '../../db/sequence-package';
import { resolveWorkspaceId, resolveWorkspaceScope } from '../../db/workspace-catalog';
import { platform } from '../../platform';
import { locateSequencePackageMetaPath } from '../../db/sequence-package-io';
import { sequencePackageEntityAdapter } from '../../db/entity-substrate/sequence-package-adapter';
import { reconcileEntitySnapshot } from '../../db/entity-substrate/adapter';
import { sequencePackageProjectionContent } from '../../shared/sequence-package-projection';
import { canonicalEntityArtifactValue } from '../../shared/entity-artifact-projection';
import { entitySchemaRevisionContent } from '../../shared/entity-schema';
import {
  recordPrimers,
  type RecordablePrimer,
  type RecordPrimersResult,
} from '../primers/public/record-primers';

function recordableAssemblyPrimers(acceptedVersion: AcceptedAssemblyVersion): DesignPrimer[] {
  return acceptedVersion.projectionInput.designPrimers
    .flatMap((primerPair) => [primerPair.forward, primerPair.reverse])
    .filter((primer) => primer.sequence.trim().length > 0);
}

export function hasRecordableAssemblyPrimers(acceptedVersion: AcceptedAssemblyVersion): boolean {
  return recordableAssemblyPrimers(acceptedVersion).length > 0;
}

export async function recordAcceptedAssemblyPrimers(input: {
  acceptedVersion: AcceptedAssemblyVersion;
  workspaceRoot: string;

  alreadySavedPrimerIds?: ReadonlySet<string>;

  actor?: string | null;
  mutationToken?: string;
  parentActionId?: string;
}): Promise<RecordPrimersResult> {
  const recordable = recordableAssemblyPrimers(input.acceptedVersion).filter(
    (primer) => !input.alreadySavedPrimerIds?.has(primer.id)
  );
  if (recordable.length === 0) return { recorded: [], skipped: [], failed: [] };

  const primers: RecordablePrimer[] = await Promise.all(
    recordable.map(async (primer) => ({
      name: primer.name,
      sequence: primer.sequence,
      ...(primer.oligo ? { oligo: primer.oligo } : {}),
      annealing: assemblyPrimerAnnealing(primer),
      tm: primer.tm,
      application: 'pcr' as const,
      artifactStem: await assemblyPrimerArtifactStem(primer),
    }))
  );

  return recordPrimers({
    primers,
    workspaceRoot: input.workspaceRoot,
    origin: 'assembly',
    parentActionId: input.parentActionId,
    deferCommit: true,
    ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
  });
}

export async function registerAcceptedAssemblyAsLimsEntity(input: {
  packageDocument: SequencePackageDocument;
  productGenBankContent: string;
  packageRoot: string;
  workspaceRoot: string | null;
  actor?: string | null;
  mutationToken?: string;
  parentActionId?: string;
}): Promise<LimsEntity> {
  const { packageDocument } = input;
  const options = {
    mutationToken: input.mutationToken,
    workflowOrigin: 'projection' as const,
    parentActionId: input.parentActionId,
  };
  const kind = packageDocument.entity.schema.name || 'sequence';
  const workspaceId = await resolveWorkspaceId(input.workspaceRoot);
  const workspaceScope = await resolveWorkspaceScope(input.workspaceRoot);
  if (workspaceId == null || !input.workspaceRoot || !workspaceScope) {
    throw new Error('An accepted assembly projection requires its published project owner.');
  }
  const fs = platform().fs;
  const path = await locateSequencePackageMetaPath(input.packageRoot, fs.exists);
  if (!path || !sequencePackageEntityAdapter.parseSource) {
    throw new Error('The accepted assembly package source is unavailable.');
  }
  const [bytes, stat] = await Promise.all([fs.readTextFile(path), fs.stat(path)]);
  const context = {
    workspaceRoot: input.workspaceRoot,
    workspaceId,
    workspaceScope,
    mutationToken: input.mutationToken,
  };
  const source = await sequencePackageEntityAdapter.parseSource(bytes, path, stat.mtime, context);
  if (
    source.document.id !== packageDocument.id ||
    source.document.product.file !== packageDocument.product.file ||
    sequencePackageProjectionContent(source.document) !==
      sequencePackageProjectionContent(packageDocument) ||
    JSON.stringify(
      canonicalEntityArtifactValue(entitySchemaRevisionContent(source.document.entity.schema))
    ) !==
      JSON.stringify(
        canonicalEntityArtifactValue(entitySchemaRevisionContent(packageDocument.entity.schema))
      )
  ) {
    throw new Error('The published package no longer matches the accepted assembly source.');
  }
  const existing = await queryLimsEntities({
    id: packageDocument.id,
    includeArchived: true,
    limit: 2,
  });
  if (existing.length > 1) {
    throw new Error(`Accepted assembly identity is ambiguous: ${packageDocument.id}`);
  }
  if (existing[0] && existing[0].kind !== kind) {
    throw new Error(`Accepted assembly identity has the wrong kind: ${packageDocument.id}`);
  }
  const publication = await reconcileEntitySnapshot(
    sequencePackageEntityAdapter,
    source,
    path,
    context,
    { conflictResolution: 'use-file' }
  );
  if (!['created', 'in-sync', 'updated-from-file'].includes(publication.outcome)) {
    throw new Error(`Accepted assembly projection did not converge: ${publication.outcome}`);
  }
  const [result] = await queryLimsEntities({ id: packageDocument.id, limit: 1 });
  if (!result || result.tombstone || result.workspaceId !== workspaceId) {
    throw new Error('The accepted assembly projection is unavailable after publication.');
  }

  for (const acceptedVersionId of acceptedAssemblyVersionIds(packageDocument)) {
    const legacyId = `accepted-assembly-${acceptedVersionId}`;
    if (legacyId === packageDocument.id) continue;
    const legacy = await queryLimsEntities({ id: legacyId, includeArchived: true, limit: 1 });
    if (legacy[0] && !legacy[0].tombstone) {
      await archiveLimsEntity({ id: legacyId, actor: input.actor ?? 'local-user' }, options);
    }
  }
  return result;
}

function acceptedAssemblyVersionIds(packageDocument: SequencePackageDocument): string[] {
  const records = [
    packageDocument.entity.fields,
    packageDocument.assembly?.accepted,
    ...(packageDocument.assembly?.history ?? []),
  ];
  const ids = new Set<string>();
  for (const record of records) {
    const id = record?.acceptedAssemblyVersionId ?? record?.acceptedVersionId;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return [...ids];
}
