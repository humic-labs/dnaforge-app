import { platform } from '../../platform';
import {
  MOLECULAR_DOCUMENT_FILE_KIND,
  MOLECULAR_DOCUMENT_SCHEMA,
  MOLECULAR_DOCUMENT_SUFFIX,
  parseMolecularDocument,
  serializeMolecularDocument,
  validateMolecularDocumentCoordinates,
  type MolecularDocument,
} from '../../shared/molecular-document';
import { coordinateDigest } from '../../shared/molecular-view';
import { scopedProjectionId, stripWorkspaceScope } from '../../shared/workspace-scoped-identity';
import {
  bindCatalogEntityToFile,
  getCatalogEntity,
  getCatalogFileForPath,
  getCatalogLinksForEntity,
  linkCatalogEntities,
  registerCatalogEntity,
  resolveWorkspaceId,
} from '../workspace-catalog';
import {
  registerEntityAdapter,
  type EntityReconcileContext,
  type WorkspaceEntityAdapter,
} from './adapter';

import { molecularDocumentProjectionFields as documentFields } from '../../shared/molecular-document-projection';

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
    const document = parseMolecularDocument(bytes);
    await validateMolecularDocumentCoordinates(document);
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
    const bytes = serializeMolecularDocument(document);
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
      contentHash: `sha256:${await coordinateDigest(bytes)}`,
      sizeBytes: new TextEncoder().encode(bytes).byteLength,
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
  async reconcileRelationships(document, id, _path, context) {
    const workspaceId = await owningWorkspaceId(context);
    const pinsByTarget = new Map<string, Array<Record<string, string>>>();
    for (const { referenceId, snapshot } of document.history) {
      const source = snapshot.source;
      if (!source.artifactEntityId) continue;
      const candidates = [
        ...new Set([
          scopedProjectionId(context.workspaceScope, stripWorkspaceScope(source.artifactEntityId)),
          source.artifactEntityId,
        ]),
      ];
      for (const candidate of candidates) {
        const target = await getCatalogEntity(candidate);
        if (!target || target.status !== 'active' || target.workspace_id !== workspaceId) continue;
        const pins = pinsByTarget.get(target.id) ?? [];
        pins.push({
          referenceId,
          coordinateSha256: snapshot.coordinates.sha256,
          ...(source.artifactRevisionId ? { artifactRevisionId: source.artifactRevisionId } : {}),
        });
        pinsByTarget.set(target.id, pins);
        break;
      }
    }
    const previous = (await getCatalogLinksForEntity(id)).filter(
      (link) => link.source_entity_id === id && link.relation === 'uses-source'
    );
    for (const link of previous)
      if (!pinsByTarget.has(link.target_entity_id)) {
        await platform().db.execute('DELETE FROM catalog_entity_links WHERE id = ?', [link.id]);
      }
    for (const [targetEntityId, pins] of pinsByTarget) {
      const evidence = { documentId: document.id, pins };
      const existing = previous.find((link) => link.target_entity_id === targetEntityId);
      if (existing?.confidence === 'confirmed' && existing.evidence === JSON.stringify(evidence))
        continue;
      await linkCatalogEntities({
        sourceEntityId: id,
        targetEntityId,
        relation: 'uses-source',
        confidence: 'confirmed',
        evidence,
      });
    }
  },
};

export function registerMolecularDocumentAdapter(): void {
  registerEntityAdapter(molecularDocumentAdapter);
}
