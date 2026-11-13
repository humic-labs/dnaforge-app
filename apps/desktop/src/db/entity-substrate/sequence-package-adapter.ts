import { platform } from '../../platform';
import { readSequenceProductSummaryOffThread } from './sequence-product-summary-client';
import {
  fromPackageRelative,
  isSequencePackageMetaPath,
  parseSequencePackageDocument,
  sequencePackageRootForMetaPath,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from '../sequence-package';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
  type ManagedSequenceContentSummary,
} from '../../shared/managed-sequence-document';
import {
  MANAGED_SEQUENCE_PROJECTION_VERSION,
  MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD,
  projectManagedSequenceRegistry,
  managedSequenceProjectionVersionForExistingRecord,
  type ManagedSequenceProjectionVersion,
  semanticManagedSequenceProjectionFields,
} from '../../shared/managed-sequence-registry-projection';
import {
  isLegacyAcceptedPlasmidPackage,
  legacyAcceptedPlasmidProjectionId,
  matchesLegacyAcceptedPlasmidProjection,
  needsLegacyAcceptedPlasmidReconstruction,
} from '../../shared/legacy-accepted-plasmid-reconstruction';
import type { LimsEntity } from '../../shared/lims';
import {
  registerEntityAdapter,
  type EntityProjectionState,
  type WorkspaceEntityAdapter,
} from './adapter';

import { contentFingerprint } from '../../shared/content-fingerprint';

const productSummaryByDocument = new WeakMap<
  SequencePackageDocument,
  ManagedSequenceContentSummary
>();
const projectionVersionByDocument = new WeakMap<
  SequencePackageDocument,
  ManagedSequenceProjectionVersion
>();
const markerContentByDocument = new WeakMap<SequencePackageDocument, string>();
const packageContentHashByDocument = new WeakMap<SequencePackageDocument, string>();
const productContentHashByDocument = new WeakMap<SequencePackageDocument, string>();

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)])
  );
}

async function packageProjectionFingerprint(doc: SequencePackageDocument): Promise<string> {
  const projection = await projectManagedSequenceRegistry(
    doc,
    productSummaryByDocument.get(doc),
    projectionVersionByDocument.get(doc),
    markerContentByDocument.get(doc)
  );
  return contentFingerprint(
    JSON.stringify(
      canonicalValue({
        kind: projection.kind,
        name: projection.name,
        fields: projection.fields,
        registrationStatus: projection.registrationStatus,
        domainStatus: projection.domainStatus,
      })
    )
  );
}

async function parsePackageSource(
  bytes: string,
  path: string,
  fileMtimeMs: number
): Promise<{ document: SequencePackageDocument; fileMtimeMs: number }> {
  const document = parseSequencePackageDocument(bytes);
  markerContentByDocument.set(document, bytes);
  const [existing] = await platform().lims.queryEntities({
    id: document.id,
    includeArchived: true,
    limit: 1,
  });
  projectionVersionByDocument.set(
    document,
    managedSequenceProjectionVersionForExistingRecord(existing?.fields ?? {})
  );
  packageContentHashByDocument.set(document, await sha256Text(bytes));
  const packageRoot = sequencePackageRootForMetaPath(path);
  if (!packageRoot)
    throw new Error(`Cannot derive sequence package root from metadata path: ${path}`);
  const fs = platform().fs as
    | Partial<{
        readTextFile(path: string): Promise<string>;
        stat(path: string): Promise<{ mtime?: number | Date | null }>;
      }>
    | undefined;

  if (!fs?.readTextFile || !fs.stat) return { document, fileMtimeMs };
  const productPath = fromPackageRelative(document.product.file, packageRoot);
  const [content, stat] = await Promise.all([fs.readTextFile(productPath), fs.stat(productPath)]);
  const summary = await readSequenceProductSummaryOffThread(content);
  productSummaryByDocument.set(document, summary);
  if (isLegacyAcceptedPlasmidPackage(document))
    productContentHashByDocument.set(document, await sha256Text(content));
  const productMtime =
    stat.mtime instanceof Date
      ? stat.mtime.getTime()
      : typeof stat.mtime === 'number'
        ? stat.mtime
        : 0;
  return { document, fileMtimeMs: Math.max(fileMtimeMs, productMtime) };
}

