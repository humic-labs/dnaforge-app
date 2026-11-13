import { randomUUID } from 'node:crypto';
import { nativeFileSequenceFields } from './native-file-sequence-fields';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  NATIVE_WORKSPACE_MANIFEST_SCHEMA,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  serializeNativeWorkspaceManifest,
  type NativeWorkspaceManifest,
  type NativeWorkspaceManifestEntity,
  type NativeWorkspaceManifestEntityV2,
  type NativeWorkspaceManifestV2,
} from '../shared/native-workspace-manifest';
import { isAbsolutePathLike } from '../shared/path-boundary';
import type { NativeWorkspaceMaterializationPlan } from './native-workspace-materializer';
import { publishNativeCatalogBytes } from './native-catalog-publication';
import {
  hasScientificSequenceField,
  type PortableEntitySchemaRevisionSnapshot,
} from '../shared/entity-schema';

export async function writeNativeWorkspaceManifest(input: {
  workspacePath: string;
  plan: NativeWorkspaceMaterializationPlan;
  manifestVersion?: 1 | 2;
}): Promise<string> {
  return writeNativeWorkspaceManifestDocument({
    workspacePath: input.workspacePath,
    manifest: nativeWorkspaceManifestFromPlan(input),
  });
}

export function nativeWorkspaceManifestFromPlan(input: {
  workspacePath: string;
  plan: NativeWorkspaceMaterializationPlan;
  manifestVersion?: 1 | 2;
}): NativeWorkspaceManifest {
  if (input.manifestVersion === 2) return nativeWorkspaceManifestV2FromPlan(input);
  const limsByEntityRawId = new Map(
    (input.plan.limsEntities ?? []).map((entry) => [entry.entityRawId, entry.input])
  );
  const entities: NativeWorkspaceManifestEntity[] = input.plan.entities.map((entity) => {
    if (!entity.relativePath) {
      throw new Error(`Native workspace entity ${entity.rawId} has no portable file path.`);
    }
    const lims = limsByEntityRawId.get(entity.rawId);
    const sourceIdentities = entity.sourceIdentities ?? [];
    return {
      id: entity.rawId,
      type: entity.type,
      name: entity.name,
      path: entity.relativePath,
      fileKind: entity.fileKind ?? 'file',
      ...(entity.metadata ? { metadata: entity.metadata } : {}),
      ...(lims
        ? {
            lims: {
              kind: lims.kind,
              name: lims.name,
              fields: portableLimsFields(
                nativeFileSequenceFields({
                  fields: lims.fields,
                  kind: lims.kind,
                  documentId: entity.rawId,
                }),
                input.workspacePath,
                entity.relativePath,
                lims.schemaSnapshot
              ),
              ...(lims.schemaRevisionId ? { schemaRevisionId: lims.schemaRevisionId } : {}),
              ...(lims.schemaSnapshot ? { schemaSnapshot: lims.schemaSnapshot } : {}),
              ...(lims.registrationStatus ? { registrationStatus: lims.registrationStatus } : {}),
              ...(lims.domainStatus !== undefined ? { domainStatus: lims.domainStatus } : {}),
              ...(lims.createdAt !== undefined ? { createdAt: lims.createdAt } : {}),
            },
          }
        : {}),
      ...(sourceIdentities.length > 0 ? { sourceIdentities } : {}),
    };
  });
  return {
    schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
    entities,
    links: input.plan.links.map((link) => ({
      sourceId: link.sourceRawId,
      relation: link.relation,
      targetId: link.targetRawId,
      ...(link.confidence ? { confidence: link.confidence } : {}),
      ...(link.evidence ? { evidence: link.evidence } : {}),
    })),
    ...(input.plan.events.length > 0
      ? {
          events: input.plan.events.map((event) => ({
            id: event.id,
            entityId: event.entityRawId,
            eventType: event.eventType,
            actor: event.actor ?? 'system',
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {}),
            createdAt: event.createdAt,
          })),
        }
      : {}),
    ...((input.plan.limsLinks?.length ?? 0) > 0
      ? {
          limsLinks: input.plan.limsLinks?.map((link) => ({
            id: link.id,
            fromEntityId: link.fromEntityRawId,
            toEntityId: link.toEntityRawId,
            type: link.type,
            ...(link.payload ? { payload: link.payload } : {}),
          })),
        }
      : {}),
  };
}

