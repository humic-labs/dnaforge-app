import type { ArtifactHistoryPort } from '../artifact-operation-ports';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../path-boundary';
import type {
  LimsImportPlan,
  LimsImportPlanMappingConfidence,
  LimsImportPlanSourceKind,
  LimsImportColumnMappingMode,
} from '../lims';
import { sha256Hex } from '../sha256';

import type { ArtifactIO } from '../artifact-io';

export interface ImportSetPersistenceDependencies {
  fs: Pick<
    ArtifactIO['fs'],
    | 'exists'
    | 'readFile'
    | 'readTextFile'
    | 'sha256File'
    | 'writeWorkspaceBinaryFileAtomic'
    | 'writeWorkspaceTextFileAtomic'
  >;
  isGitRepo: ArtifactHistoryPort['isGitRepo'];
  commitPaths: ArtifactHistoryPort['gitCommitPaths'];
}

export const IMPORT_SET_SCHEMA = 'dnaforge.import-set' as const;
export const IMPORT_SET_SCHEMA_VERSION = 1 as const;

export interface ImportSetColumnMappingV1 {
  sourceColumn: string;
  mappedField?: string;
  mappingMode: LimsImportColumnMappingMode;
  confidence: LimsImportPlanMappingConfidence;
}

export interface ImportSetSourceV1 {
  type: 'file' | 'paste' | 'connector';
  name: string;
  kind: LimsImportPlanSourceKind;
  fingerprint: string;
  snapshotRelativePath?: string;
  connectorType?: string;
  connectionId?: string;
  externalDocumentId?: string;
  externalSheetId?: string;
  revisionToken?: string;
}

export interface ImportSetPartitionV1 {
  sourcePartition?: string;
  forcedKind?: string;
  mappings: ImportSetColumnMappingV1[];
  members: ImportSetMemberV1[];
}

export interface ImportSetMemberV1 {
  sourceRecordId: string;
  sourceRowId: string;
  sourceRow?: number;
  externalRowId?: string;
  entityId: string;
  entityKind: string;
  artifactRelativePath: string;
}

export interface ImportSetManifestV1 {
  schema: typeof IMPORT_SET_SCHEMA;
  schemaVersion: typeof IMPORT_SET_SCHEMA_VERSION;
  id: string;
  manifestRelativePath: string;
  destinationRelativePath: string;
  source: ImportSetSourceV1;
  partitions: ImportSetPartitionV1[];
  createdAt: string;
  updatedAt: string;
}

export interface ImportSetConnectorSource {
  connectorType: string;
  connectionId?: string;
  externalDocumentId: string;
  externalSheetId?: string;
  revisionToken?: string;
}

export interface PrepareImportSetSourceInput {
  plan: LimsImportPlan;
  sourcePath?: string;
  text?: string;
  arrayBuffer?: ArrayBuffer;
  connector?: ImportSetConnectorSource;
}

export interface PreparedImportSetSource {
  descriptor: Omit<ImportSetSourceV1, 'snapshotRelativePath'>;
  snapshotBytes?: Uint8Array;
}

