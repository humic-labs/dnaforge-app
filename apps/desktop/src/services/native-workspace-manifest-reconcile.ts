import { mapPortableRecordRelationships } from '../shared/portable-record-relationships';
import {
  hasScientificSequenceField,
  type PortableEntitySchemaRevisionSnapshot,
} from '../shared/entity-schema';
import {
  bindCatalogEntityToFile,
  deleteCatalogWorkspacePlacement,
  getCatalogEntity,
  getCurrentCatalogFileForEntity,
  getCatalogEventsForEntity,
  linkCatalogEntities,
  recordCatalogEvent,
  registerCatalogEntity,
  resolveWorkspaceScope,
  updateCatalogEntityMetadata,
  writeCatalogWorkspacePlacement,
  type CatalogEntityType,
} from '../db/workspace-catalog';
import { restoreProviderBinding } from '../db/catalog-provider-bindings';
import { resolveArtifactFile, workspaceArtifactSourcesMatch } from '../db/workspace-artifacts';
import {
  ensureLimsSeeded,
  linkLimsEntities,
  queryLimsEntities,
  registerLimsEntity,
  updateLimsEntity,
} from '../features/lims/operations';
import { buildFileDnaSequenceRef } from '../features/lims/dna-sequence';
import { buildFileAminoAcidSequenceRef } from '../features/lims/protein-sequence';
import { platform } from '../platform';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  nativeWorkspaceEntityFileKind,
  nativeWorkspaceEntityPhysicalRoot,
  nativeWorkspaceEntityPlacement,
  nativeWorkspaceEntityPrimaryFile,
  nativeWorkspaceUsesAtomicSequenceProjection,
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestAnyEntity,
} from '../shared/native-workspace-manifest';

export type NativeWorkspaceManifestFileBinding = {
  path: string;
  entityId: string;
  type: CatalogEntityType;
};

export type NativeWorkspaceManifestReconcileResult = {
  present: boolean;
  entities: number;
  links: number;
  limsEntities: number;
  events: number;
  providerBindings: number;
  atomicSequenceBindings?: ReadonlyArray<{ path: string; entityId: string }>;
  fileBindings?: ReadonlyArray<NativeWorkspaceManifestFileBinding>;
  notebookBindingPass?: NotebookBindingPass;
};

type NotebookBindingPass = {
  manifestText: string;
  bindings: ReadonlyArray<{
    entityId: string;
    packagePath: string;
    sourceFingerprints: ReadonlyArray<{ path: string; fingerprint: string }>;
  }>;
};

