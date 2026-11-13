import { isSafeWorkspaceRelativePath } from './path-boundary';
import {
  parseReviewedRegistryTableRowRef,
  type ReviewedRegistryTableRowRef,
} from './benchling-registry-table-review';
import { parseSequenceClassificationDecision } from './oligo-classification';
import {
  isCatalogRecordPresentationKind,
  type CatalogRecordPresentationKind,
} from './catalog-entity';
import { LIMS_REGISTRATION_STATUSES, type LimsRegistrationStatus } from './lims';
import {
  isPortableEntitySchemaRevisionSnapshot,
  hasScientificSequenceField,
  type ProjectableEntitySchemaRevisionSnapshot,
} from './entity-schema';
import {
  isProviderObjectClass,
  isSafeProviderCanonicalUrl,
  providerObjectReferenceKey,
  PROVIDER_OBJECT_REFERENCE_PROVIDERS,
  isExactProviderStableId,
  type ProviderObjectClass,
  type ProviderObjectReferenceProvider,
} from './provider-object-reference';

export const NATIVE_WORKSPACE_MANIFEST_SCHEMA = 'dnaforge.native-workspace-manifest.v1' as const;
export const NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA = 'dnaforge.native-workspace-manifest.v2' as const;
export const NATIVE_WORKSPACE_MANIFEST_PATH = '.forge/catalog.json' as const;

export const NATIVE_WORKSPACE_ENTITY_TYPES = [
  'track-view',
  'molecular-document',
  'sequence',
  'primer',
  'notebook',
  'design',
  'alignment',
  'trace',
  'report',
  'construct',
  'sample',
  'record',
  'selection',
  'structure',
  'protein',
  'protocol',
  'protocol_run',
  'file',
  'folder',
] as const;

export type NativeWorkspaceManifestEntityType = (typeof NATIVE_WORKSPACE_ENTITY_TYPES)[number];

export const NATIVE_WORKSPACE_SOURCE_IDENTITY_BINDING_KINDS = ['observed', 'reviewed'] as const;
export type NativeWorkspaceSourceIdentityBindingKind =
  (typeof NATIVE_WORKSPACE_SOURCE_IDENTITY_BINDING_KINDS)[number];

export type NativeWorkspaceManifestSourceIdentity = {
  provider: ProviderObjectReferenceProvider;
  stableObjectId: string;
  objectClass: ProviderObjectClass;
  providerAccountHint?: string;
  canonicalUrl?: string;
  bindingKind: NativeWorkspaceSourceIdentityBindingKind;
};

export type NativeWorkspaceManifestEntity = {
  id: string;
  type: NativeWorkspaceManifestEntityType;
  name: string;
  path: string;
  fileKind: string;
  metadata?: Record<string, unknown>;
  lims?: {
    kind: string;
    name: string;
    fields: Record<string, unknown>;
    schemaRevisionId?: string;
    schemaSnapshot?: ProjectableEntitySchemaRevisionSnapshot;
    registrationStatus?: LimsRegistrationStatus;
    domainStatus?: string | null;
    createdAt?: number;
  };
  sourceIdentities?: NativeWorkspaceManifestSourceIdentity[];
};

export type NativeWorkspacePlacement =
  | Readonly<{ kind: 'file'; relativePath: string; fileKind: string }>
  | Readonly<{
      kind: 'package';
      rootRelativePath: string;
      primaryRelativePath: string;
      fileKind: string;
    }>
  | Readonly<{
      kind: 'catalog-record';
      parentRelativePath: string;
      displayName: string;
      catalogType: NativeWorkspaceManifestEntityType;
      presentationKind: CatalogRecordPresentationKind;
    }>;

export type NativeWorkspaceMigrationSourceRef = Readonly<{
  historyRunId: string;
  sourceId: string;
  sourceObjectId: string;
}> &
  (
    | Readonly<{ kind?: never; reviewedTable?: never }>
    | Readonly<{ kind: 'reviewed_table_row'; reviewedTable: ReviewedRegistryTableRowRef }>
  );

export type NativeWorkspaceManifestEntityV2 = Omit<
  NativeWorkspaceManifestEntity,
  'path' | 'fileKind'
> & {
  placement: NativeWorkspacePlacement;
  migrationSource?: NativeWorkspaceMigrationSourceRef;
  lifecycle?: NativeWorkspaceRecordLifecycle;
};

export type NativeWorkspaceRecordLifecycle =
  | Readonly<{ state: 'active' }>
  | Readonly<{ state: 'archived'; archivedAt: number }>;