export type ImportSetSourceInput = Omit<PrepareImportSetSourceInput, 'plan'>;
export interface ImportSetPartitionInput {
  plan: LimsImportPlan;
  members: ImportSetMemberV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function normalizeFingerprint(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function looksLikeUploadedFile(plan: LimsImportPlan): boolean {
  return /\.(csv|tsv|xlsx|xls|xlsm|txt|fasta|faa|fa|fas|fna|gb|gbk|genbank)$/i.test(
    plan.sourceName
  );
}

export async function prepareImportSetSource(
  input: PrepareImportSetSourceInput,
  dependencies?: Pick<ImportSetPersistenceDependencies, 'fs'>
): Promise<PreparedImportSetSource> {
  if (input.connector) {
    const connectorIdentity = {
      connectorType: input.connector.connectorType,
      connectionId: input.connector.connectionId,
      externalDocumentId: input.connector.externalDocumentId,
      externalSheetId: input.connector.externalSheetId,
    };
    return {
      descriptor: {
        type: 'connector',
        name: input.plan.sourceName,
        kind: input.plan.sourceKind,
        fingerprint: normalizeFingerprint(await sha256Hex(stableJson(connectorIdentity))),
        ...connectorIdentity,
        ...(input.connector.revisionToken ? { revisionToken: input.connector.revisionToken } : {}),
      },
    };
  }

  let snapshotBytes: Uint8Array | undefined;
  let fingerprint: string;
  if (input.arrayBuffer) {
    snapshotBytes = new Uint8Array(input.arrayBuffer.slice(0));
    fingerprint = await sha256Bytes(snapshotBytes);
  } else if (input.text !== undefined) {
    snapshotBytes = new TextEncoder().encode(input.text);
    fingerprint = await sha256Bytes(snapshotBytes);
  } else if (input.sourcePath) {
    const fs = dependencies?.fs;
    if (!fs) throw new Error('Import source file reading requires an explicit filesystem.');
    fingerprint = normalizeFingerprint(await fs.sha256File(input.sourcePath));
    snapshotBytes = await fs.readFile(input.sourcePath);
  } else {
    fingerprint = normalizeFingerprint(
      await sha256Hex(
        stableJson({
          columns: input.plan.columns,
          records: input.plan.records.map((record) => ({
            source: record.source,
            entity: record.entityDraft,
          })),
        })
      )
    );
  }

  return {
    descriptor: {
      type: snapshotBytes && looksLikeUploadedFile(input.plan) ? 'file' : 'paste',
      name: input.plan.sourceName,
      kind: input.plan.sourceKind,
      fingerprint,
    },
    ...(snapshotBytes ? { snapshotBytes } : {}),
  };
}

function sanitizeSnapshotName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return sanitized || 'source';
}

function manifestRelativePath(id: string): string {
  return `.waypoint/import-sets/${id}/manifest.json`;
}

function snapshotRelativePath(id: string, sourceName: string, fingerprint: string): string {
  const hash = fingerprint.replace(/^sha256:/, '').slice(0, 12);
  return `.waypoint/import-sets/${id}/source/${hash}-${sanitizeSnapshotName(sourceName)}`;
}

export async function buildImportSetManifest(input: {
  workspaceRoot: string;
  destinationDir: string;
  source: PreparedImportSetSource;
  partitions: Array<{ plan: LimsImportPlan; members: ImportSetMemberV1[] }>;
  now?: string;
}): Promise<ImportSetManifestV1> {
  const destinationRelativePath = pathRelativeToBoundary(input.destinationDir, input.workspaceRoot);
  if (destinationRelativePath === null) {
    throw new Error('Import destination must be inside the owning project.');
  }
  const identitySource =
    input.source.descriptor.type === 'connector'
      ? {
          type: input.source.descriptor.type,
          connectorType: input.source.descriptor.connectorType,
          connectionId: input.source.descriptor.connectionId,
          externalDocumentId: input.source.descriptor.externalDocumentId,
          externalSheetId: input.source.descriptor.externalSheetId,
        }
      : {
          type: input.source.descriptor.type,
          fingerprint: input.source.descriptor.fingerprint,
        };
  const identity = {
    source: identitySource,
    destinationRelativePath,
  };
  const id = `import-set-${(await sha256Hex(stableJson(identity))).slice(0, 32)}`;
  const timestamp = input.now ?? new Date().toISOString();
  const source: ImportSetSourceV1 = {
    ...input.source.descriptor,
    ...(input.source.snapshotBytes
      ? {
          snapshotRelativePath: snapshotRelativePath(
            id,
            input.source.descriptor.name,
            input.source.descriptor.fingerprint
          ),
        }
      : {}),
  };
  return {
    schema: IMPORT_SET_SCHEMA,
    schemaVersion: IMPORT_SET_SCHEMA_VERSION,
    id,
    manifestRelativePath: manifestRelativePath(id),
    destinationRelativePath,
    source,
    partitions: input.partitions.map(({ plan, members }) => ({
      ...(plan.selectedSheet ? { sourcePartition: plan.selectedSheet } : {}),
      ...(plan.forcedKind ? { forcedKind: plan.forcedKind } : {}),
      mappings: plan.columns.map((column) => ({
        sourceColumn: column.sourceColumn,
        ...(column.mappedField ? { mappedField: column.mappedField } : {}),
        mappingMode: column.mappingMode,
        confidence: column.confidence,
      })),
      members: members.map((member) => ({ ...member })),
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Import-set ${label} must be a non-empty string.`);
  }
  return value;
}

const SOURCE_KINDS = new Set<LimsImportPlanSourceKind>([
  'csv',
  'tsv',
  'xlsx',
  'genbank',
  'fasta',
  'mixed',
]);
const MAPPING_MODES = new Set<LimsImportColumnMappingMode>(['mapped', 'source_only', 'ignored']);
const MAPPING_CONFIDENCE = new Set<LimsImportPlanMappingConfidence>([
  'deterministic',
  'agent_suggested',
  'user_overridden',
  'learned',
]);

export function parseImportSetManifest(content: string): ImportSetManifestV1 {
  const raw: unknown = JSON.parse(content);
  if (!isRecord(raw) || raw.schema !== IMPORT_SET_SCHEMA) {
    throw new Error(`Not a ${IMPORT_SET_SCHEMA} manifest.`);
  }
  if (raw.schemaVersion !== IMPORT_SET_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported or newer import-set schema version: ${String(raw.schemaVersion)}.`
    );
  }
  if (!isRecord(raw.source) || !Array.isArray(raw.partitions)) {
    throw new Error('Import-set source or partitions are malformed.');
  }
  const sourceType = raw.source.type;
  const sourceKind = raw.source.kind;
  if (
    (sourceType !== 'file' && sourceType !== 'paste' && sourceType !== 'connector') ||
    typeof sourceKind !== 'string' ||
    !SOURCE_KINDS.has(sourceKind as LimsImportPlanSourceKind)
  ) {
    throw new Error('Import-set source type or kind is invalid.');
  }
  const source: ImportSetSourceV1 = {
    type: sourceType,
    name: requiredString(raw.source.name, 'source name'),
    kind: sourceKind as LimsImportPlanSourceKind,
    fingerprint: requiredString(raw.source.fingerprint, 'source fingerprint'),
    ...(typeof raw.source.snapshotRelativePath === 'string'
      ? { snapshotRelativePath: raw.source.snapshotRelativePath }
      : {}),
    ...(typeof raw.source.connectorType === 'string'
      ? { connectorType: raw.source.connectorType }
      : {}),
    ...(typeof raw.source.connectionId === 'string'
      ? { connectionId: raw.source.connectionId }
      : {}),
    ...(typeof raw.source.externalDocumentId === 'string'
      ? { externalDocumentId: raw.source.externalDocumentId }
      : {}),
    ...(typeof raw.source.externalSheetId === 'string'
      ? { externalSheetId: raw.source.externalSheetId }
      : {}),
    ...(typeof raw.source.revisionToken === 'string'
      ? { revisionToken: raw.source.revisionToken }
      : {}),
  };
  if (
    source.snapshotRelativePath !== undefined &&
    !isSafeWorkspaceRelativePath(source.snapshotRelativePath)
  ) {
    throw new Error('Import-set source snapshot path is invalid.');
  }
  const parseMapping = (value: unknown, label: string): ImportSetColumnMappingV1 => {
    if (!isRecord(value)) throw new Error(`Import-set ${label} is malformed.`);
    const mappingMode = value.mappingMode;
    const confidence = value.confidence;
    if (
      typeof mappingMode !== 'string' ||
      !MAPPING_MODES.has(mappingMode as LimsImportColumnMappingMode) ||
      typeof confidence !== 'string' ||
      !MAPPING_CONFIDENCE.has(confidence as LimsImportPlanMappingConfidence)
    ) {
      throw new Error(`Import-set ${label} is invalid.`);
    }
    return {
      sourceColumn: requiredString(value.sourceColumn, `${label} source column`),
      ...(typeof value.mappedField === 'string' ? { mappedField: value.mappedField } : {}),
      mappingMode: mappingMode as LimsImportColumnMappingMode,
      confidence: confidence as LimsImportPlanMappingConfidence,
    };
  };
  const parseMember = (value: unknown, label: string): ImportSetMemberV1 => {
    if (!isRecord(value)) throw new Error(`Import-set ${label} is malformed.`);
    const artifactRelativePath = requiredString(
      value.artifactRelativePath,
      `${label} artifact path`
    );
    if (!isSafeWorkspaceRelativePath(artifactRelativePath)) {
      throw new Error(`Import-set ${label} artifact path is invalid.`);
    }
    const entityKind = requiredString(value.entityKind, `${label} entity kind`);
    return {
      sourceRecordId: requiredString(value.sourceRecordId, `${label} record id`),
      sourceRowId: requiredString(value.sourceRowId, `${label} row id`),
      ...(typeof value.sourceRow === 'number' ? { sourceRow: value.sourceRow } : {}),
      ...(typeof value.externalRowId === 'string' ? { externalRowId: value.externalRowId } : {}),
      entityId: requiredString(value.entityId, `${label} entity id`),
      entityKind,
      artifactRelativePath,
    };
  };
  const partitions = raw.partitions.map((value, partitionIndex): ImportSetPartitionV1 => {
    if (!isRecord(value) || !Array.isArray(value.mappings) || !Array.isArray(value.members)) {
      throw new Error(`Import-set partition ${partitionIndex + 1} is malformed.`);
    }
    const forcedKind = typeof value.forcedKind === 'string' ? value.forcedKind : undefined;
    if (forcedKind !== undefined && (!forcedKind.trim() || forcedKind.length > 128)) {
      throw new Error(`Import-set partition ${partitionIndex + 1} entity kind is invalid.`);
    }
    return {
      ...(typeof value.sourcePartition === 'string'
        ? { sourcePartition: value.sourcePartition }
        : {}),
      ...(forcedKind !== undefined ? { forcedKind } : {}),
      mappings: value.mappings.map((mapping, mappingIndex) =>
        parseMapping(mapping, `partition ${partitionIndex + 1} mapping ${mappingIndex + 1}`)
      ),
      members: value.members.map((member, memberIndex) =>
        parseMember(member, `partition ${partitionIndex + 1} member ${memberIndex + 1}`)
      ),
    };
  });
  const manifestPath = requiredString(raw.manifestRelativePath, 'manifest path');
  const destinationRelativePath =
    typeof raw.destinationRelativePath === 'string' ? raw.destinationRelativePath : '';
  if (
    !isSafeWorkspaceRelativePath(manifestPath) ||
    (destinationRelativePath !== '' && !isSafeWorkspaceRelativePath(destinationRelativePath))
  ) {
    throw new Error('Import-set project-relative path is invalid.');
  }
  const createdAt = requiredString(raw.createdAt, 'createdAt');
  const updatedAt = requiredString(raw.updatedAt, 'updatedAt');
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error('Import-set timestamps are invalid.');
  }
  return {
    schema: IMPORT_SET_SCHEMA,
    schemaVersion: IMPORT_SET_SCHEMA_VERSION,
    id: requiredString(raw.id, 'id'),
    manifestRelativePath: manifestPath,
    destinationRelativePath,
    source,
    partitions,
    createdAt,
    updatedAt,
  };
}

export function serializeImportSetManifest(manifest: ImportSetManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function absoluteWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const separator = workspaceRoot.includes('\\') ? '\\' : '/';
  return `${workspaceRoot.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(
    /[\\/]/g,
    separator
  )}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export async function writeImportSet(
  input: {
    workspaceRoot: string;
    manifest: ImportSetManifestV1;
    source: PreparedImportSetSource;
    mutationToken?: string;
    mergePartitions?: boolean;
  },
  dependencies: ImportSetPersistenceDependencies
): Promise<{ relativePaths: string[] }> {
  const relativePaths: string[] = [];
  const snapshotPath = input.manifest.source.snapshotRelativePath;
  if (snapshotPath && input.source.snapshotBytes) {
    const absoluteSnapshotPath = absoluteWorkspacePath(input.workspaceRoot, snapshotPath);
    if (await dependencies.fs.exists(absoluteSnapshotPath)) {
      const existing = await dependencies.fs.readFile(absoluteSnapshotPath);
      if (!equalBytes(existing, input.source.snapshotBytes)) {
        throw new Error('Import source snapshot content does not match its fingerprinted path.');
      }
    } else {
      await dependencies.fs.writeWorkspaceBinaryFileAtomic({
        workspaceRoot: input.workspaceRoot,
        path: absoluteSnapshotPath,
        content: input.source.snapshotBytes,
        mutationToken: input.mutationToken,
        artifactNoun: 'import source snapshot',
      });
    }
    relativePaths.push(snapshotPath);
  }

  const absoluteManifestPath = absoluteWorkspacePath(
    input.workspaceRoot,
    input.manifest.manifestRelativePath
  );
  let content = serializeImportSetManifest(input.manifest);
  if (await dependencies.fs.exists(absoluteManifestPath)) {
    const priorContent = await dependencies.fs.readTextFile(absoluteManifestPath);
    const prior = parseImportSetManifest(priorContent);
    if (prior.id !== input.manifest.id) {
      throw new Error('A different import-set manifest already exists at that location.');
    }
    if (input.mergePartitions) {
      const partitions = new Map(
        prior.partitions.map((partition) => [
          stableJson({
            sheet: partition.sourcePartition,
            kind: partition.forcedKind,
            mappings: partition.mappings,
          }),
          partition,
        ])
      );
      for (const partition of input.manifest.partitions) {
        const key = stableJson({
          sheet: partition.sourcePartition,
          kind: partition.forcedKind,
          mappings: partition.mappings,
        });
        const members = new Map(
          (partitions.get(key)?.members ?? []).map((member) => [member.sourceRecordId, member])
        );
        for (const member of partition.members) members.set(member.sourceRecordId, member);
        partitions.set(key, { ...partition, members: [...members.values()] });
      }
      content = serializeImportSetManifest({
        ...input.manifest,
        createdAt: prior.createdAt,
        partitions: [...partitions.values()],
      });
    }
    await dependencies.fs.writeWorkspaceTextFileAtomic({
      workspaceRoot: input.workspaceRoot,
      path: absoluteManifestPath,
      content,
      mode: 'replace',
      mutationToken: input.mutationToken,
      expectedContentHash: await sha256Hex(priorContent),
      artifactNoun: 'import-set manifest',
    });
  } else {
    await dependencies.fs.writeWorkspaceTextFileAtomic({
      workspaceRoot: input.workspaceRoot,
      path: absoluteManifestPath,
      content,
      mode: 'create',
      mutationToken: input.mutationToken,
      artifactNoun: 'import-set manifest',
    });
  }
  relativePaths.push(input.manifest.manifestRelativePath);
  return { relativePaths };
}

export async function persistImportSet(
  input: {
    partitions: ImportSetPartitionInput[];
    workspaceRoot: string;
    destinationDir: string;
    source?: ImportSetSourceInput;
    commitMessage?: string;
    mutationToken?: string;
    mergePartitions?: boolean;
  },
  dependencies: ImportSetPersistenceDependencies
): Promise<{
  importSet: { id: string; manifestRelativePath: string };
  relativePaths: string[];
}> {
  const sourcePlan = input.partitions[0]?.plan;
  if (!sourcePlan) throw new Error('An import set requires at least one imported partition.');
  const source = await prepareImportSetSource(
    { plan: sourcePlan, ...(input.source ?? {}) },
    dependencies
  );
  const manifest = await buildImportSetManifest({
    workspaceRoot: input.workspaceRoot,
    destinationDir: input.destinationDir,
    source,
    partitions: input.partitions,
  });
  const written = await writeImportSet(
    {
      workspaceRoot: input.workspaceRoot,
      manifest,
      source,
      mutationToken: input.mutationToken,
      mergePartitions: input.mergePartitions,
    },
    dependencies
  );
  if (
    input.commitMessage &&
    (await dependencies.isGitRepo(input.workspaceRoot, input.mutationToken))
  ) {
    await dependencies.commitPaths(
      input.workspaceRoot,
      input.commitMessage,
      written.relativePaths,
      input.mutationToken
    );
  }
  return {
    importSet: { id: manifest.id, manifestRelativePath: manifest.manifestRelativePath },
    relativePaths: written.relativePaths,
  };
}

export type PersistImportSetOperation = (
  input: Parameters<typeof persistImportSet>[0]
) => ReturnType<typeof persistImportSet>;
