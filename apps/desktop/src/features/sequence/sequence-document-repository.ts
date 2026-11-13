import {
  getCurrentSequenceFileForDocumentId,
  getCatalogEntity,
  type DBCatalogEntityFile,
} from '../../db/workspace-catalog';
import { isSequencePackageFileKind } from '../../db/sequence-package';
import type {
  CatalogSequenceDocumentRef,
  SequenceDocumentRef,
} from '../../shared/managed-sequence-document';
import { sequenceDocumentKey } from '../../shared/managed-sequence-document';
import {
  managedSequenceRepository,
  type ManagedSequenceResolutionOptions,
} from './managed-sequence-repository';
import { pathIsAtOrUnder } from '../../shared/path-boundary';
import { platform } from '../../platform';
import { isFastaKindSourcePath } from '../../shared/fasta-kind';

export async function assertCanonicalSequenceSource(
  documentId: string,
  sourcePath: string
): Promise<void> {
  if (!isFastaKindSourcePath(sourcePath)) return;
  await platform().db.assertCanonicalSequenceSource({ documentId, filePath: sourcePath });
}

export async function resolveCanonicalSequenceDocumentById(
  documentId: string,
  workspaceRoots: readonly string[],
  options: ManagedSequenceResolutionOptions = {}
): Promise<ResolvedSequenceDocument> {
  const resolved = await resolveSequenceDocumentById(documentId, workspaceRoots, options);
  await assertCanonicalSequenceSource(resolved.documentId, resolved.sourcePath);
  return resolved;
}

import type { ResolvedSequenceDocument } from '../../shared/sequence-document-location';
export type { ResolvedSequenceDocument } from '../../shared/sequence-document-location';

export async function resolveSequenceDocument(
  ref: SequenceDocumentRef,
  options: ManagedSequenceResolutionOptions = {}
): Promise<ResolvedSequenceDocument> {
  if (ref.kind === 'managed-sequence') {
    const resolved = await managedSequenceRepository.resolve(ref, options);
    return {
      ref: resolved.ref,
      documentId: resolved.document.id,
      sourcePath: resolved.productPath,
      name: resolved.document.name,
    };
  }

  if (ref.kind === 'indexed-sequence') {
    throw new Error(
      'Indexed sequence bytes are resolved from indexed viewer state, not from document identity.'
    );
  }

  if (ref.kind === 'import-source-sequence') {
    return { ref, documentId: ref.documentId, sourcePath: ref.sourcePath };
  }

  const binding = await getCurrentSequenceFileForDocumentId(ref.entityId);
  if (!binding) {
    throw new Error('The sequence source is no longer available in this project.');
  }
  return resolveCatalogBinding(binding, options);
}

async function resolveCatalogBinding(
  binding: DBCatalogEntityFile,
  options: ManagedSequenceResolutionOptions
): Promise<ResolvedSequenceDocument> {
  if (isSequencePackageFileKind(binding.file_kind)) {
    return resolveSequenceDocument(
      {
        kind: 'managed-sequence',
        packageId: binding.entity_id,
        packageRoot: binding.path,
      },
      options
    );
  }
  const ref = catalogSequenceDocumentRef(binding.entity_id);
  const entity = await getCatalogEntity(binding.entity_id);
  return {
    ref,
    documentId: sequenceDocumentKey(ref),
    sourcePath: binding.path,
    ...(entity?.name ? { name: entity.name } : {}),
  };
}

export function catalogSequenceDocumentRef(entityId: string): CatalogSequenceDocumentRef {
  if (!entityId.trim()) throw new Error('A catalog sequence document requires an entity ID.');
  return { kind: 'catalog-sequence', entityId };
}

export async function resolveSequenceDocumentById(
  documentId: string,
  workspaceRoots: readonly string[],
  options: ManagedSequenceResolutionOptions = {}
): Promise<ResolvedSequenceDocument> {
  if (!documentId.trim()) throw new Error('A sequence document ID is required.');

  const binding = await getCurrentSequenceFileForDocumentId(documentId);
  if (
    binding &&
    (workspaceRoots.length === 0 ||
      workspaceRoots.some((root) => pathIsAtOrUnder(binding.path, root)))
  )
    return resolveCatalogBinding(binding, options);

  const managed = await managedSequenceRepository.findById(documentId, workspaceRoots, options);
  if (managed) {
    return {
      ref: managed.ref,
      documentId: managed.document.id,
      sourcePath: managed.productPath,
      name: managed.document.name,
    };
  }

  if (workspaceRoots.length > 0)
    throw new Error('The sequence identity does not belong to the requested project.');

  return resolveSequenceDocument(catalogSequenceDocumentRef(documentId), options);
}