function nativeWorkspaceManifestV2FromPlan(input: {
  workspacePath: string;
  plan: NativeWorkspaceMaterializationPlan;
}): NativeWorkspaceManifestV2 {
  const limsByEntityRawId = new Map(
    (input.plan.limsEntities ?? []).map((entry) => [entry.entityRawId, entry.input])
  );
  const entities: NativeWorkspaceManifestEntityV2[] = input.plan.entities.map((entity) => {
    if (!entity.placement) {
      throw new Error(`Native workspace entity ${entity.rawId} has no v2 placement.`);
    }
    const sourceIdentities = entity.sourceIdentities ?? [];
    const lims = limsByEntityRawId.get(entity.rawId);
    const physicalPrimaryPath =
      entity.placement.kind === 'file'
        ? entity.placement.relativePath
        : entity.placement.kind === 'package'
          ? entity.placement.primaryRelativePath
          : null;
    const manifestEntity: NativeWorkspaceManifestEntityV2 = {
      id: entity.rawId,
      type: entity.type,
      name: entity.name,
      placement: entity.placement,
      ...(entity.metadata ? { metadata: entity.metadata } : {}),
      ...(lims
        ? {
            lims: {
              kind: lims.kind,
              name: lims.name,
              fields: portableLimsFields(
                nativeFileSequenceFields({
                  fields: lims.fields,
                  kind: lims.kind,
                  documentId: entity.rawId,
                }),
                input.workspacePath,
                physicalPrimaryPath,
                lims.schemaSnapshot
              ),
              ...(lims.schemaRevisionId ? { schemaRevisionId: lims.schemaRevisionId } : {}),
              ...(lims.schemaSnapshot ? { schemaSnapshot: lims.schemaSnapshot } : {}),
              ...(lims.registrationStatus ? { registrationStatus: lims.registrationStatus } : {}),
              ...(lims.domainStatus !== undefined ? { domainStatus: lims.domainStatus } : {}),
              ...(lims.createdAt !== undefined ? { createdAt: lims.createdAt } : {}),
            },
          }
        : {}),
      ...(sourceIdentities.length > 0 ? { sourceIdentities } : {}),
      ...(entity.migrationSource ? { migrationSource: entity.migrationSource } : {}),
    };
    if (containsAbsoluteFileSystemPath(manifestEntity)) {
      throw new Error('Native workspace v2 manifest cannot contain an external source path.');
    }
    return manifestEntity;
  });
  return {
    schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
    entities,
    links: input.plan.links.map((link) => ({
      sourceId: link.sourceRawId,
      relation: link.relation,
      targetId: link.targetRawId,
      ...(link.confidence ? { confidence: link.confidence } : {}),
      ...(link.evidence ? { evidence: link.evidence } : {}),
    })),
    ...(input.plan.events.length > 0
      ? {
          events: input.plan.events.map((event) => ({
            id: event.id,
            entityId: event.entityRawId,
            eventType: event.eventType,
            actor: event.actor ?? 'system',
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {}),
            createdAt: event.createdAt,
          })),
        }
      : {}),
    ...((input.plan.limsLinks?.length ?? 0) > 0
      ? {
          limsLinks: input.plan.limsLinks?.map((link) => ({
            id: link.id,
            fromEntityId: link.fromEntityRawId,
            toEntityId: link.toEntityRawId,
            type: link.type,
            ...(link.payload ? { payload: link.payload } : {}),
          })),
        }
      : {}),
  };
}

export async function writeNativeWorkspaceManifestDocument(input: {
  workspacePath: string;
  manifest: NativeWorkspaceManifest;
  publication?: { operationId: string; beforeBytes: Buffer | null };
}): Promise<string> {
  if (input.publication)
    return publishNativeCatalogBytes({
      workspacePath: input.workspacePath,
      ...input.publication,
      afterBytes: Buffer.from(serializeNativeWorkspaceManifest(input.manifest)),
    });
  const manifestPath = join(input.workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH);
  await mkdir(dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serializeNativeWorkspaceManifest(input.manifest), 'utf8');
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return manifestPath;
}

export function portableLimsFields(
  fields: Record<string, unknown>,
  workspacePath: string,
  entityRelativePath: string | null,
  schema?: PortableEntitySchemaRevisionSnapshot
): Record<string, unknown> {
  const cloned = structuredClone(fields);
  if (!hasScientificSequenceField(schema)) return cloned;
  const sequence = record(cloned.sequence);
  if (sequence?.mode === 'file' && typeof sequence.relPath === 'string') {
    if (!entityRelativePath) {
      throw new Error('A catalog-record placement cannot carry a file-backed LIMS sequence.');
    }
    const normalizedRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/u, '');
    const normalizedPath = sequence.relPath.replace(/\\/g, '/');
    const expectedAbsolutePath = `${normalizedRoot}/${entityRelativePath}`;
    if (normalizedPath !== expectedAbsolutePath) {
      throw new Error('Native LIMS file projection does not match its catalog entity path.');
    }
    sequence.relPath = entityRelativePath;
    sequence.pathBase = 'workspace';
    if (typeof sequence.documentId === 'string')
      sequence.documentId = stripWorkspaceScope(sequence.documentId);
  }
  return cloned;
}

function containsAbsoluteFileSystemPath(value: unknown): boolean {
  if (typeof value === 'string') return isAbsolutePathLike(value);
  if (Array.isArray(value)) return value.some(containsAbsoluteFileSystemPath);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsAbsoluteFileSystemPath);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