export type NativeWorkspaceManifestLink = {
  sourceId: string;
  relation: string;
  targetId: string;
  confidence?: 'suggested' | 'confirmed' | 'rejected';
  evidence?: Record<string, unknown>;
};

export type NativeWorkspaceManifestV1 = {
  schema: typeof NATIVE_WORKSPACE_MANIFEST_SCHEMA;
  entities: NativeWorkspaceManifestEntity[];
  links: NativeWorkspaceManifestLink[];
  events?: Array<{
    id: string;
    entityId: string;
    eventType: string;
    actor: string;
    summary?: string | null;
    payload?: Record<string, unknown> | null;
    createdAt: number;
  }>;
  limsLinks?: Array<{
    id: string;
    fromEntityId: string;
    toEntityId: string;
    type: string;
    payload?: Record<string, unknown>;
  }>;
};

export type NativeWorkspaceManifestV2 = Omit<NativeWorkspaceManifestV1, 'schema' | 'entities'> & {
  schema: typeof NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA;
  entities: NativeWorkspaceManifestEntityV2[];
};

export type NativeWorkspaceManifest = NativeWorkspaceManifestV1 | NativeWorkspaceManifestV2;
export type NativeWorkspaceManifestAnyEntity =
  | NativeWorkspaceManifestEntity
  | NativeWorkspaceManifestEntityV2;
export type NativeWorkspaceAtomicSequenceProjectionEntity = NativeWorkspaceManifestEntityV2 & {
  type: 'sequence';
  placement: Extract<NativeWorkspacePlacement, { kind: 'file' }>;
  lims: NonNullable<NativeWorkspaceManifestEntityV2['lims']>;
};

export function nativeWorkspaceUsesAtomicSequenceProjection(
  entity: NativeWorkspaceManifestAnyEntity
): entity is NativeWorkspaceAtomicSequenceProjectionEntity {
  return (
    'placement' in entity &&
    entity.placement.kind === 'file' &&
    entity.type === 'sequence' &&
    entity.lims !== undefined &&
    (entity.metadata?.classificationDecision !== undefined ||
      entity.lims.kind === 'dna_sequence' ||
      entity.lims.kind === 'rna_sequence')
  );
}

export function nativeWorkspaceEntityPlacement(
  entity: NativeWorkspaceManifestAnyEntity
): NativeWorkspacePlacement {
  if ('placement' in entity) return entity.placement;
  return { kind: 'file', relativePath: entity.path, fileKind: entity.fileKind };
}

export function nativeWorkspaceEntityPhysicalRoot(
  entity: NativeWorkspaceManifestAnyEntity
): string | null {
  const placement = nativeWorkspaceEntityPlacement(entity);
  return placement.kind === 'file'
    ? placement.relativePath
    : placement.kind === 'package'
      ? placement.rootRelativePath
      : null;
}

export function nativeWorkspaceEntityPrimaryFile(
  entity: NativeWorkspaceManifestAnyEntity
): string | null {
  const placement = nativeWorkspaceEntityPlacement(entity);
  return placement.kind === 'file'
    ? placement.relativePath
    : placement.kind === 'package'
      ? placement.primaryRelativePath
      : null;
}

export function nativeWorkspaceEntityDisplayPath(entity: NativeWorkspaceManifestAnyEntity): string {
  const physicalRoot = nativeWorkspaceEntityPhysicalRoot(entity);
  if (physicalRoot) return physicalRoot;
  const placement = nativeWorkspaceEntityPlacement(entity);
  if (placement.kind !== 'catalog-record') {
    throw new Error(`Native workspace entity ${entity.id} has no display path.`);
  }
  return placement.parentRelativePath
    ? `${placement.parentRelativePath}/${placement.displayName}`
    : placement.displayName;
}

export function nativeWorkspaceEntityFileKind(
  entity: NativeWorkspaceManifestAnyEntity
): string | null {
  const placement = nativeWorkspaceEntityPlacement(entity);
  return placement.kind === 'catalog-record' ? null : placement.fileKind;
}

export function parseNativeWorkspaceManifest(value: string): NativeWorkspaceManifest {
  return parseNativeManifest(value, new Set());
}

export function parseNativeWorkspaceManifestFragment(
  value: string,
  existingEntityIds: readonly string[]
): NativeWorkspaceManifest {
  return parseNativeManifest(value, new Set(existingEntityIds));
}