function entityProjectionFingerprint(entity: {
  kind: string;
  name: string;
  fields: Record<string, unknown>;
  registrationStatus: string;
  domainStatus: string | null;
}): string {
  return contentFingerprint(
    JSON.stringify(
      canonicalValue({
        kind: entity.kind,
        name: entity.name,
        fields: semanticManagedSequenceProjectionFields(entity.fields),
        registrationStatus: entity.registrationStatus,
        domainStatus: entity.domainStatus,
      })
    )
  );
}

async function reconstructLegacyAcceptedPlasmidSource(
  doc: SequencePackageDocument,
  existing: LimsEntity,
  path: string,
  packageRoot: string,
  ctx: Parameters<WorkspaceEntityAdapter<SequencePackageDocument>['writeProjection']>[4],
  expectedContentHash: string
): Promise<SequencePackageDocument> {
  if (!needsLegacyAcceptedPlasmidReconstruction(doc, existing)) return doc;
  if (ctx.workspaceId == null)
    throw new Error('Legacy Plasmid reconstruction requires a project owner.');
  const expectedProductSha256 = productContentHashByDocument.get(doc);
  if (!expectedProductSha256)
    throw new Error(
      'Reload the legacy Plasmid package before reconstructing its unchecked product source.'
    );
  const result = await platform().lims.reconstructLegacyAcceptedPlasmid(
    {
      workspaceId: ctx.workspaceId,
      packageId: doc.id,
      metadataPath: path,
      expectedMetadataSha256: expectedContentHash,
      expectedProductSha256,
    },
    ctx.mutationToken
  );
  if (result.kind === 'not-applicable') return doc;
  const [metadata, product] = await Promise.all([
    platform().fs.readTextFile(path),
    platform().fs.readTextFile(fromPackageRelative(doc.product.file, packageRoot)),
  ]);
  if (
    (await sha256Text(metadata)) !== result.metadataSha256 ||
    (await sha256Text(product)) !== expectedProductSha256
  )
    throw new Error('The reconstructed Plasmid source changed before its Registry projection.');
  const adopted = parseSequencePackageDocument(metadata);
  if (adopted.id !== doc.id || adopted.product.file !== doc.product.file)
    throw new Error('The reconstructed Plasmid no longer matches its checked package identity.');
  markerContentByDocument.set(adopted, metadata);
  packageContentHashByDocument.set(adopted, result.metadataSha256);
  productContentHashByDocument.set(adopted, expectedProductSha256);
  return adopted;
}

async function findLegacyAcceptedPlasmidProjection(
  doc: SequencePackageDocument,
  packageRoot: string
): Promise<LimsEntity | null> {
  const legacyId = legacyAcceptedPlasmidProjectionId(doc);
  if (!legacyId) return null;
  const [legacy] = await platform().lims.queryEntities({
    id: legacyId,
    includeArchived: true,
    limit: 1,
  });
  return legacy && matchesLegacyAcceptedPlasmidProjection(doc, packageRoot, legacy) ? legacy : null;
}