export async function reconcileNativeWorkspaceManifest(
  workspaceRoot: string,
  options: NativeManifestReconcileOptions = {}
): Promise<NativeWorkspaceManifestReconcileResult> {
  const root = workspaceRoot.replace(/[/\\]+$/u, '');
  const manifestPath = `${root}/${NATIVE_WORKSPACE_MANIFEST_PATH}`;
  if (!(await platform().fs.exists(manifestPath))) {
    return {
      present: false,
      entities: 0,
      links: 0,
      limsEntities: 0,
      events: 0,
      providerBindings: 0,
    };
  }
  const manifestText = await platform().fs.readTextFile(manifestPath);
  const manifest = parseNativeWorkspaceManifest(manifestText);
  const notebookBindings: NotebookBindingPass['bindings'][number][] = [];
  const recordRawIds = new Set(
    manifest.entities.filter((entity) => entity.type === 'record').map((entity) => entity.id)
  );
  const atomicSequenceRawIds = new Set(
    manifest.entities.filter(nativeWorkspaceUsesAtomicSequenceProjection).map((entity) => entity.id)
  );
  const entityIds = new Map<string, string>();
  const entityWorkspaceIds = new Map<string, number | null>();
  const missingPhysicalEntityIds = new Set<string>();
  const scope = await resolveWorkspaceScope(workspaceRoot);
  if (!scope) throw new Error('Native catalog reconstruction requires a workspace scope.');
  const accepted = new Set(options.acceptedResourceIds ?? []);

  for (const entity of manifest.entities)
    entityIds.set(
      entity.id,
      accepted.has(entity.id) ? entity.id : scopedProjectionId(scope, entity.id)
    );
  for (const entity of manifest.entities) {
    if (accepted.has(entityIds.get(entity.id)!)) continue;
    await reconcileNativeManifestEntity({
      entity,
      root,
      workspaceRoot,
      manifestText,
      manifestIsV2: manifest.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
      options,
      scope,
      recordRawIds,
      atomicSequenceRawIds,
      entityIds,
      entityWorkspaceIds,
      missingPhysicalEntityIds,
      notebookBindings,
    });
  }

  const limsEntityCount = await reconcileNativeLimsManifestEntities({
    entities: manifest.entities.filter((entity) => !accepted.has(entityIds.get(entity.id)!)),
    root,
    options,
    recordRawIds,
    atomicSequenceRawIds,
    entityIds,
    entityWorkspaceIds,
    missingPhysicalEntityIds,
  });
  await reconcileNativeRecordsIfPresent({
    workspaceRoot,
    manifestText,
    mutationToken: options.mutationToken,
    recordRawIds,
    atomicSequenceRawIds,
  });
  const providerBindings = await restoreNativeCatalogReferences({
    manifest,
    scope,
    entityIds,
    recordRawIds,
    atomicSequenceRawIds,
  });
  await restoreNativeLimsLinks({
    links: (manifest.limsLinks ?? []).filter(
      (link) =>
        !accepted.has(entityIds.get(link.fromEntityId)!) &&
        !accepted.has(entityIds.get(link.toEntityId)!)
    ),
    scope,
    mutationToken: options.mutationToken,
    recordRawIds,
    atomicSequenceRawIds,
    entityIds,
  });

  return {
    present: true,
    entities: manifest.entities.length,
    links: manifest.links.length,
    limsEntities: limsEntityCount,
    events: manifest.events?.length ?? 0,
    notebookBindingPass: { manifestText, bindings: notebookBindings },
    providerBindings,
    atomicSequenceBindings: mapAtomicSequenceBindings(manifest.entities, root, scope).filter(
      (binding) => !accepted.has(binding.entityId)
    ),
    fileBindings: (await checkedNativeFileBindings(manifest.entities, root, entityIds)).filter(
      (binding) => !accepted.has(binding.entityId)
    ),
  };
}

type NativeManifestReconcileOptions = {
  mutationToken?: string;
  notebookBindingPass?: NotebookBindingPass;
  acceptedResourceIds?: readonly string[];
};

type NativeWorkspaceScope = NonNullable<Awaited<ReturnType<typeof resolveWorkspaceScope>>>;

type RestoreNativeCatalogReferencesArgs = {
  manifest: ReturnType<typeof parseNativeWorkspaceManifest>;
  scope: NativeWorkspaceScope;
  entityIds: ReadonlyMap<string, string>;
  recordRawIds: ReadonlySet<string>;
  atomicSequenceRawIds: ReadonlySet<string>;
};

async function restoreNativeCatalogReferences({
  manifest,
  scope,
  entityIds,
  recordRawIds,
  atomicSequenceRawIds,
}: RestoreNativeCatalogReferencesArgs): Promise<number> {
  await restoreNativeCatalogLinks(manifest, entityIds, recordRawIds);
  const providerBindings = await restoreNativeProviderBindings(
    manifest,
    entityIds,
    recordRawIds,
    atomicSequenceRawIds
  );
  await restoreNativeCatalogEvents(manifest, entityIds, scope);
  return providerBindings;
}