function parseNativeManifest(
  value: string,
  existingEntityIds: ReadonlySet<string>
): NativeWorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Native workspace catalog manifest is invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Native workspace catalog manifest must be an object.');
  }
  const input = parsed as Record<string, unknown>;
  if (input.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA) {
    return parseNativeWorkspaceManifestV2(input, existingEntityIds);
  }
  if (input.schema !== NATIVE_WORKSPACE_MANIFEST_SCHEMA) {
    throw new Error('Native workspace catalog manifest schema is unsupported.');
  }
  if (!Array.isArray(input.entities) || !Array.isArray(input.links)) {
    throw new Error('Native workspace catalog manifest is incomplete.');
  }

  const entityIds = new Set<string>();
  const paths = new Set<string>();
  const entities = input.entities.map((entry, index) => {
    const entity = requiredRecord(entry, `Entity ${index + 1}`);
    const id = requiredText(entity.id, `Entity ${index + 1} ID`);
    const type = requiredText(entity.type, `Entity ${id} type`);
    if (!NATIVE_WORKSPACE_ENTITY_TYPES.includes(type as NativeWorkspaceManifestEntityType)) {
      throw new Error(`Native workspace entity ${id} has an unsupported type.`);
    }
    const path = requiredText(entity.path, `Entity ${id} path`).replace(/\\/g, '/');
    if (!isSafeWorkspaceRelativePath(path)) {
      throw new Error(`Native workspace entity ${id} has an unsafe path.`);
    }
    if (entityIds.has(id)) throw new Error(`Native workspace entity ID is duplicated: ${id}`);
    if (paths.has(path)) throw new Error(`Native workspace entity path is duplicated: ${path}`);
    entityIds.add(id);
    paths.add(path);

    const metadata = optionalRecord(entity.metadata, `Entity ${id} metadata`);
    const limsRecord = optionalRecord(entity.lims, `Entity ${id} LIMS projection`);
    const lims = limsRecord
      ? {
          kind: requiredText(limsRecord.kind, `Entity ${id} LIMS kind`),
          name: requiredText(limsRecord.name, `Entity ${id} LIMS name`),
          fields: requiredRecord(limsRecord.fields, `Entity ${id} LIMS fields`),
          ...(limsRecord.schemaRevisionId === undefined
            ? {}
            : {
                schemaRevisionId: requiredText(
                  limsRecord.schemaRevisionId,
                  `Entity ${id} LIMS schema revision ID`
                ),
              }),
          ...(limsRecord.schemaSnapshot === undefined
            ? {}
            : {
                schemaSnapshot: parseProjectableSchemaSnapshot(
                  limsRecord.schemaSnapshot,
                  `Entity ${id} LIMS schema snapshot`
                ),
              }),
          ...(limsRecord.registrationStatus === undefined
            ? {}
            : {
                registrationStatus: requiredRegistrationStatus(
                  limsRecord.registrationStatus,
                  `Entity ${id} LIMS registration status`
                ),
              }),
          ...(limsRecord.domainStatus === undefined
            ? {}
            : {
                domainStatus:
                  limsRecord.domainStatus === null
                    ? null
                    : requiredText(limsRecord.domainStatus, `Entity ${id} LIMS domain status`),
              }),
          ...(limsRecord.createdAt === undefined
            ? {}
            : { createdAt: requiredTimestamp(limsRecord.createdAt, `Entity ${id} creation time`) }),
        }
      : undefined;
    if (lims && hasScientificSequenceField(lims.schemaSnapshot)) {
      validatePortableLimsProjection(id, path, lims.fields);
      if (
        lims.schemaSnapshot &&
        (lims.schemaSnapshot.name !== lims.kind ||
          lims.schemaSnapshot.schemaRevisionId !== lims.schemaRevisionId)
      ) {
        throw new Error(`Entity ${id} LIMS schema snapshot does not match its projection.`);
      }
    }

    const sourceIdentities = parsePortableSourceIdentities(entity.sourceIdentities, id);

    return {
      id,
      type: type as NativeWorkspaceManifestEntityType,
      name: requiredText(entity.name, `Entity ${id} name`),
      path,
      fileKind: requiredText(entity.fileKind, `Entity ${id} file kind`),
      ...(metadata ? { metadata } : {}),
      ...(lims ? { lims } : {}),
      ...(sourceIdentities.length > 0 ? { sourceIdentities } : {}),
    };
  });

  const linkKeys = new Set<string>();
  const links = input.links.map((entry, index) => {
    const link = requiredRecord(entry, `Link ${index + 1}`);
    const sourceId = requiredText(link.sourceId, `Link ${index + 1} source ID`);
    const relation = requiredText(link.relation, `Link ${index + 1} relation`);
    const targetId = requiredText(link.targetId, `Link ${index + 1} target ID`);
    if (
      (!entityIds.has(sourceId) && !existingEntityIds.has(sourceId)) ||
      (!entityIds.has(targetId) && !existingEntityIds.has(targetId))
    ) {
      throw new Error(
        `Native workspace link ${sourceId} -> ${targetId} references an unknown entity.`
      );
    }
    const key = `${sourceId}\u0000${relation}\u0000${targetId}`;
    if (linkKeys.has(key)) throw new Error('Native workspace catalog link is duplicated.');
    linkKeys.add(key);
    const confidence =
      link.confidence === undefined
        ? undefined
        : requiredConfidence(link.confidence, `Link ${index + 1} confidence`);
    const evidence = optionalRecord(link.evidence, `Link ${index + 1} evidence`);
    return {
      sourceId,
      relation,
      targetId,
      ...(confidence ? { confidence } : {}),
      ...(evidence ? { evidence } : {}),
    };
  });

  const eventIds = new Set<string>();
  const events = (
    input.events === undefined
      ? []
      : Array.isArray(input.events)
        ? input.events
        : (() => {
            throw new Error('Native workspace events must be an array.');
          })()
  ).map((entry, index) => {
    const event = requiredRecord(entry, `Event ${index + 1}`);
    const id = requiredText(event.id, `Event ${index + 1} ID`);
    const entityId = requiredText(event.entityId, `Event ${id} entity ID`);
    if (!entityIds.has(entityId))
      throw new Error(`Native workspace event ${id} has an unknown entity.`);
    if (eventIds.has(id)) throw new Error(`Native workspace event ID is duplicated: ${id}`);
    eventIds.add(id);
    const summary =
      event.summary === undefined || event.summary === null
        ? event.summary
        : requiredText(event.summary, `Event ${id} summary`);
    const payload =
      event.payload === null ? null : optionalRecord(event.payload, `Event ${id} payload`);
    return {
      id,
      entityId,
      eventType: requiredText(event.eventType, `Event ${id} type`),
      actor: requiredText(event.actor, `Event ${id} actor`),
      ...(summary !== undefined ? { summary } : {}),
      ...(payload !== undefined ? { payload } : {}),
      createdAt: requiredTimestamp(event.createdAt, `Event ${id} creation time`),
    };
  });

  const limsLinkKeys = new Set<string>();
  const limsLinks = (
    input.limsLinks === undefined
      ? []
      : Array.isArray(input.limsLinks)
        ? input.limsLinks
        : (() => {
            throw new Error('Native workspace LIMS links must be an array.');
          })()
  ).map((entry, index) => {
    const link = requiredRecord(entry, `LIMS link ${index + 1}`);
    const id = requiredText(link.id, `LIMS link ${index + 1} ID`);
    const fromEntityId = requiredText(link.fromEntityId, `LIMS link ${index + 1} source ID`);
    const toEntityId = requiredText(link.toEntityId, `LIMS link ${index + 1} target ID`);
    const type = requiredText(link.type, `LIMS link ${index + 1} type`);
    if (
      (!entityIds.has(fromEntityId) && !existingEntityIds.has(fromEntityId)) ||
      (!entityIds.has(toEntityId) && !existingEntityIds.has(toEntityId))
    ) {
      throw new Error(`Native workspace LIMS link ${id} references an unknown entity.`);
    }
    if (fromEntityId === toEntityId) throw new Error(`Native workspace LIMS link ${id} is cyclic.`);
    const key = `${fromEntityId}\u0000${type}\u0000${toEntityId}`;
    if (limsLinkKeys.has(key)) throw new Error('Native workspace LIMS link is duplicated.');
    limsLinkKeys.add(key);
    const payload = optionalRecord(link.payload, `LIMS link ${id} payload`);
    return { id, fromEntityId, toEntityId, type, ...(payload ? { payload } : {}) };
  });

  return {
    schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
    entities,
    links,
    ...(events.length > 0 ? { events } : {}),
    ...(limsLinks.length > 0 ? { limsLinks } : {}),
  };
}

