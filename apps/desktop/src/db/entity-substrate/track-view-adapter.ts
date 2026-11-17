import {
  TRACK_VIEW_SCHEMA,
  TRACK_VIEW_SUFFIX,
  parseTrackViewDocument,
  serializeTrackViewDocument,
  type TrackViewDocument,
} from '../../shared/track-view';
import {
  bindCatalogEntityToFile,
  getCatalogEntity,
  registerCatalogEntity,
  resolveWorkspaceId,
} from '../workspace-catalog';
import { platform } from '../../platform';
import { contentFingerprint, registerEntityAdapter, type WorkspaceEntityAdapter } from './adapter';

const TRACK_VIEW_REGISTRY_KIND = 'track-view';

import {
  trackViewTrackCount as trackCount,
  trackViewProjectionFields as registryFields,
  trackViewProjectionOwnership,
} from '../../shared/track-view-projection';

async function projectionWorkspaceId(context: {
  workspaceRoot: string | null;
  workspaceId?: number | null;
}): Promise<number | null> {
  if (context.workspaceId !== undefined) return context.workspaceId;
  return resolveWorkspaceId(context.workspaceRoot);
}

export const trackViewAdapter: WorkspaceEntityAdapter<TrackViewDocument> = {
  kind: 'track-view',
  schema: TRACK_VIEW_SCHEMA,
  matchesPath: (path) => path.endsWith(TRACK_VIEW_SUFFIX),
  parse: parseTrackViewDocument,
  serialize: serializeTrackViewDocument,
  identity: (document) => document.id,
  projectionFingerprint: (document) => contentFingerprint(serializeTrackViewDocument(document)),
  async getProjection(id, context) {
    const [catalogEntity, registryEntities, workspaceId] = await Promise.all([
      getCatalogEntity(id),
      platform().lims.queryEntities({ id, includeArchived: true, limit: 1 }),
      projectionWorkspaceId(context),
    ]);
    if (!catalogEntity || catalogEntity.type !== 'track-view') return null;
    const registryEntity = registryEntities[0];
    if (!registryEntity || registryEntity.kind !== TRACK_VIEW_REGISTRY_KIND) return null;
    const ownership = trackViewProjectionOwnership(workspaceId, registryEntity.workspaceId);
    const metadata: unknown = catalogEntity.metadata ? JSON.parse(catalogEntity.metadata) : null;
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('fingerprint' in metadata) ||
      typeof metadata.fingerprint !== 'string'
    )
      return null;
    const projectionMetadata = metadata as Record<string, unknown>;
    const registryFingerprint = registryEntity.fields.artifactFingerprint;
    if (
      registryEntity.tombstone ||
      registryEntity.name !== catalogEntity.name ||
      registryFingerprint !== projectionMetadata.fingerprint ||
      registryEntity.fields.referenceAssemblyId !== projectionMetadata.referenceId ||
      registryEntity.fields.referenceName !== projectionMetadata.referenceName ||
      registryEntity.fields.trackCount !== projectionMetadata.trackCount
    ) {
      return null;
    }
    return {
      fingerprint: projectionMetadata.fingerprint as string,
      updatedAtMs: Math.max(catalogEntity.updated_at, registryEntity.updatedAt),
      sourceBindingMatches:
        catalogEntity.workspace_id === ownership.fileWorkspaceId &&
        registryEntity.workspaceId === ownership.registryWorkspaceId,
    };
  },
  async writeProjection(document, id, fileMtimeMs, path, context) {
    const fingerprint = this.projectionFingerprint(document);
    const workspaceId = await projectionWorkspaceId(context);
    await registerCatalogEntity({
      id,
      type: 'track-view',
      name: document.name,
      locator: `entity://track-view/${id}`,
      storageType: 'file',
      workspaceRoot: context.workspaceRoot,
      metadata: {
        schema: document.schema,
        referenceId: document.reference.assemblyId,
        referenceName: document.reference.name,
        trackCount: trackCount(document),
        fingerprint,
      },
    });
    await bindCatalogEntityToFile({
      entityId: id,
      path,
      fileKind: 'dnaforge-track-view',
      workspaceRoot: context.workspaceRoot,
      modifiedAt: fileMtimeMs,
      status: 'current',
      mutationToken: context.mutationToken,
    });

    const [existing] = await platform().lims.queryEntities({
      id,
      includeArchived: true,
      limit: 1,
    });
    const fields = registryFields(document);
    if (!existing) {
      await platform().lims.registerEntity({
        id,
        kind: TRACK_VIEW_REGISTRY_KIND,
        name: document.name,
        fields,
        registrationStatus: 'registered',
        domainStatus: null,
        workspaceId,
        actor: 'track-view-file',
        createdAt: fileMtimeMs,
      });
      return;
    }
    if (existing.kind !== TRACK_VIEW_REGISTRY_KIND) {
      throw new Error(`Registry entity ${id} is not a Track view.`);
    }
    const ownership = trackViewProjectionOwnership(workspaceId, existing.workspaceId);
    const alreadyCurrent =
      !existing.tombstone &&
      existing.name === document.name &&
      existing.workspaceId === ownership.registryWorkspaceId &&
      existing.fields.artifactFingerprint === fingerprint &&
      existing.fields.referenceAssemblyId === document.reference.assemblyId &&
      existing.fields.referenceName === document.reference.name &&
      existing.fields.trackCount === trackCount(document);
    if (alreadyCurrent) return;
    await platform().lims.updateEntity({
      id,
      name: document.name,
      fields,
      replaceFields: true,
      registrationStatus: 'registered',
      domainStatus: null,
      workspaceId: ownership.registryWorkspaceId,
      actor: 'track-view-file',
    });
    if (existing.tombstone) {
      await platform().lims.restoreEntity({ id, actor: 'track-view-file' });
    }
  },
};

export function registerTrackViewAdapter(): void {
  registerEntityAdapter(trackViewAdapter);
}