async function restoreNativeCatalogLinks(
  manifest: ReturnType<typeof parseNativeWorkspaceManifest>,
  entityIds: ReadonlyMap<string, string>,
  recordRawIds: ReadonlySet<string>
): Promise<void> {
  const existingLinks = new Map<string, { confidence: string; evidence: string | null }>();
  const sourceIds = [
    ...new Set(
      manifest.links
        .map((link) => entityIds.get(link.sourceId))
        .filter((id): id is string => id !== undefined)
    ),
  ];
  for (let offset = 0; offset < sourceIds.length; offset += 200) {
    const ids = sourceIds.slice(offset, offset + 200);
    const rows = await platform().db.select<
      Array<{
        source_entity_id: string;
        target_entity_id: string;
        relation: string;
        confidence: string;
        evidence: string | null;
      }>
    >(
      `SELECT source_entity_id,target_entity_id,relation,confidence,evidence FROM catalog_entity_links WHERE source_entity_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    for (const row of rows)
      existingLinks.set(
        JSON.stringify([row.source_entity_id, row.relation, row.target_entity_id]),
        row
      );
  }
  for (const link of manifest.links) {
    if (recordRawIds.has(link.sourceId) || recordRawIds.has(link.targetId)) continue;
    const sourceEntityId = entityIds.get(link.sourceId);
    const targetEntityId = entityIds.get(link.targetId);
    if (!sourceEntityId || !targetEntityId) {
      throw new Error('Native workspace catalog link references an unknown entity.');
    }
    const existing = existingLinks.get(
      JSON.stringify([sourceEntityId, link.relation, targetEntityId])
    );
    if (
      existing?.confidence === (link.confidence ?? 'confirmed') &&
      existing.evidence === (link.evidence == null ? null : JSON.stringify(link.evidence))
    )
      continue;
    await linkCatalogEntities({
      sourceEntityId,
      relation: link.relation,
      targetEntityId,
      confidence: link.confidence ?? 'confirmed',
      evidence: link.evidence ?? null,
    });
  }
}

async function restoreNativeProviderBindings(
  manifest: ReturnType<typeof parseNativeWorkspaceManifest>,
  entityIds: ReadonlyMap<string, string>,
  recordRawIds: ReadonlySet<string>,
  atomicSequenceRawIds: ReadonlySet<string>
): Promise<number> {
  let providerBindings = 0;
  for (const entity of manifest.entities) {
    const entityId = entityIds.get(entity.id);
    if (!entityId) throw new Error('Native workspace identity references an unknown entity.');
    for (const identity of entity.sourceIdentities ?? []) {
      if (recordRawIds.has(entity.id) || atomicSequenceRawIds.has(entity.id)) {
        providerBindings += 1;
        continue;
      }
      await restoreProviderBinding({
        provider: identity.provider,
        stableObjectId: identity.stableObjectId,
        objectClass: identity.objectClass,
        entityId,
        bindingKind: identity.bindingKind,
        providerAccountHint: identity.providerAccountHint ?? null,
        canonicalUrl: identity.canonicalUrl ?? null,
        evidence: { source: NATIVE_WORKSPACE_MANIFEST_PATH },
      });
      providerBindings += 1;
    }
  }
  return providerBindings;
}

async function restoreNativeCatalogEvents(
  manifest: ReturnType<typeof parseNativeWorkspaceManifest>,
  entityIds: ReadonlyMap<string, string>,
  scope: NativeWorkspaceScope
): Promise<void> {
  const existingEventIds = new Map<string, Set<string>>();
  for (const event of manifest.events ?? []) {
    const entityId = entityIds.get(event.entityId);
    if (!entityId) throw new Error('Native workspace event references an unknown entity.');
    const eventId = scopedProjectionId(scope, event.id);
    let entityEventIds = existingEventIds.get(entityId);
    if (!entityEventIds) {
      entityEventIds = new Set(
        (await getCatalogEventsForEntity(entityId)).map((existing) => existing.id)
      );
      existingEventIds.set(entityId, entityEventIds);
    }
    if (entityEventIds.has(eventId)) continue;
    await recordCatalogEvent({
      id: eventId,
      entityId,
      eventType: event.eventType,
      actor: event.actor,
      ...(event.summary !== undefined ? { summary: event.summary } : {}),
      ...(event.payload !== undefined ? { payload: event.payload } : {}),
      createdAt: event.createdAt,
    });
    entityEventIds.add(eventId);
  }
}

type NativeManifestEntityPaths = {
  placement: ReturnType<typeof nativeWorkspaceEntityPlacement>;
  physicalRoot: string | null;
  bindingRelativePath: string | null;
  absolutePath: string | null;
  physicalRootPath: string | null;
  missingDirectFile: boolean;
};

async function resolveNativeManifestEntityPaths(
  entity: NativeWorkspaceManifestAnyEntity,
  root: string,
  manifestIsV2: boolean
): Promise<NativeManifestEntityPaths> {
  const placement = nativeWorkspaceEntityPlacement(entity);
  const physicalRoot = nativeWorkspaceEntityPhysicalRoot(entity);
  const primaryFile = nativeWorkspaceEntityPrimaryFile(entity);
  const bindingRelativePath =
    placement.kind === 'package' && entity.type !== 'notebook' ? primaryFile : physicalRoot;
  const absolutePath = bindingRelativePath ? `${root}/${bindingRelativePath}` : null;
  const physicalRootPath = physicalRoot ? `${root}/${physicalRoot}` : null;
  const physicalExists = absolutePath ? await platform().fs.exists(absolutePath) : false;
  const packageRootExists = physicalRootPath ? await platform().fs.exists(physicalRootPath) : false;
  const missingDirectFile = manifestIsV2 && placement.kind === 'file' && !physicalExists;
  if (
    (!physicalExists && !missingDirectFile && placement.kind !== 'catalog-record') ||
    (placement.kind === 'package' && !packageRootExists)
  ) {
    throw new Error(`Native workspace entity is missing its authoritative path: ${physicalRoot}`);
  }
  return {
    placement,
    physicalRoot,
    bindingRelativePath,
    absolutePath,
    physicalRootPath,
    missingDirectFile,
  };
}

type ReconcileNativeNotebookArgs = {
  entity: NativeWorkspaceManifestAnyEntity;
  entityId: string;
  physicalRoot: string | null;
  physicalRootPath: string | null;
  workspaceRoot: string;
  manifestText: string;
  options: NativeManifestReconcileOptions;
  notebookBindings: NotebookBindingPass['bindings'][number][];
};

async function reconcileNativeNotebook({
  entity,
  entityId,
  physicalRoot,
  physicalRootPath,
  workspaceRoot,
  manifestText,
  options,
  notebookBindings,
}: ReconcileNativeNotebookArgs): Promise<void> {
  if (!physicalRootPath || !physicalRoot) {
    throw new Error('A native notebook requires a physical package placement.');
  }

  const previous =
    options.notebookBindingPass?.manifestText === manifestText
      ? options.notebookBindingPass.bindings.find(
          (binding) => binding.entityId === entityId && binding.packagePath === physicalRootPath
        )
      : undefined;
  const sourcesMatch =
    previous && (await workspaceArtifactSourcesMatch(previous.sourceFingerprints));
  if (previous && sourcesMatch) {
    const binding = await getCurrentCatalogFileForEntity(entityId);
    if (binding?.path === physicalRootPath && binding.status === 'current') {
      const current = await getCatalogEntity(entityId);
      if (current?.type === 'notebook' && current.locator === `entity://page/${entityId}`) {
        await updateCatalogEntityMetadata(entityId, portableManifestMetadata(entity));
        await deleteCatalogWorkspacePlacement(entityId);
        notebookBindings.push(previous);
        return;
      }
    }
  }
  const resolved = await resolveArtifactFile({
    path: physicalRootPath,
    workspaceRoot,
    mutationToken: options.mutationToken,
    catalogMetadata: portableManifestMetadata(entity),
  });
  if (resolved.entity.id !== entityId) {
    throw new Error(`Native notebook identity does not match its package: ${physicalRoot}`);
  }
  notebookBindings.push({
    entityId,
    packagePath: physicalRootPath,
    sourceFingerprints: resolved.sourceFingerprints,
  });
  await deleteCatalogWorkspacePlacement(entityId);
}