function parseNativeWorkspaceManifestV2(
  input: Record<string, unknown>,
  existingEntityIds: ReadonlySet<string>
): NativeWorkspaceManifestV2 {
  assertExactRecordKeys(input, ['schema', 'entities', 'links', 'events', 'limsLinks'], 'Manifest');
  if (!Array.isArray(input.entities) || !Array.isArray(input.links)) {
    throw new Error('Native workspace catalog manifest is incomplete.');
  }

  const physicalLocations = new Set<string>();
  const virtualSiblings = new Set<string>();
  const parsedPlacements = input.entities.map((entry, index) => {
    const entity = requiredRecord(entry, `Entity ${index + 1}`);
    assertExactRecordKeys(
      entity,
      [
        'id',
        'type',
        'name',
        'placement',
        'metadata',
        'lims',
        'sourceIdentities',
        'migrationSource',
        'lifecycle',
      ],
      `Entity ${index + 1}`
    );
    const id = requiredText(entity.id, `Entity ${index + 1} ID`);
    const name = requiredText(entity.name, `Entity ${id} name`);
    const type = requiredText(entity.type, `Entity ${id} type`);
    if (!NATIVE_WORKSPACE_ENTITY_TYPES.includes(type as NativeWorkspaceManifestEntityType)) {
      throw new Error(`Native workspace entity ${id} has an unsupported type.`);
    }
    const placement = parseNativeWorkspacePlacement(entity.placement, id);
    const lifecycle = parseRecordLifecycle(entity.lifecycle, type, placement);
    if (placement.kind === 'catalog-record') {
      if (placement.catalogType !== type) {
        throw new Error(
          `Native workspace entity ${id} catalog type does not match its entity type.`
        );
      }
      if (placement.displayName !== name) {
        throw new Error(
          `Native workspace entity ${id} name does not match its catalog display name.`
        );
      }
      const siblingKey = `${normalizedPortablePath(placement.parentRelativePath)}\0${placement.displayName
        .normalize('NFC')
        .toLowerCase()}`;
      if (lifecycle?.state !== 'archived' && virtualSiblings.has(siblingKey)) {
        throw new Error(`Native workspace virtual sibling is duplicated: ${name}`);
      }
      if (lifecycle?.state !== 'archived') virtualSiblings.add(siblingKey);
    } else {
      const locations =
        placement.kind === 'file'
          ? [placement.relativePath]
          : [placement.rootRelativePath, placement.primaryRelativePath];
      for (const location of locations) {
        const key = normalizedPortablePath(location);
        if (physicalLocations.has(key)) {
          throw new Error(`Native workspace physical location is duplicated: ${location}`);
        }
        physicalLocations.add(key);
      }
    }
    const migrationSource = parseNativeWorkspaceMigrationSource(entity.migrationSource, id);
    return {
      id,
      name,
      type: type as NativeWorkspaceManifestEntityType,
      placement,
      migrationSource,
      lifecycle,
    };
  });

  const v1CompatibleEntities = input.entities.map((entry, index) => {
    const entity = requiredRecord(entry, `Entity ${index + 1}`);
    const parsed = parsedPlacements[index];
    if (!parsed) throw new Error('Native workspace v2 entity placement was lost.');
    const portablePath =
      parsed.placement.kind === 'file'
        ? parsed.placement.relativePath
        : parsed.placement.kind === 'package'
          ? parsed.placement.primaryRelativePath
          : `_catalog/${parsed.id}`;
    const fileKind =
      parsed.placement.kind === 'catalog-record'
        ? `catalog-record:${parsed.placement.presentationKind}`
        : parsed.placement.fileKind;
    return {
      id: parsed.id,
      type: parsed.type,
      name: parsed.name,
      path: portablePath,
      fileKind,
      ...(entity.metadata === undefined ? {} : { metadata: entity.metadata }),
      ...(entity.lims === undefined ? {} : { lims: entity.lims }),
      ...(entity.sourceIdentities === undefined
        ? {}
        : { sourceIdentities: entity.sourceIdentities }),
    };
  });
  const common = parseNativeManifest(
    JSON.stringify({
      schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
      entities: v1CompatibleEntities,
      links: input.links,
      ...(input.events === undefined ? {} : { events: input.events }),
      ...(input.limsLinks === undefined ? {} : { limsLinks: input.limsLinks }),
    }),
    existingEntityIds
  );
  if (common.schema !== NATIVE_WORKSPACE_MANIFEST_SCHEMA) {
    throw new Error('Native workspace v2 common validation returned the wrong schema.');
  }
  const placementById = new Map(parsedPlacements.map((entry) => [entry.id, entry] as const));
  return {
    schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
    entities: common.entities.map((entity) => {
      const parsed = placementById.get(entity.id);
      if (!parsed) throw new Error(`Native workspace entity ${entity.id} lost its placement.`);
      if (entity.metadata?.classificationDecision !== undefined) {
        const decision = parseSequenceClassificationDecision(
          entity.metadata.classificationDecision
        );
        const expectedKind =
          decision.choice.kind === 'keep_generic'
            ? decision.molecule === 'dna'
              ? 'dna_sequence'
              : 'rna_sequence'
            : decision.molecule === 'dna'
              ? 'oligo'
              : 'rna_oligo';
        const targetIds = new Set(
          entity.sourceIdentities
            ?.filter(
              (identity) =>
                identity.provider === 'benchling' &&
                identity.bindingKind === 'observed' &&
                identity.objectClass === 'sequence'
            )
            .map((identity) => identity.stableObjectId)
        );
        if (
          entity.type !== 'sequence' ||
          parsed.placement.kind !== 'file' ||
          !entity.lims ||
          entity.lims.kind !== expectedKind ||
          entity.lims.schemaSnapshot?.baseKind !== expectedKind ||
          targetIds.size !== 1 ||
          !targetIds.has(decision.targetSourceId) ||
          (decision.choice.kind === 'classify' &&
            (entity.lims.fields.use ?? null) !== decision.choice.use)
        )
          throw new Error(
            'Portable classification must match its sequence, schema, use, and source identity.'
          );
      }
      return {
        id: entity.id,
        type: entity.type,
        name: entity.name,
        placement: parsed.placement,
        ...(entity.metadata ? { metadata: entity.metadata } : {}),
        ...(entity.lims ? { lims: entity.lims } : {}),
        ...(entity.sourceIdentities ? { sourceIdentities: entity.sourceIdentities } : {}),
        ...(parsed.migrationSource ? { migrationSource: parsed.migrationSource } : {}),
        ...(parsed.lifecycle ? { lifecycle: parsed.lifecycle } : {}),
      };
    }),
    links: common.links,
    ...(common.events ? { events: common.events } : {}),
    ...(common.limsLinks ? { limsLinks: common.limsLinks } : {}),
  };
}

