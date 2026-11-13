import { canonicalPrimerReferenceSnapshot } from './primer-reference-contract';
import type { LimsEntity } from '../../shared/lims';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../shared/project-root-selection';
import { normalizePathForBoundary } from '../../shared/path-boundary';
import { getCatalogEntityForWorkspaceRoot, getWorkspaceRootById } from '../../db/workspace-catalog';
import {
  findPrimerRegistryEntityId,
  findPrimerLibraryIdsForRegistryEntityId,
} from '../../db/primer-reference-search';
import { primerServices } from './primer-services';
import type { Primer } from './types';
import type { ReadPrimerArtifactResult } from './primer-artifact-service';

export interface PrimerReferenceRequest {
  id: string;
  workspace?: string;
  bindingId?: string;
  documentId?: string;
  bindingStart?: number;
  bindingEnd?: number;
}

export async function getCanonicalOligoEntity(id: string): Promise<LimsEntity> {
  const entity = await primerServices.persistence.getLimsEntity(id);
  if (
    !entity ||
    entity.tombstone ||
    entity.archivedAt !== null ||
    !['oligo', 'rna_oligo'].includes(entity.kind)
  )
    throw new Error('The reference requires an existing active canonical DNA or RNA oligo.');
  return entity;
}

export async function resolveCanonicalPrimerReference(
  input: PrimerReferenceRequest,
  folders: readonly WorkspaceFolder[]
) {
  const direct = await primerServices.persistence.getLimsEntity(input.id);
  const registryId = direct?.id ?? (await findPrimerRegistryEntityId(input.id));
  if (!registryId)
    throw new Error(
      'The reference requires an existing canonical oligo; inline data cannot create one.'
    );
  const entity = await getCanonicalOligoEntity(registryId);
  const selected = input.workspace ? resolveExplicitProjectRoot(folders, input.workspace) : null;
  if (input.workspace && !selected) throw new Error('Choose an exact mounted source project.');
  const roots = selected ? [selected] : folders;
  const libraryIds = await findPrimerLibraryIdsForRegistryEntityId(entity.id);
  const matches: Array<{ primer: Primer; read: ReadPrimerArtifactResult; root: WorkspaceFolder }> =
    [];
  for (const id of libraryIds) {
    const primer = await primerServices.persistence.getPrimer(id);
    if (!primer || primer.originDetails?.limsEntityId !== entity.id) continue;
    for (const root of roots) {
      const catalog = await getCatalogEntityForWorkspaceRoot(primer.id, root.path);
      if (!catalog || catalog.type !== 'primer' || catalog.status !== 'active') continue;
      const read = await primerServices.persistence.readArtifact(primer, root.path);
      if (read.artifact.registry.entityId !== entity.id)
        throw new Error('The primer artifact and canonical Registry identity disagree.');
      matches.push({ primer, read, root });
    }
  }
  if (matches.length > 1)
    throw new Error('The oligo has multiple project artifacts. Specify its owning workspace.');
  const owned = matches[0];
  const registryWorkspaceRoot =
    !owned && entity.workspaceId != null ? await getWorkspaceRootById(entity.workspaceId) : null;
  if (!owned && entity.workspaceId != null && !registryWorkspaceRoot)
    throw new Error('The canonical oligo provenance project is unavailable.');
  if (
    input.workspace &&
    !owned &&
    (!registryWorkspaceRoot ||
      normalizePathForBoundary(registryWorkspaceRoot) !== normalizePathForBoundary(selected!.path))
  )
    throw new Error(
      'The oligo has no canonical primer artifact or retained provenance in the selected project.'
    );
  const wantsBinding = Boolean(
    input.bindingId ||
    input.documentId ||
    input.bindingStart !== undefined ||
    input.bindingEnd !== undefined
  );
  if (wantsBinding && !owned)
    throw new Error('Open the project owning the primer attachment before referencing it.');
  const bindings =
    wantsBinding && owned
      ? owned.read.artifact.bindings.filter(
          (binding) =>
            (!input.bindingId || binding.id === input.bindingId) &&
            (!input.documentId || binding.target.documentId === input.documentId) &&
            (input.bindingStart === undefined ||
              binding.coordinates.start + 1 === input.bindingStart) &&
            (input.bindingEnd === undefined || binding.coordinates.end === input.bindingEnd)
        )
      : [];
  if (wantsBinding && bindings.length !== 1)
    throw new Error(
      'The requested primer attachment is missing or ambiguous; use an exact bindingId.'
    );
  const binding = bindings[0];
  if (
    binding?.target.projectId &&
    !owned?.read.resolvedBindings.some((resolved) => resolved.binding.id === binding.id)
  )
    throw new Error(
      'The primer attachment source project is unavailable; reopen or repair that source before linking it.'
    );
  return canonicalPrimerReferenceSnapshot(
    entity,
    owned ? { primerId: owned.primer.id, workspaceRoot: owned.root.path } : undefined,
    binding,
    registryWorkspaceRoot
  );
}