type ReconcileNativeCatalogEntityArgs = {
  entity: NativeWorkspaceManifestAnyEntity;
  entityId: string;
  paths: NativeManifestEntityPaths;
  workspaceRoot: string;
  entityWorkspaceIds: Map<string, number | null>;
  mutationToken?: string;
};

async function reconcileNativeCatalogEntity({
  entity,
  entityId,
  paths,
  workspaceRoot,
  entityWorkspaceIds,
  mutationToken,
}: ReconcileNativeCatalogEntityArgs): Promise<void> {
  const { placement, physicalRoot, bindingRelativePath, absolutePath, missingDirectFile } = paths;

  const existingCatalogEntity = await getCatalogEntity(entityId);
  const databaseBackedLimsEntity = isDatabaseBackedLimsManifestEntity(entity);
  if (!databaseBackedLimsEntity && !absolutePath) {
    throw new Error(`Native workspace entity ${entity.id} has no physical or catalog placement.`);
  }
  const fileKind = nativeWorkspaceEntityFileKind(entity);
  const locator = databaseBackedLimsEntity
    ? `entity://lims/${entityId}`
    : absolutePath
      ? `file://${absolutePath}`
      : (() => {
          throw new Error(`Native workspace entity ${entity.id} has no locator authority.`);
        })();
  const catalogEntity = await registerCatalogEntity({
    id: entityId,
    type: entity.type,
    name: existingCatalogEntity?.name ?? entity.name,
    locator,
    storageType: databaseBackedLimsEntity ? 'database' : 'file',
    status: missingDirectFile ? 'missing' : 'active',
    workspaceRoot,
    metadata: {
      ...(entity.metadata ?? {}),
      ...migrationSourceMetadata(entity),
      portableId: entity.id,
      ...(databaseBackedLimsEntity && physicalRoot
        ? {
            migrationEvidence: {
              path: absolutePath,
              relativePath: physicalRoot,
            },
          }
        : databaseBackedLimsEntity
          ? { placement: nativeWorkspaceEntityPlacement(entity) }
          : { path: absolutePath, relativePath: bindingRelativePath }),
      ...(fileKind ? { fileKind } : {}),
      reconstructedFrom: NATIVE_WORKSPACE_MANIFEST_PATH,
    },
  });
  if (catalogEntity.id !== entityId) {
    throw new Error(`Native workspace entity is bound to another identity: ${entity.id}`);
  }
  entityWorkspaceIds.set(entityId, catalogEntity.workspace_id);
  if (placement.kind === 'catalog-record') {
    if (catalogEntity.workspace_id === null) {
      throw new Error(`Native workspace catalog placement has no workspace: ${entity.id}`);
    }
    await writeCatalogWorkspacePlacement({
      entityId,
      workspaceId: catalogEntity.workspace_id,
      parentRelativePath: placement.parentRelativePath,
      displayName: placement.displayName,
      presentationKind: placement.presentationKind,
      status: 'active',
    });
  } else {
    await deleteCatalogWorkspacePlacement(entityId);
  }
  if (!databaseBackedLimsEntity) {
    if (!absolutePath || !fileKind) {
      throw new Error(`Native workspace entity ${entity.id} has no file binding authority.`);
    }
    await bindCatalogEntityToFile({
      entityId,
      path: absolutePath,
      fileKind,
      workspaceRoot,
      status: missingDirectFile ? 'missing' : 'current',
      mutationToken,
    });
  }
}