function parseRecordLifecycle(
  value: unknown,
  type: string,
  placement: NativeWorkspacePlacement
): NativeWorkspaceRecordLifecycle | undefined {
  if (value === undefined) return undefined;
  if (
    !(
      (type === 'record' && placement.kind === 'catalog-record') ||
      (type === 'sequence' && placement.kind === 'file')
    )
  )
    throw new Error(
      'Portable lifecycle is only supported for catalog records and native sequence files.'
    );
  const lifecycle = requiredRecord(value, 'Record lifecycle');
  if (lifecycle.state === 'active') {
    assertExactRecordKeys(lifecycle, ['state'], 'Active record lifecycle');
    return { state: 'active' };
  }
  assertExactRecordKeys(lifecycle, ['state', 'archivedAt'], 'Archived record lifecycle');
  if (
    lifecycle.state !== 'archived' ||
    typeof lifecycle.archivedAt !== 'number' ||
    !Number.isSafeInteger(lifecycle.archivedAt) ||
    lifecycle.archivedAt < 0
  )
    throw new Error('Archived record lifecycle requires a valid archive time.');
  return { state: 'archived', archivedAt: lifecycle.archivedAt };
}

function parseNativeWorkspacePlacement(value: unknown, entityId: string): NativeWorkspacePlacement {
  const placement = requiredRecord(value, `Entity ${entityId} placement`);
  if (placement.kind === 'file') {
    assertExactRecordKeys(
      placement,
      ['kind', 'relativePath', 'fileKind'],
      `Entity ${entityId} placement`
    );
    return {
      kind: 'file',
      relativePath: requiredPortableEntityPath(placement.relativePath, entityId),
      fileKind: requiredText(placement.fileKind, `Entity ${entityId} file kind`),
    };
  }
  if (placement.kind === 'package') {
    assertExactRecordKeys(
      placement,
      ['kind', 'rootRelativePath', 'primaryRelativePath', 'fileKind'],
      `Entity ${entityId} placement`
    );
    const rootRelativePath = requiredPortableEntityPath(placement.rootRelativePath, entityId);
    const primaryRelativePath = requiredPortableEntityPath(placement.primaryRelativePath, entityId);
    if (
      !normalizedPortablePath(primaryRelativePath).startsWith(
        `${normalizedPortablePath(rootRelativePath)}/`
      )
    ) {
      throw new Error(
        `Native workspace entity ${entityId} primary path must be inside its package root.`
      );
    }
    return {
      kind: 'package',
      rootRelativePath,
      primaryRelativePath,
      fileKind: requiredText(placement.fileKind, `Entity ${entityId} file kind`),
    };
  }
  if (placement.kind === 'catalog-record') {
    assertExactRecordKeys(
      placement,
      ['kind', 'parentRelativePath', 'displayName', 'catalogType', 'presentationKind'],
      `Entity ${entityId} placement`
    );
    const parentRelativePath =
      placement.parentRelativePath === ''
        ? ''
        : requiredPortableEntityPath(placement.parentRelativePath, entityId);
    const catalogType = requiredText(placement.catalogType, `Entity ${entityId} catalog type`);
    if (!NATIVE_WORKSPACE_ENTITY_TYPES.includes(catalogType as NativeWorkspaceManifestEntityType)) {
      throw new Error(`Native workspace entity ${entityId} catalog type is unsupported.`);
    }
    if (!isCatalogRecordPresentationKind(placement.presentationKind)) {
      throw new Error(`Native workspace entity ${entityId} presentation kind is unsupported.`);
    }
    return {
      kind: 'catalog-record',
      parentRelativePath,
      displayName: requiredText(placement.displayName, `Entity ${entityId} display name`),
      catalogType: catalogType as NativeWorkspaceManifestEntityType,
      presentationKind: placement.presentationKind,
    };
  }
  throw new Error(`Native workspace entity ${entityId} placement kind is unsupported.`);
}

