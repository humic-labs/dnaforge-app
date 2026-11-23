import { platform } from '../../platform';
import {
  MOLECULAR_DOCUMENT_FILE_KIND,
  MOLECULAR_DOCUMENT_SCHEMA,
  MOLECULAR_DOCUMENT_SUFFIX,
  serializeMolecularDocument,
  type MolecularDocument,
  type SavedMolecularDocument,
} from '../../shared/molecular-document';
import { readMolecularDocumentContent } from '../../shared/molecular-document-reader';
import { coordinateDigest } from '../../shared/molecular-view';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';
import {
  bindCatalogEntityToFile,
  getCatalogEntity,
  getCatalogFileForPath,
  registerCatalogEntity,
  resolveWorkspaceId,
} from '../workspace-catalog';
import {
  registerEntityAdapter,
  type EntityReconcileContext,
  type WorkspaceEntityAdapter,
} from './adapter';

import { molecularDocumentProjectionFields as documentFields } from '../../shared/molecular-document-projection';

type FileRevision = { hash: string; sizeBytes: number };
const capturedRevisions = new WeakMap<MolecularDocument, FileRevision>();

export function rememberMolecularDocumentSource(saved: SavedMolecularDocument): void {
  if (saved.sizeBytes !== undefined)
    capturedRevisions.set(saved.document, { hash: saved.revision, sizeBytes: saved.sizeBytes });
}

async function sourceRevision(document: MolecularDocument, bytes?: string): Promise<FileRevision> {
  const captured = capturedRevisions.get(document);
  if (captured) return captured;
  const text = bytes ?? serializeMolecularDocument(document);
  return { hash: await coordinateDigest(text), sizeBytes: new TextEncoder().encode(text).byteLength };
}

async function owningWorkspaceId(context: EntityReconcileContext): Promise<number | null> {
  return context.workspaceId !== undefined
    ? context.workspaceId
    : resolveWorkspaceId(context.workspaceRoot);
}

export const molecularDocumentAdapter: WorkspaceEntityAdapter<MolecularDocument> = {
  kind: 'molecular-document',
  schema: MOLECULAR_DOCUMENT_SCHEMA,
  matchesPath: (path) => path.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX),
  async parse(bytes) {
    const document = await readMolecularDocumentContent(bytes);
    capturedRevisions.set(document, await sourceRevision(document, bytes));
    return document;
  },
  serialize: serializeMolecularDocument,
  identity(document, context) {
    if (context.workspaceRoot && !context.workspaceScope)
      throw new Error('A molecular document projection requires its owning workspace scope.');
    return scopedProjectionId(context.workspaceScope, document.id);
  },
  projectionFingerprint: (document) => documentFields(document).artifactFingerprint as string,
  async getProjection(id, context, path) {
    const [entity, binding, registryEntities, workspaceId] = await Promise.all([
      getCatalogEntity(id),
      getCatalogFileForPath(path),
      platform().lims.queryEntities({ id, includeArchived: true, limit: 1 }),
      owningWorkspaceId(context),
    ]);
    const registry = registryEntities[0];
    if (!entity || entity.type !== 'molecular-document' || registry?.kind !== 'molecular-document')
      return null;
    let parsedMetadata: unknown;
    try {
      parsedMetadata = JSON.parse(entity.metadata ?? '{}');
    } catch {
      return null;
    }
    if (!parsedMetadata || typeof parsedMetadata !== 'object' || Array.isArray(parsedMetadata))
      return null;
    const metadata = parsedMetadata as Record<string, unknown>;
    if (
      typeof metadata.artifactFingerprint !== 'string' ||
      registry.tombstone ||
      entity.name !== registry.name
    )
      return null;
    for (const key of ['artifactFingerprint', 'currentReferenceId', 'revisionCount', 'sourceCount'])
      if (metadata[key] !== registry.fields[key]) return null;
    return {
      fingerprint: metadata.artifactFingerprint,
      updatedAtMs: Math.max(entity.updated_at, registry.updatedAt),
      sourceBindingMatches:
        entity.workspace_id === workspaceId &&
        registry.workspaceId === workspaceId &&
        binding?.entity_id === id &&
        binding.status === 'current',
    };
  },
  async writeProjection(document, id, fileMtimeMs, path, context) {
    const fields = documentFields(document);
    const workspaceId = await owningWorkspaceId(context);
    const revision = await sourceRevision(document);
    await registerCatalogEntity({
      id,
      type: 'molecular-document',
      name: document.name,
      locator: `entity://molecular-document/${id}`,
      storageType: 'file',
      workspaceRoot: context.workspaceRoot,
      metadata: { schema: document.schema, documentId: document.id, ...fields },
    });
    await bindCatalogEntityToFile({
      entityId: id,
      path,
      fileKind: MOLECULAR_DOCUMENT_FILE_KIND,
      workspaceRoot: context.workspaceRoot,
      contentHash: `sha256:${revision.hash}`,
      sizeBytes: revision.sizeBytes,
      modifiedAt: fileMtimeMs,
      status: 'current',
    });
    const [existing] = await platform().lims.queryEntities({ id, includeArchived: true, limit: 1 });
    if (existing && existing.kind !== 'molecular-document')
      throw new Error(`Registry entity ${id} is not a molecular visualization.`);
    if (!existing) {
      await platform().lims.registerEntity(
        {
          id,
          kind: 'molecular-document',
          name: document.name,
          fields,
          registrationStatus: 'registered',
          domainStatus: null,
          workspaceId,
          actor: 'molecular-document-file',
          createdAt: fileMtimeMs,
        },
        context.mutationToken
      );
      return;
    }
    if (
      existing.name !== document.name ||
      existing.workspaceId !== workspaceId ||
      Object.entries(fields).some(([key, value]) => existing.fields[key] !== value)
    ) {
      await platform().lims.updateEntity(
        {
          id,
          name: document.name,
          fields,
          replaceFields: true,
          workspaceId,
          registrationStatus: 'registered',
          domainStatus: null,
          actor: 'molecular-document-file',
        },
        context.mutationToken
      );
    }
    if (existing.tombstone)
      await platform().lims.restoreEntity(
        { id, actor: 'molecular-document-file' },
        context.mutationToken
      );
  },
  async reconcileRelationships(document, id, path, context) {
    if (!context.workspaceRoot)
      throw new Error('A molecular document projection requires its owning workspace root.');
    await platform().molecularDocuments.reconcileSourceLinks(
      {
        path,
        workspaceRoot: context.workspaceRoot,
        entityId: id,
        documentHash: (await sourceRevision(document)).hash,
      },
      context.mutationToken
    );
  },
};

export function registerMolecularDocumentAdapter(): void {
  registerEntityAdapter(molecularDocumentAdapter);
}