type ReconcileNativeManifestEntityArgs = {
  entity: NativeWorkspaceManifestAnyEntity;
  root: string;
  workspaceRoot: string;
  manifestText: string;
  manifestIsV2: boolean;
  options: NativeManifestReconcileOptions;
  scope: NativeWorkspaceScope;
  recordRawIds: ReadonlySet<string>;
  atomicSequenceRawIds: ReadonlySet<string>;
  entityIds: Map<string, string>;
  entityWorkspaceIds: Map<string, number | null>;
  missingPhysicalEntityIds: Set<string>;
  notebookBindings: NotebookBindingPass['bindings'][number][];
};

async function reconcileNativeManifestEntity({
  entity,
  root,
  workspaceRoot,
  manifestText,
  manifestIsV2,
  options,
  scope,
  recordRawIds,
  atomicSequenceRawIds,
  entityIds,
  entityWorkspaceIds,
  missingPhysicalEntityIds,
  notebookBindings,
}: ReconcileNativeManifestEntityArgs): Promise<void> {
  const entityId = scopedProjectionId(scope, entity.id);
  entityIds.set(entity.id, entityId);

  if (recordRawIds.has(entity.id) || atomicSequenceRawIds.has(entity.id)) return;
  const paths = await resolveNativeManifestEntityPaths(entity, root, manifestIsV2);
  if (paths.missingDirectFile) missingPhysicalEntityIds.add(entityId);
  if (entity.type === 'notebook') {
    await reconcileNativeNotebook({
      entity,
      entityId,
      physicalRoot: paths.physicalRoot,
      physicalRootPath: paths.physicalRootPath,
      workspaceRoot,
      manifestText,
      options,
      notebookBindings,
    });
    return;
  }
  await reconcileNativeCatalogEntity({
    entity,
    entityId,
    paths,
    workspaceRoot,
    entityWorkspaceIds,
    mutationToken: options.mutationToken,
  });
}