export function parseNativeWorkspaceMigrationSource(
  value: unknown,
  entityId: string
): NativeWorkspaceMigrationSourceRef | undefined {
  if (value === undefined) return undefined;
  const source = requiredRecord(value, `Entity ${entityId} migration source`);
  assertExactRecordKeys(
    source,
    [
      'historyRunId',
      'sourceId',
      'sourceObjectId',
      ...(source.kind === 'reviewed_table_row' ? ['kind', 'reviewedTable'] : []),
    ],
    `Entity ${entityId} migration source`
  );
  const historyRunId = requiredText(source.historyRunId, `Entity ${entityId} migration source run`);
  const sourceId = requiredText(source.sourceId, `Entity ${entityId} migration source ID`);
  if (!/^external-zip-[a-f0-9]{24}$/u.test(sourceId)) {
    throw new Error(`Entity ${entityId} migration source ID is invalid.`);
  }
  if (source.kind === 'reviewed_table_row') {
    const sourceObjectId = requiredText(
      source.sourceObjectId,
      `Entity ${entityId} reviewed row ID`
    );
    if (
      !/^local-row-[a-f0-9]{64}$/u.test(sourceObjectId) &&
      !/^bfi_[A-Za-z0-9]+$/u.test(sourceObjectId)
    )
      throw new Error('Reviewed table source row ID is invalid.');
    return {
      historyRunId,
      sourceId,
      sourceObjectId,
      kind: 'reviewed_table_row',
      reviewedTable: parseReviewedRegistryTableRowRef(source.reviewedTable),
    };
  }
  const sourceObjectId = requiredProviderStableObjectId(
    source.sourceObjectId,
    `Entity ${entityId} migration source object ID`
  );
  return { historyRunId, sourceId, sourceObjectId };
}