export const sequencePackageEntityAdapter: WorkspaceEntityAdapter<SequencePackageDocument> = {
  kind: 'sequence',

  projectionVersion: 2,

  matchesPath(path) {
    return isSequencePackageMetaPath(path);
  },

  parse(bytes) {
    const document = parseSequencePackageDocument(bytes);
    markerContentByDocument.set(document, bytes);
    return document;
  },

  parseSource: parsePackageSource,

  serialize(doc) {
    return serializeSequencePackageDocument(doc);
  },

  identity(doc) {
    return doc.id;
  },

  projectionFingerprint(doc) {
    return packageProjectionFingerprint(doc);
  },

  async getProjection(id, ctx, path): Promise<EntityProjectionState | null> {
    if (ctx.workspaceId == null) {
      throw new Error('A file-authoritative sequence projection requires a project owner.');
    }
    const [entity] = await platform().lims.queryEntities({ id, includeArchived: true, limit: 1 });
    if (!entity || entity.tombstone) return null;
    const packageRoot = sequencePackageRootForMetaPath(path);
    const managedDocument = readManagedSequenceDocumentRef(
      entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]
    );
    return {
      fingerprint: entityProjectionFingerprint(entity),
      updatedAtMs: entity.updatedAt,
      sourceBindingMatches:
        entity.workspaceId === ctx.workspaceId &&
        managedDocument?.packageId === id &&
        managedDocument.packageRoot === packageRoot &&
        (entity.fields[MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD] === 2 ||
          entity.fields[MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD] ===
            MANAGED_SEQUENCE_PROJECTION_VERSION),
    };
  },

  async writeProjection(doc, id, _fileMtimeMs, path, ctx) {
    if (ctx.workspaceId == null) {
      throw new Error('A file-authoritative sequence projection requires a project owner.');
    }
    const [existing] = await platform().lims.queryEntities({ id, includeArchived: true, limit: 1 });
    const packageRoot = sequencePackageRootForMetaPath(path);
    if (!packageRoot) {
      throw new Error(`Cannot derive sequence package root from metadata path: ${path}`);
    }
    const packageContentHash = packageContentHashByDocument.get(doc);
    if (!packageContentHash) {
      throw new Error('Sequence package projection requires the exact source content hash.');
    }
    const legacy = await findLegacyAcceptedPlasmidProjection(doc, packageRoot);
    const authoritySource = legacy ?? existing;
    const authoritativeDoc = authoritySource
      ? await reconstructLegacyAcceptedPlasmidSource(
          doc,
          authoritySource,
          path,
          packageRoot,
          ctx,
          packageContentHash
        )
      : doc;
    const projectionVersion = managedSequenceProjectionVersionForExistingRecord(
      authoritySource?.fields ?? {}
    );
    projectionVersionByDocument.set(authoritativeDoc, projectionVersion);
    const markerContent = markerContentByDocument.get(authoritativeDoc);
    if (markerContent === undefined)
      throw new Error('Sequence package projection requires its exact saved marker bytes.');
    markerContentByDocument.set(authoritativeDoc, markerContent);
    const projection = await projectManagedSequenceRegistry(
      authoritativeDoc,
      productSummaryByDocument.get(doc),
      projectionVersion,
      markerContent
    );
    const fields = {
      ...projection.fields,
      [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
        kind: 'managed-sequence',
        packageId: id,
        packageRoot,
      },
    };
    await (!existing
      ? platform().lims.registerEntity(
          {
            ...projection,
            id,
            fields,
            schemaRevisionId: projection.schemaRevisionId,
            schemaSnapshot: projection.schemaSnapshot,
            registrationStatus: projection.registrationStatus,
            domainStatus: projection.domainStatus,
            workspaceId: ctx.workspaceId,
            actor: 'workspace-reconcile',
          },
          ctx.mutationToken
        )
      : platform().lims.updateEntity(
          {
            id,
            name: projection.name,
            fields,
            replaceFields: true,
            projectionSchema: {
              kind: projection.kind,
              schemaRevisionId: projection.schemaRevisionId,
              schemaSnapshot: projection.schemaSnapshot,
            },
            registrationStatus: projection.registrationStatus,
            domainStatus: projection.domainStatus,
            workspaceId: ctx.workspaceId,
            actor: 'workspace-reconcile',
          },
          ctx.mutationToken
        ));
    if (existing?.tombstone && !authoritativeDoc.entity.lifecycle?.archived) {
      await platform().lims.restoreEntity({ id, actor: 'workspace-reconcile' }, ctx.mutationToken);
    }
    if (legacy) {
      await platform().lims.archiveEntity(
        { id: legacy.id, actor: 'workspace-reconcile' },
        ctx.mutationToken
      );
    }
    const summary = productSummaryByDocument.get(doc);
    if (summary) productSummaryByDocument.set(authoritativeDoc, summary);
    return { sourceDocument: authoritativeDoc };
  },

  async reconcileRelationships(doc, id, _path, ctx) {
    if (doc.entity.lifecycle?.archived) return;
    const outgoing = doc.entity.relationships.map((relationship) => {
      if (relationship.fromEntityId !== id) {
        throw new Error(
          `Sequence package ${id} cannot own an outgoing relationship from ${relationship.fromEntityId}.`
        );
      }
      return {
        toEntityId: relationship.toEntityId,
        type: relationship.type,
        payload: relationship.payload,
      };
    });
    await platform().lims.replaceOutgoingRelationships(
      {
        entityId: id,
        relationships: outgoing,
        actor: 'workspace-reconcile',
        workspaceId: ctx.workspaceId,
      },
      ctx.mutationToken
    );
  },
};

let registered = false;

export function registerSequencePackageEntityAdapter(): void {
  if (registered) return;
  registered = true;
  registerEntityAdapter(sequencePackageEntityAdapter);
}