type ReconcileNativeLimsManifestEntitiesArgs = {
  entities: ReadonlyArray<NativeWorkspaceManifestAnyEntity>;
  root: string;
  options: NativeManifestReconcileOptions;
  recordRawIds: ReadonlySet<string>;
  atomicSequenceRawIds: ReadonlySet<string>;
  entityIds: ReadonlyMap<string, string>;
  entityWorkspaceIds: ReadonlyMap<string, number | null>;
  missingPhysicalEntityIds: ReadonlySet<string>;
};

async function reconcileNativeLimsManifestEntities({
  entities,
  root,
  options,
  recordRawIds,
  atomicSequenceRawIds,
  entityIds,
  entityWorkspaceIds,
  missingPhysicalEntityIds,
}: ReconcileNativeLimsManifestEntitiesArgs): Promise<number> {
  const limsEntities = entities.filter((entity) => entity.lims !== undefined);
  if (limsEntities.length > 0) await ensureLimsSeeded(options.mutationToken);
  for (const entity of limsEntities) {
    if (recordRawIds.has(entity.id) || atomicSequenceRawIds.has(entity.id)) continue;
    const lims = entity.lims;
    const entityId = entityIds.get(entity.id);
    if (!lims || !entityId) throw new Error('Native LIMS projection is incomplete.');
    if (missingPhysicalEntityIds.has(entityId)) continue;
    const existing = await queryLimsEntities({ id: entityId, includeArchived: true, limit: 2 });
    if (existing.length > 1) throw new Error(`Native LIMS identity is ambiguous: ${entity.id}`);
    const restoredFields = await restoreLimsFields(
      lims.kind,
      lims.fields,
      root,
      nativeWorkspaceEntityPrimaryFile(entity) ?? '',
      lims.schemaSnapshot
    );
    if (existing.length === 0) {
      await registerLimsEntity(
        {
          id: entityId,
          kind: lims.kind,
          name: lims.name,
          workspaceId: entityWorkspaceIds.get(entityId) ?? null,
          fields: mapPortableRecordRelationships(restoredFields, lims.schemaSnapshot, (rawId) => {
            const id = entityIds.get(rawId);
            if (!id)
              throw new Error(`Native record relationship references an unknown entity: ${rawId}`);
            return id;
          }),
          ...(lims.schemaRevisionId ? { schemaRevisionId: lims.schemaRevisionId } : {}),
          ...(lims.schemaSnapshot ? { schemaSnapshot: lims.schemaSnapshot } : {}),
          ...(lims.registrationStatus ? { registrationStatus: lims.registrationStatus } : {}),
          ...(lims.domainStatus !== undefined ? { domainStatus: lims.domainStatus } : {}),
          ...(lims.createdAt !== undefined ? { createdAt: lims.createdAt } : {}),
          actor: 'workspace-reconcile',
        },
        { initiator: 'system', workflowOrigin: 'projection', mutationToken: options.mutationToken }
      );
      continue;
    }
    const current = existing[0]!;
    if (current.kind !== lims.kind) {
      throw new Error(`Native LIMS identity has the wrong kind: ${entity.id}`);
    }
    const restoredSequence = restoredFields.sequence;
    if (
      hasScientificSequenceField(lims.schemaSnapshot) &&
      restoredSequence !== undefined &&
      JSON.stringify(current.fields.sequence) !== JSON.stringify(restoredSequence)
    ) {
      await updateLimsEntity(
        {
          id: entityId,
          fields: { sequence: restoredSequence },
          actor: 'workspace-reconcile',
        },
        { initiator: 'system', workflowOrigin: 'projection', mutationToken: options.mutationToken }
      );
    }
  }
  return limsEntities.length;
}