function requiredPortableEntityPath(value: unknown, entityId: string): string {
  const path = requiredText(value, `Entity ${entityId} path`).replace(/\\/g, '/');
  if (!isSafeWorkspaceRelativePath(path)) {
    throw new Error(`Native workspace entity ${entityId} has an unsafe path.`);
  }
  const topLevel = path.split('/')[0]?.normalize('NFC').toLowerCase();
  if (topLevel && ['.git', '.dnaforge', '.forge', '.waypoint'].includes(topLevel)) {
    throw new Error(`Native workspace entity ${entityId} uses a protected top-level path.`);
  }
  return path;
}

function normalizedPortablePath(path: string): string {
  return path.normalize('NFC').replace(/\\/g, '/').toLowerCase();
}

function assertExactRecordKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} has an unsupported field: ${unexpected.sort()[0]}`);
  }
}

function validatePortableLimsProjection(
  entityId: string,
  entityPath: string,
  fields: Record<string, unknown>
): void {
  const sequence = optionalRecord(fields.sequence, `Entity ${entityId} LIMS sequence`);
  if (!sequence || sequence.mode !== 'file') return;
  if (sequence.pathBase !== 'workspace') {
    throw new Error(`Entity ${entityId} LIMS file sequence must use the workspace path base.`);
  }
  if (typeof sequence.relPath !== 'string') {
    throw new Error(`Entity ${entityId} LIMS file sequence path is invalid.`);
  }
  const sequencePath = sequence.relPath.replace(/\\/g, '/');
  if (!isSafeWorkspaceRelativePath(sequencePath) || sequencePath !== entityPath) {
    throw new Error(
      `Entity ${entityId} LIMS file sequence must match its authoritative entity path.`
    );
  }
  if (!Number.isSafeInteger(sequence.length) || (sequence.length as number) < 0) {
    throw new Error(`Entity ${entityId} LIMS file sequence length is invalid.`);
  }
}

function parsePortableSourceIdentities(
  value: unknown,
  entityId: string
): NativeWorkspaceManifestSourceIdentity[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Native workspace entity ${entityId} source identities must be an array.`);
  }
  const keys = new Set<string>();
  const identities = value.map((entry, index) => {
    const label = `Entity ${entityId} source identity ${index + 1}`;
    const record = requiredRecord(entry, label);
    const identity: NativeWorkspaceManifestSourceIdentity = {
      provider: requiredProviderName(record.provider, `${label} provider`),
      stableObjectId: requiredProviderStableObjectId(
        record.stableObjectId,
        `${label} stable object ID`
      ),
      objectClass: requiredProviderObjectClass(record.objectClass, `${label} object class`),
      ...(record.providerAccountHint === undefined
        ? {}
        : {
            providerAccountHint: requiredText(
              record.providerAccountHint,
              `${label} provider account hint`
            ),
          }),
      ...(record.canonicalUrl === undefined
        ? {}
        : {
            canonicalUrl: requiredProviderCanonicalUrl(
              record.canonicalUrl,
              `${label} canonical URL`
            ),
          }),
      bindingKind: requiredSourceIdentityBindingKind(record.bindingKind, `${label} binding kind`),
    };
    const key = providerObjectReferenceKey(identity);
    if (keys.has(key)) {
      throw new Error(
        `Native workspace entity ${entityId} source identity is duplicated: ${identity.stableObjectId}`
      );
    }
    keys.add(key);
    return identity;
  });
  return identities.sort((left, right) => {
    const leftKey = providerObjectReferenceKey(left);
    const rightKey = providerObjectReferenceKey(right);
    if (leftKey === rightKey) return 0;
    return leftKey < rightKey ? -1 : 1;
  });
}

export function serializeNativeWorkspaceManifest(manifest: NativeWorkspaceManifest): string {
  const validated = parseNativeWorkspaceManifest(JSON.stringify(manifest));
  return `${JSON.stringify(validated, null, 2)}\n`;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requiredRecord(value, label);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || containsControlCharacter(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function parseProjectableSchemaSnapshot(
  value: unknown,
  label: string
): ProjectableEntitySchemaRevisionSnapshot {
  if (
    !isPortableEntitySchemaRevisionSnapshot(value) ||
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 1
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return { ...value, version: value.version };
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function requiredTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requiredRegistrationStatus(value: unknown, label: string): LimsRegistrationStatus {
  if (!LIMS_REGISTRATION_STATUSES.includes(value as LimsRegistrationStatus)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as LimsRegistrationStatus;
}

function requiredProviderName(value: unknown, label: string): ProviderObjectReferenceProvider {
  if (!PROVIDER_OBJECT_REFERENCE_PROVIDERS.includes(value as ProviderObjectReferenceProvider)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as ProviderObjectReferenceProvider;
}

function requiredProviderStableObjectId(value: unknown, label: string): string {
  const stableObjectId = requiredText(value, label);
  if (!isExactProviderStableId(stableObjectId)) throw new Error(`${label} is invalid.`);
  return stableObjectId;
}

function requiredProviderObjectClass(value: unknown, label: string): ProviderObjectClass {
  if (!isProviderObjectClass(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredProviderCanonicalUrl(value: unknown, label: string): string {
  if (!isSafeProviderCanonicalUrl(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredSourceIdentityBindingKind(
  value: unknown,
  label: string
): NativeWorkspaceSourceIdentityBindingKind {
  if (
    !NATIVE_WORKSPACE_SOURCE_IDENTITY_BINDING_KINDS.includes(
      value as NativeWorkspaceSourceIdentityBindingKind
    )
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value as NativeWorkspaceSourceIdentityBindingKind;
}

function requiredConfidence(value: unknown, label: string): 'suggested' | 'confirmed' | 'rejected' {
  if (value !== 'suggested' && value !== 'confirmed' && value !== 'rejected') {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