type ReconcileNativeRecordsIfPresentArgs = {
  workspaceRoot: string;
  manifestText: string;
  mutationToken?: string;
  recordRawIds: ReadonlySet<string>;
  atomicSequenceRawIds: ReadonlySet<string>;
};

async function reconcileNativeRecordsIfPresent({
  workspaceRoot,
  manifestText,
  mutationToken,
  recordRawIds,
  atomicSequenceRawIds,
}: ReconcileNativeRecordsIfPresentArgs): Promise<void> {
  if (recordRawIds.size === 0 && atomicSequenceRawIds.size === 0) return;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifestText));
  const expectedManifestSha256 = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  await platform().workspace.reconcileNativeRecords({
    workspaceRoot,
    expectedManifestSha256,
    mutationToken,
  });
}

type NativeManifestLimsLink = NonNullable<
  ReturnType<typeof parseNativeWorkspaceManifest>['limsLinks']
>[number];

type RestoreNativeLimsLinksArgs = {
  links: ReadonlyArray<NativeManifestLimsLink>;
  scope: NativeWorkspaceScope;
  mutationToken?: string;
  recordRawIds: ReadonlySet<string>;
  atomicSequenceRawIds: ReadonlySet<string>;
  entityIds: ReadonlyMap<string, string>;
};

async function restoreNativeLimsLinks({
  links,
  scope,
  mutationToken,
  recordRawIds,
  atomicSequenceRawIds,
  entityIds,
}: RestoreNativeLimsLinksArgs): Promise<void> {
  const existingLimsLinks = new Set<string>();
  const fromIds = [
    ...new Set(
      links
        .map((link) => entityIds.get(link.fromEntityId))
        .filter((id): id is string => id !== undefined)
    ),
  ];
  for (let offset = 0; offset < fromIds.length; offset += 200) {
    const ids = fromIds.slice(offset, offset + 200);
    const rows = await platform().db.select<
      Array<{ from_entity_id: string; to_entity_id: string; type: string }>
    >(
      `SELECT from_entity_id,to_entity_id,type FROM lims_link WHERE tombstone = 0 AND from_entity_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    for (const row of rows)
      existingLimsLinks.add(JSON.stringify([row.from_entity_id, row.to_entity_id, row.type]));
  }
  for (const link of links) {
    if (recordRawIds.has(link.fromEntityId) || recordRawIds.has(link.toEntityId)) continue;
    if (atomicSequenceRawIds.has(link.fromEntityId) || atomicSequenceRawIds.has(link.toEntityId))
      continue;
    const fromEntityId = entityIds.get(link.fromEntityId);
    const toEntityId = entityIds.get(link.toEntityId);
    if (!fromEntityId || !toEntityId) {
      throw new Error('Native workspace LIMS link references an unknown entity.');
    }
    const tuple = JSON.stringify([fromEntityId, toEntityId, link.type]);
    if (existingLimsLinks.has(tuple)) continue;
    await linkLimsEntities(
      {
        id: scopedProjectionId(scope, link.id),
        fromEntityId,
        toEntityId,
        type: link.type,
        payload: link.payload ?? {},
        actor: 'workspace-reconcile',
      },
      { initiator: 'system', workflowOrigin: 'projection', mutationToken }
    );
    existingLimsLinks.add(tuple);
  }
}

async function checkedNativeFileBindings(
  entities: ReadonlyArray<NativeWorkspaceManifestAnyEntity>,
  root: string,
  entityIds: ReadonlyMap<string, string>
): Promise<NativeWorkspaceManifestFileBinding[]> {
  const bindings: NativeWorkspaceManifestFileBinding[] = [];
  for (const entity of entities) {
    if (entity.type !== 'sequence' && entity.type !== 'protein') continue;
    const relativePath = nativeWorkspaceEntityPrimaryFile(entity);
    const entityId = entityIds.get(entity.id);
    if (!relativePath || !entityId) continue;
    const binding = await getCurrentCatalogFileForEntity(entityId);
    if (binding?.path !== `${root}/${relativePath}` || binding.status !== 'current') continue;
    const current = await getCatalogEntity(entityId);
    if (current?.type !== entity.type) continue;
    bindings.push({ path: binding.path, entityId, type: current.type });
  }
  return bindings;
}

function mapAtomicSequenceBindings(
  entities: ReadonlyArray<NativeWorkspaceManifestAnyEntity>,
  root: string,
  scope: NativeWorkspaceScope
): ReadonlyArray<{ path: string; entityId: string }> {
  return entities.filter(nativeWorkspaceUsesAtomicSequenceProjection).map((entity) => {
    return {
      path: `${root}/${entity.placement.relativePath}`,
      entityId: scopedProjectionId(scope, entity.id),
    };
  });
}

function portableManifestMetadata(
  entity: NativeWorkspaceManifestAnyEntity
): Record<string, unknown> {
  return {
    ...(entity.metadata ?? {}),
    ...migrationSourceMetadata(entity),
    portableId: entity.id,
    placement: nativeWorkspaceEntityPlacement(entity),
    reconstructedFrom: NATIVE_WORKSPACE_MANIFEST_PATH,
  };
}

function migrationSourceMetadata(
  entity: NativeWorkspaceManifestAnyEntity
): Record<string, unknown> {
  return 'migrationSource' in entity && entity.migrationSource
    ? { migrationSource: entity.migrationSource }
    : {};
}

async function restoreLimsFields(
  kind: string,
  fields: Record<string, unknown>,
  workspaceRoot: string,
  entityPath: string,
  schema?: PortableEntitySchemaRevisionSnapshot
): Promise<Record<string, unknown>> {
  const cloned = structuredClone(fields);
  if (!hasScientificSequenceField(schema)) return cloned;
  const sequence = record(cloned.sequence);
  if (sequence?.mode === 'file') {
    const sequencePath =
      typeof sequence.relPath === 'string' ? sequence.relPath.replace(/\\/g, '/') : null;
    if (sequence.pathBase !== 'workspace' || sequencePath !== entityPath) {
      throw new Error(
        'Native LIMS file sequence must match its authoritative workspace-relative path.'
      );
    }
    const absolutePath = `${workspaceRoot}/${entityPath}`;
    const { pathBase: _portablePathBase, ...portableSequence } = sequence;
    cloned.sequence =
      kind === 'protein'
        ? await buildFileAminoAcidSequenceRef(absolutePath)
        : kind === 'dna_sequence' || kind === 'rna_sequence'
          ? await buildFileDnaSequenceRef(absolutePath, { workspaceRoot })
          : { ...portableSequence, relPath: absolutePath };
  }
  return cloned;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isDatabaseBackedLimsManifestEntity(entity: NativeWorkspaceManifestAnyEntity): boolean {
  if (nativeWorkspaceEntityPlacement(entity).kind === 'catalog-record') return true;
  if (!entity.lims) return false;
  if (entity.lims.kind === 'strain') return true;
  const sequence = record(entity.lims.fields.sequence);
  return entity.lims.kind === 'dna_sequence' && sequence?.mode === 'unresolved';
}
