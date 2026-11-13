import {
  forgePackagePaths,
  isForgePackageMemberRelativePath,
  isForgePackageMetaPath,
  type ForgePackageMemberSpec,
} from './forge-package';
import {
  isCustomGeneticCodeSpec,
  isKnownGeneticCodeId,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import {
  SEQUENCE_ASSETS_DIR,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  SEQUENCE_PACKAGE_KIND,
  SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR,
  SEQUENCE_PACKAGE_META_ALIASES,
  SEQUENCE_PACKAGE_META_NAME,
  SEQUENCE_PACKAGE_MIGRATORS,
  SEQUENCE_PACKAGE_PAYLOAD_DIR,
  SEQUENCE_PACKAGE_REVISION_JOURNAL_NAME,
  SEQUENCE_PACKAGE_SCHEMA,
  SEQUENCE_PRIMERS_DIR,
  isSequencePackageKind,
  isSequencePackageSchema,
} from './sequence-package-contract';
import { SEQUENCE_PACKAGE_MIGRATOR_FNS, rewritePrimerRelPath } from './sequence-package-migration';
import {
  createDefaultSequenceEntityMetadata,
  type EntitySchemaFieldSnapshot,
  type EntitySchemaRevisionSnapshot,
  type SchemaBoundEntityRelationship,
  type SchemaBoundSequenceEntityMetadata,
} from '../shared/sequence-entity-schema';

export {
  BUILTIN_SEQUENCE_SCHEMA_ID,
  BUILTIN_SEQUENCE_SCHEMA_REVISION_ID,
  BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
  DEFAULT_SEQUENCE_ENTITY_METADATA,
  createDefaultSequenceEntityMetadata,
  createDefaultPlasmidEntityMetadata,
} from '../shared/sequence-entity-schema';
export type {
  EntitySchemaFieldSnapshot,
  EntitySchemaRevisionSnapshot,
  SchemaBoundEntityRelationship,
  SchemaBoundSequenceEntityMetadata,
} from '../shared/sequence-entity-schema';

export {
  SEQUENCE_ASSETS_DIR,
  SEQUENCE_MEMBER_ROLES,
  SEQUENCE_PACKAGE_FILE_KIND,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  SEQUENCE_PACKAGE_KIND,
  SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR,
  SEQUENCE_PACKAGE_META_ALIASES,
  SEQUENCE_PACKAGE_META_NAME,
  SEQUENCE_PACKAGE_MIGRATORS,
  SEQUENCE_PACKAGE_PAYLOAD_DIR,
  SEQUENCE_PACKAGE_SCHEMA,
  SEQUENCE_PACKAGE_V1_MEMBER_DIRS,
  SEQUENCE_PRIMERS_DIR,
  assertKnownSequenceMemberRole,
  isKnownSequenceMemberRole,
  isSequencePackageFileKind,
  isSequencePackageKind,
  isSequencePackageSchema,
} from './sequence-package-contract';
export type { SequenceMemberRole } from './sequence-package-contract';

export const SEQUENCE_ALIGNMENT_HISTORY_SUFFIX = '.waypoint.json' as const;

export function sequenceAlignmentHistoryRelPath(productFile: string): string {
  return sequenceManagedMemberPath(`${productFile}${SEQUENCE_ALIGNMENT_HISTORY_SUFFIX}`);
}

export function sequencePackageMembersWithRole(
  members: readonly SequencePackageMember[],
  role: string
): SequencePackageMember[] {
  return members.filter((member) => member.role === role);
}

export const SEQUENCE_PRODUCT_EXTENSIONS = ['.gb', '.gbk', '.gbff', '.genbank'] as const;
export type SequenceProductExtension = (typeof SEQUENCE_PRODUCT_EXTENSIONS)[number];

export function sequenceProductExtensionForPath(input: string): SequenceProductExtension | null {
  const lower = input.toLowerCase();
  return SEQUENCE_PRODUCT_EXTENSIONS.find((extension) => lower.endsWith(extension)) ?? null;
}

export function stripSequenceProductExtension(input: string): string {
  const extension = sequenceProductExtensionForPath(input);
  return extension ? input.slice(0, -extension.length) : input;
}

const SEQUENCE_MEMBER_SPEC: ForgePackageMemberSpec = {
  metaName: SEQUENCE_PACKAGE_META_NAME,
  memberDirs: [
    SEQUENCE_PACKAGE_PAYLOAD_DIR,
    SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR,
    SEQUENCE_PRIMERS_DIR,
    SEQUENCE_ASSETS_DIR,
  ],
  stemExtensions: SEQUENCE_PRODUCT_EXTENSIONS,
};

export interface SequencePackagePaths {
  root: string;
  stem: string;
  metaDir: string;
  metaPath: string;
  revisionJournalPath: string;

  contentsDir: string;
  primersDir: string;
  assetsDir: string;
  productPath: string;
}

export class SequencePackageFormatError extends Error {
  readonly code = 'SEQUENCE_PACKAGE_NEWER_FORMAT' as const;
  constructor(found: number, current: number) {
    super(
      `Sequence package formatVersion ${found} is newer than this app (${current}). Upgrade DNAForge.`
    );
    this.name = 'SequencePackageFormatError';
  }
}

export interface SequencePackageMember {
  id: string;
  role: string;
  path: string;
  replaceable: boolean;
  createdAt: string;
  mediaType?: string;
}

export interface SequencePackageUserAttachment {
  memberId: string;
  sha256: string | null;
}

export type SequencePackageUserAttachmentMap = Record<string, SequencePackageUserAttachment>;

export function containsSequencePackageControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}

export interface SequencePackageProduct {
  file: string;

  topology?: 'circular' | 'linear';
  sequenceChecksum?: string;
  genBankChecksum?: string;
}

export interface SequencePackageAssembly {
  primers?: {
    csv?: string;
    fasta?: string;
    csvChecksum?: string;
    fastaChecksum?: string;
  };

  accepted?: Record<string, unknown>;

  history?: Record<string, unknown>[];
}

export const SEQUENCE_PACKAGE_HISTORY_SCHEMA = 'waypoint.sequence-history.v1' as const;

export type SequencePackageRevisionKind =
  | 'adopted'
  | 'sequence-save'
  | 'metadata-update'
  | 'assembly-finalization'
  | 'evidence-update'
  | 'sequencing-apply'
  | 'member-update'
  | 'restore';

export interface SequencePackageRevision {
  id: string;
  parentId: string | null;
  operationId: string;

  requestFingerprint?: string;
  kind: SequencePackageRevisionKind;
  createdAt: string;
  productSnapshot: { path: string; sha256: string };
  state: {
    name: string;
    product: SequencePackageProduct;

    geneticCode?: GeneticCodeSpec | null;

    annotationItems?: Array<{ id: string; label: string }>;
    entity: SchemaBoundSequenceEntityMetadata;

    acceptedAssembly: Record<string, unknown> | null;

    userAttachments?: SequencePackageUserAttachmentMap;
  };

  sources?: Record<string, { revisionId: string; valueSha256: string }>;

  evidenceRunId?: string;
}

export interface SequencePackageVersionHistory {
  schema: typeof SEQUENCE_PACKAGE_HISTORY_SCHEMA;

  headId: string | null;
  revisions: SequencePackageRevision[];
}

export interface SequencePackageEvidenceArtifact {
  path: string;
  sha256: string;
}

export interface SequencePackageEvidenceRun {
  id: string;
  sessionId: string;

  session?: { name: string; mode: 'one-per-clone' | 'multi-per-clone'; createdAt: string };
  createdAt: string;
  status: 'prepared' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  reference: {
    artifact: SequencePackageEvidenceArtifact;
    sequenceRevision: string;
    topology: 'linear' | 'circular';
    checkpointId: string | null;
  };
  queries: Array<{ id: string; label: string; artifact: SequencePackageEvidenceArtifact }>;
  producer?: {
    kind: 'pairwise-session-alignment';
    algorithm: 'auto';
    threads: number;
    timeoutSeconds: number;
    isCircular: boolean;
  };
  managedOperationId?: string;
  inputRevision?: string;
  result?: SequencePackageEvidenceArtifact;

  states?: Array<{ id: string; createdAt: string; artifact: SequencePackageEvidenceArtifact }>;
  completedAt?: string;
}

export interface SequencePackageDocument {
  schema: typeof SEQUENCE_PACKAGE_SCHEMA;
  kind: typeof SEQUENCE_PACKAGE_KIND;
  formatVersion: typeof SEQUENCE_PACKAGE_FORMAT_VERSION;

  id: string;
  name: string;

  entity: SchemaBoundSequenceEntityMetadata;
  updatedAt: string;
  product: SequencePackageProduct;
  members: SequencePackageMember[];

  userAttachments: SequencePackageUserAttachmentMap;
  versionHistory: SequencePackageVersionHistory;

  evidenceRuns?: SequencePackageEvidenceRun[];

  assembly?: SequencePackageAssembly;
  [key: string]: unknown;
}

export function sequencePackageMetaPaths(packageRoot: string): string[] {
  return SEQUENCE_PACKAGE_META_ALIASES.map((name) => forgePackagePaths(packageRoot, name).metaPath);
}

export function sequencePackagePaths(
  packageRoot: string,
  options: { productFile?: string; metaName?: string } = {}
): SequencePackagePaths {
  const base = forgePackagePaths(packageRoot, options.metaName ?? SEQUENCE_PACKAGE_META_NAME);
  const productFile = options.productFile ?? `${base.stem}${SEQUENCE_PRODUCT_EXTENSIONS[0]}`;
  assertProductFileName(productFile);
  return {
    root: base.root,
    stem: base.stem,
    metaDir: base.metaDir,
    metaPath: base.metaPath,
    revisionJournalPath: `${base.metaDir}${base.sep}${SEQUENCE_PACKAGE_REVISION_JOURNAL_NAME}`,
    contentsDir: `${base.root}${base.sep}${SEQUENCE_PACKAGE_PAYLOAD_DIR}`,
    primersDir: `${base.root}${base.sep}${SEQUENCE_PRIMERS_DIR}`,
    assetsDir: `${base.root}${base.sep}${SEQUENCE_ASSETS_DIR}`,
    productPath: `${base.root}${base.sep}${productFile}`,
  };
}

export function sequenceManagedMemberPath(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  if (!base || base === '.' || base === '..') {
    throw new Error(`Managed member file name is not a single file name: ${fileName}`);
  }
  return `${SEQUENCE_PACKAGE_PAYLOAD_DIR}/${base}`;
}

export function resolveSequenceProductFile(
  recordedFile: string | undefined,
  entries: readonly (string | { name: string; isFile: boolean })[]
): string {
  const fileNames = entries
    .map((entry) => (typeof entry === 'string' ? { name: entry, isFile: true } : entry))
    .filter((entry) => entry.isFile)
    .map((entry) => entry.name);

  if (recordedFile && fileNames.includes(recordedFile)) {
    assertProductFileName(recordedFile);
    return recordedFile;
  }

  const candidates = fileNames.filter((name) => sequenceProductExtensionForPath(name) !== null);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(
      `Sequence package has no product GenBank file${recordedFile ? ` (recorded: ${recordedFile})` : ''}.`
    );
  }
  throw new Error(
    `Sequence package product is ambiguous: ${candidates.length} GenBank files and the recorded name ` +
      `${recordedFile ? `"${recordedFile}" is missing` : 'is absent'}. Refusing to guess.`
  );
}

export function buildSequencePackageDocument(input: {
  id: string;
  name: string;
  product: SequencePackageProduct;
  assembly?: SequencePackageAssembly;
  entity?: SchemaBoundSequenceEntityMetadata;
  members?: SequencePackageMember[];
  userAttachments?: SequencePackageUserAttachmentMap;
  versionHistory?: SequencePackageVersionHistory;
  evidenceRuns?: SequencePackageEvidenceRun[];
  updatedAt?: string;
  existing?: Record<string, unknown>;
}): SequencePackageDocument {
  assertProductFileName(input.product.file);
  const assembly = normalizeAssemblyPrimerPaths(input.assembly);
  assertAssemblyPrimerPaths(assembly);
  const existingMembers = input.existing?.members;
  assertMembers(input.members ?? existingMembers);
  const members = upsertPrimerExportMembersOnBuild(
    input.members ?? (Array.isArray(existingMembers) ? existingMembers : []),
    assembly
  );
  assertMembers(members);
  const doc: SequencePackageDocument = {
    ...(input.existing ?? {}),
    schema: SEQUENCE_PACKAGE_SCHEMA,
    kind: SEQUENCE_PACKAGE_KIND,
    formatVersion: SEQUENCE_PACKAGE_FORMAT_VERSION,
    id: requiredText(input.id, 'Sequence package id'),
    name: input.name,
    entity: normalizeSchemaBoundSequenceEntity(
      input.entity ?? input.existing?.entity ?? createDefaultSequenceEntityMetadata()
    ),
    product: { ...input.product },
    members: members.map((member) => normalizeMember(member)),
    userAttachments: normalizeSequencePackageUserAttachments(
      input.userAttachments ?? input.existing?.userAttachments ?? {}
    ),
    versionHistory: normalizeVersionHistory(
      input.versionHistory ?? input.existing?.versionHistory ?? emptyVersionHistory()
    ),
    evidenceRuns: normalizeEvidenceRuns(input.evidenceRuns ?? input.existing?.evidenceRuns),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };

  if (assembly) {
    const { primers: _legacyPrimerCatalog, ...rest } = assembly;
    doc.assembly = rest;
  }
  return doc;
}

function normalizeAssemblyPrimerPaths(
  assembly: SequencePackageAssembly | undefined
): SequencePackageAssembly | undefined {
  if (!assembly) return undefined;
  const csv = assembly.primers?.csv;
  const fasta = assembly.primers?.fasta;
  const primers =
    csv === undefined && fasta === undefined
      ? assembly.primers
      : {
          ...assembly.primers,
          ...(typeof csv === 'string' ? { csv: rewritePrimerRelPath(csv) } : {}),
          ...(typeof fasta === 'string' ? { fasta: rewritePrimerRelPath(fasta) } : {}),
        };
  return {
    ...assembly,
    ...(primers ? { primers } : {}),
    ...(assembly.accepted ? { accepted: rewriteAcceptedPrimerArtifacts(assembly.accepted) } : {}),
  };
}

function rewriteAcceptedPrimerArtifacts(
  accepted: Record<string, unknown>
): Record<string, unknown> {
  const artifacts = accepted.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return accepted;
  const next: Record<string, unknown> = { ...artifacts };
  let changed = false;
  for (const key of ['primerCsvPath', 'primerFastaPath'] as const) {
    const value = next[key];
    if (typeof value !== 'string') continue;
    const rewritten = rewritePrimerRelPath(value);
    if (rewritten !== value) {
      next[key] = rewritten;
      changed = true;
    }
  }
  return changed ? { ...accepted, artifacts: next } : accepted;
}

function upsertPrimerExportMembersOnBuild(
  members: unknown,
  assembly: SequencePackageAssembly | undefined
): SequencePackageMember[] {
  const current = Array.isArray(members) ? members.map((member) => normalizeMember(member)) : [];
  const kept = current.filter((member) => member.role !== 'primer-export');
  const primerPaths = [assembly?.primers?.csv, assembly?.primers?.fasta].filter(
    (path): path is string => typeof path === 'string' && path.length > 0
  );
  if (primerPaths.length === 0) {
    return [...kept, ...current.filter((member) => member.role === 'primer-export')];
  }
  const exports = primerPaths.map((path) => {
    const existing = current.find(
      (member) => member.path === path && member.role === 'primer-export'
    );
    const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
    return (
      existing ?? {
        id: `primer-export:${name}`,
        role: 'primer-export',
        path,
        replaceable: true,
        createdAt: new Date().toISOString(),
      }
    );
  });
  return [...kept, ...exports];
}

export function parseSequencePackageDocument(content: string): SequencePackageDocument {
  return migrateSequencePackageDocument(parseSequencePackageRecord(content));
}

export function migrateSequencePackageDocument(
  raw: Record<string, unknown>
): SequencePackageDocument {
  const found = readFormatVersion(raw);
  if (found > SEQUENCE_PACKAGE_FORMAT_VERSION) {
    throw new SequencePackageFormatError(found, SEQUENCE_PACKAGE_FORMAT_VERSION);
  }
  let doc = raw;
  let version = found;
  for (const step of SEQUENCE_PACKAGE_MIGRATORS) {
    if (step.from !== version) continue;
    const impl = SEQUENCE_PACKAGE_MIGRATOR_FNS[step.name];
    if (!impl) {
      throw new Error(`Missing migrator implementation ${step.name}`);
    }
    doc = impl(doc);
    version = step.to;
  }
  if (version !== SEQUENCE_PACKAGE_FORMAT_VERSION) {
    throw new Error(
      `Sequence package migrators stopped at ${version}; current is ${SEQUENCE_PACKAGE_FORMAT_VERSION}`
    );
  }
  return finalizeCurrentDocument(doc);
}

export function serializeSequencePackageDocument(doc: SequencePackageDocument): string {
  if (doc.formatVersion !== SEQUENCE_PACKAGE_FORMAT_VERSION) {
    throw new Error(
      'serializeSequencePackageDocument requires a current-format document. Parse or build first — they migrate.'
    );
  }
  requiredText(doc.id, 'Sequence package id');
  assertMembers(doc.members);
  normalizeSchemaBoundSequenceEntity(doc.entity);
  const history = normalizeVersionHistory(doc.versionHistory);
  assertHistoryMemberOwnership(doc.members, history);
  assertEvidenceMemberOwnership(doc.members, normalizeEvidenceRuns(doc.evidenceRuns));
  assertSequencePackageUserAttachmentOwnership(
    doc.members,
    normalizeSequencePackageUserAttachments(doc.userAttachments),
    history
  );
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function parseSequencePackageRecord(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid sequence package JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sequence package must be a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  if (!isSequencePackageSchema(doc.schema) || !isSequencePackageKind(doc.kind)) {
    throw new Error(`Not a ${SEQUENCE_PACKAGE_SCHEMA} package document`);
  }
  if (typeof doc.id !== 'string' || !doc.id.trim()) {
    throw new Error('Sequence package is missing id');
  }
  const product = doc.product;
  if (!product || typeof product !== 'object' || Array.isArray(product)) {
    throw new Error('Sequence package is missing product');
  }
  const productRecord = product as Record<string, unknown>;
  if (typeof productRecord.file !== 'string' || !productRecord.file.trim()) {
    throw new Error('Sequence package product is missing file');
  }
  assertProductFileName(productRecord.file);
  assertAssemblyPrimerPaths(doc.assembly);
  assertMembers(doc.members);
  if (doc.versionHistory !== undefined) normalizeVersionHistory(doc.versionHistory);
  if (doc.evidenceRuns !== undefined) normalizeEvidenceRuns(doc.evidenceRuns);
  return doc;
}

function readFormatVersion(doc: Record<string, unknown>): number {
  if (doc.formatVersion === undefined) return 1;
  if (
    typeof doc.formatVersion !== 'number' ||
    !Number.isInteger(doc.formatVersion) ||
    doc.formatVersion < 1
  ) {
    throw new Error('Sequence package formatVersion must be a positive integer');
  }
  return doc.formatVersion;
}

function finalizeCurrentDocument(doc: Record<string, unknown>): SequencePackageDocument {
  assertMembers(doc.members);
  const productRecord = doc.product as Record<string, unknown>;
  const members = Array.isArray(doc.members)
    ? doc.members.map((member) => normalizeMember(member))
    : [];
  const versionHistory = normalizeVersionHistory(doc.versionHistory);
  const evidenceRuns = normalizeEvidenceRuns(doc.evidenceRuns);
  const userAttachments = normalizeSequencePackageUserAttachments(doc.userAttachments);
  assertHistoryMemberOwnership(members, versionHistory);
  assertEvidenceMemberOwnership(members, evidenceRuns);
  assertSequencePackageUserAttachmentOwnership(members, userAttachments, versionHistory);
  return {
    ...doc,
    schema: SEQUENCE_PACKAGE_SCHEMA,
    kind: SEQUENCE_PACKAGE_KIND,
    formatVersion: SEQUENCE_PACKAGE_FORMAT_VERSION,
    id: String(doc.id).trim(),
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : String(doc.id).trim(),
    entity: normalizeSchemaBoundSequenceEntity(doc.entity),
    product: productRecord as unknown as SequencePackageProduct,
    members,
    userAttachments,
    versionHistory,
    evidenceRuns,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
  };
}

export function emptyVersionHistory(): SequencePackageVersionHistory {
  return { schema: SEQUENCE_PACKAGE_HISTORY_SCHEMA, headId: null, revisions: [] };
}

export function normalizeVersionHistory(value: unknown): SequencePackageVersionHistory {
  const record = requirePlainObject(value, 'Sequence package version history');
  if (record.schema !== SEQUENCE_PACKAGE_HISTORY_SCHEMA || !Array.isArray(record.revisions)) {
    throw new Error('Sequence package version history is invalid');
  }
  const revisions: SequencePackageRevision[] = [];
  let hasAttachmentSnapshots = false;
  const seen = new Set<string>();
  const seenOperations = new Set<string>();
  for (const entry of record.revisions) {
    const revision = requirePlainObject(entry, 'Sequence package revision');
    const id = requiredText(revision.id, 'Sequence package revision id');
    const parentId = revision.parentId;
    const operationId = requiredText(revision.operationId, 'Sequence package revision operationId');
    if (
      revision.requestFingerprint !== undefined &&
      (typeof revision.requestFingerprint !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(revision.requestFingerprint))
    ) {
      throw new Error('Sequence package revision request fingerprint is invalid');
    }
    if (seen.has(id)) throw new Error(`Duplicate sequence package revision: ${id}`);
    if (seenOperations.has(operationId)) {
      throw new Error(`Duplicate sequence package revision operation: ${operationId}`);
    }
    const expectedParent = revisions.length > 0 ? revisions[revisions.length - 1].id : null;
    if (parentId !== expectedParent) {
      throw new Error(`Sequence package revision ${id} is not attached to the previous head`);
    }
    if (
      revision.kind !== 'adopted' &&
      revision.kind !== 'sequence-save' &&
      revision.kind !== 'metadata-update' &&
      revision.kind !== 'assembly-finalization' &&
      revision.kind !== 'evidence-update' &&
      revision.kind !== 'sequencing-apply' &&
      revision.kind !== 'member-update' &&
      revision.kind !== 'restore'
    ) {
      throw new Error(`Sequence package revision ${id} has an invalid kind`);
    }
    const snapshot = requirePlainObject(
      revision.productSnapshot,
      'Sequence package revision productSnapshot'
    );
    const snapshotPath = requiredText(snapshot.path, 'Sequence package snapshot path');
    assertPackageRelative(snapshotPath, 'versionHistory.revisions[].productSnapshot.path');
    if (!snapshotPath.startsWith(`${SEQUENCE_PACKAGE_PAYLOAD_DIR}/`)) {
      throw new Error('Sequence package snapshot must be inside contents/');
    }
    const snapshotSha256 = requiredText(snapshot.sha256, 'Sequence package snapshot sha256');
    if (!/^sha256:[a-f0-9]{64}$/.test(snapshotSha256)) {
      throw new Error('Sequence package snapshot sha256 is invalid');
    }
    const state = requirePlainObject(revision.state, 'Sequence package revision state');
    if (
      state.userAttachments === undefined &&
      (hasAttachmentSnapshots || revision.kind === 'member-update')
    ) {
      throw new Error('Sequence package revision is missing its user attachment snapshot');
    }
    if (state.userAttachments !== undefined) hasAttachmentSnapshots = true;
    const product = requirePlainObject(state.product, 'Sequence package revision product');
    const productFile = requiredText(product.file, 'Sequence package revision product file');
    assertProductFileName(productFile);
    if (state.acceptedAssembly !== null && !isPlainObject(state.acceptedAssembly)) {
      throw new Error('Sequence package revision acceptedAssembly must be an object or null');
    }
    if (
      state.geneticCode !== undefined &&
      state.geneticCode !== null &&
      !isKnownGeneticCodeId(state.geneticCode) &&
      !isCustomGeneticCodeSpec(state.geneticCode as GeneticCodeSpec)
    ) {
      throw new Error('Sequence package revision genetic code is invalid');
    }
    if (state.annotationItems !== undefined) {
      if (!Array.isArray(state.annotationItems)) {
        throw new Error('Sequence package revision annotation items must be an array');
      }
      const annotationIds = new Set<string>();
      for (const item of state.annotationItems) {
        const annotation = requirePlainObject(item, 'Sequence package revision annotation item');
        const annotationId = requiredText(annotation.id, 'Sequence package revision annotation ID');
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            annotationId
          ) ||
          annotationIds.has(annotationId) ||
          typeof annotation.label !== 'string'
        ) {
          throw new Error('Sequence package revision annotation identity is invalid');
        }
        annotationIds.add(annotationId);
      }
    }
    if (revision.sources !== undefined && !isPlainObject(revision.sources)) {
      throw new Error('Sequence package revision sources must be an object');
    }
    if (revision.evidenceRunId !== undefined && typeof revision.evidenceRunId !== 'string') {
      throw new Error('Sequence package revision evidenceRunId is invalid');
    }
    if ((revision.kind === 'sequencing-apply') !== (revision.evidenceRunId !== undefined)) {
      throw new Error('Sequencing mutation application must cite exactly one evidence run');
    }
    const sources: SequencePackageRevision['sources'] = {};
    if (revision.sources !== undefined) {
      for (const [itemId, entry] of Object.entries(revision.sources)) {
        const source = requirePlainObject(entry, `Sequence package revision source ${itemId}`);
        const sourceRevisionId = requiredText(
          source.revisionId,
          `Sequence package revision source ${itemId} revisionId`
        );
        const valueSha256 = requiredText(
          source.valueSha256,
          `Sequence package revision source ${itemId} valueSha256`
        );
        if (!seen.has(sourceRevisionId) || !/^sha256:[a-f0-9]{64}$/.test(valueSha256)) {
          throw new Error(`Sequence package revision source ${itemId} is invalid`);
        }
        sources[itemId] = { revisionId: sourceRevisionId, valueSha256 };
      }
    }
    revisions.push({
      id,
      parentId: parentId as string | null,
      operationId,
      ...(revision.requestFingerprint !== undefined
        ? { requestFingerprint: revision.requestFingerprint as string }
        : {}),
      kind: revision.kind,
      createdAt: requiredText(revision.createdAt, 'Sequence package revision createdAt'),
      productSnapshot: { path: snapshotPath, sha256: snapshotSha256 },
      state: {
        name: requiredText(state.name, 'Sequence package revision name'),
        product: { ...product, file: productFile } as SequencePackageProduct,
        ...(state.geneticCode !== undefined
          ? { geneticCode: state.geneticCode as GeneticCodeSpec | null }
          : {}),
        ...(state.annotationItems !== undefined
          ? {
              annotationItems: (state.annotationItems as Array<{ id: string; label: string }>).map(
                (item) => ({ id: item.id, label: item.label })
              ),
            }
          : {}),
        entity: normalizeSchemaBoundSequenceEntity(state.entity),
        acceptedAssembly: state.acceptedAssembly as Record<string, unknown> | null,
        ...(state.userAttachments !== undefined
          ? { userAttachments: normalizeSequencePackageUserAttachments(state.userAttachments) }
          : {}),
      },
      ...(revision.sources !== undefined ? { sources } : {}),
      ...(revision.evidenceRunId !== undefined
        ? { evidenceRunId: revision.evidenceRunId as string }
        : {}),
    });
    seen.add(id);
    seenOperations.add(operationId);
  }
  const headId = record.headId;
  if (headId !== null && (typeof headId !== 'string' || !seen.has(headId))) {
    throw new Error('Sequence package version history head is unknown');
  }
  if (revisions.length > 0 && headId !== revisions[revisions.length - 1].id) {
    throw new Error('Sequence package version history head must be the last revision');
  }
  return { schema: SEQUENCE_PACKAGE_HISTORY_SCHEMA, headId: headId as string | null, revisions };
}

export function normalizeEvidenceRuns(value: unknown): SequencePackageEvidenceRun[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Sequence package evidenceRuns must be an array');
  const seen = new Set<string>();
  return value.map((entry) => {
    const run = requirePlainObject(entry, 'Sequence package evidence run');
    const id = requiredText(run.id, 'Sequence package evidence run id');
    if (seen.has(id)) throw new Error(`Duplicate sequence package evidence run: ${id}`);
    seen.add(id);
    const reference = requirePlainObject(run.reference, 'Sequence package evidence reference');
    const topology = reference.topology;
    if (topology !== 'linear' && topology !== 'circular') {
      throw new Error('Sequence package evidence topology is invalid');
    }
    if (reference.checkpointId !== null && typeof reference.checkpointId !== 'string') {
      throw new Error('Sequence package evidence checkpoint is invalid');
    }
    if (!Array.isArray(run.queries) || run.queries.length === 0) {
      throw new Error('Sequence package evidence queries are missing');
    }
    const queryIds = new Set<string>();
    const queries = run.queries.map((entry) => {
      const query = requirePlainObject(entry, 'Sequence package evidence query');
      const queryId = requiredText(query.id, 'Sequence package evidence query id');
      if (queryIds.has(queryId)) throw new Error('Duplicate sequence package evidence query');
      queryIds.add(queryId);
      return {
        id: queryId,
        label: requiredText(query.label, 'Sequence package evidence query label'),
        artifact: normalizeEvidenceArtifact(query.artifact),
      };
    });
    const status = run.status;
    if (
      status !== 'prepared' &&
      status !== 'completed' &&
      status !== 'failed' &&
      status !== 'canceled' &&
      status !== 'interrupted'
    ) {
      throw new Error('Sequence package evidence status is invalid');
    }
    const result = run.result === undefined ? undefined : normalizeEvidenceArtifact(run.result);
    const session =
      run.session === undefined
        ? undefined
        : (() => {
            const value = requirePlainObject(run.session, 'Sequence evidence session');
            if (value.mode !== 'one-per-clone' && value.mode !== 'multi-per-clone') {
              throw new Error('Sequence evidence session mode is invalid');
            }
            return {
              name: requiredText(value.name, 'Sequence evidence session name'),
              mode: value.mode as 'one-per-clone' | 'multi-per-clone',
              createdAt: requiredText(value.createdAt, 'Sequence evidence session createdAt'),
            };
          })();
    const producer =
      run.producer === undefined
        ? undefined
        : (() => {
            const value = requirePlainObject(run.producer, 'Sequence evidence producer');
            if (
              value.kind !== 'pairwise-session-alignment' ||
              value.algorithm !== 'auto' ||
              typeof value.threads !== 'number' ||
              !Number.isInteger(value.threads) ||
              value.threads < 1 ||
              typeof value.timeoutSeconds !== 'number' ||
              !Number.isFinite(value.timeoutSeconds) ||
              value.timeoutSeconds <= 0 ||
              typeof value.isCircular !== 'boolean'
            ) {
              throw new Error('Sequence evidence producer parameters are invalid');
            }
            return {
              kind: 'pairwise-session-alignment' as const,
              algorithm: 'auto' as const,
              threads: value.threads,
              timeoutSeconds: value.timeoutSeconds,
              isCircular: value.isCircular,
            };
          })();
    if ((status === 'completed') !== Boolean(result)) {
      throw new Error('Completed sequence evidence requires exactly one result artifact');
    }
    const stateIds = new Set<string>();
    const states =
      run.states === undefined
        ? []
        : (() => {
            if (!Array.isArray(run.states))
              throw new Error('Sequence evidence states must be an array');
            return run.states.map((entry) => {
              const state = requirePlainObject(entry, 'Sequence evidence state');
              const stateId = requiredText(state.id, 'Sequence evidence state id');
              if (stateIds.has(stateId)) throw new Error('Duplicate sequence evidence state');
              stateIds.add(stateId);
              return {
                id: stateId,
                createdAt: requiredText(state.createdAt, 'Sequence evidence state createdAt'),
                artifact: normalizeEvidenceArtifact(state.artifact),
              };
            });
          })();
    if (states.length > 0 && status !== 'completed') {
      throw new Error('Incomplete evidence cannot carry an interpreted state');
    }
    return {
      id,
      sessionId: requiredText(run.sessionId, 'Sequence package evidence sessionId'),
      ...(session ? { session } : {}),
      createdAt: requiredText(run.createdAt, 'Sequence package evidence createdAt'),
      status,
      reference: {
        artifact: normalizeEvidenceArtifact(reference.artifact),
        sequenceRevision: requiredText(
          reference.sequenceRevision,
          'Sequence package evidence sequenceRevision'
        ),
        topology,
        checkpointId: reference.checkpointId as string | null,
      },
      queries,
      ...(producer ? { producer } : {}),
      ...(run.managedOperationId !== undefined
        ? {
            managedOperationId: requiredText(
              run.managedOperationId,
              'Sequence package evidence managedOperationId'
            ),
          }
        : {}),
      ...(run.inputRevision !== undefined
        ? {
            inputRevision: requiredText(
              run.inputRevision,
              'Sequence package evidence inputRevision'
            ),
          }
        : {}),
      ...(result ? { result } : {}),
      ...(states.length > 0 ? { states } : {}),
      ...(run.completedAt !== undefined
        ? { completedAt: requiredText(run.completedAt, 'Sequence package evidence completedAt') }
        : {}),
    } satisfies SequencePackageEvidenceRun;
  });
}

function normalizeEvidenceArtifact(value: unknown): SequencePackageEvidenceArtifact {
  const artifact = requirePlainObject(value, 'Sequence package evidence artifact');
  const path = requiredText(artifact.path, 'Sequence package evidence artifact path');
  assertPackageRelative(path, 'evidenceRuns[].artifact.path');
  if (!path.startsWith(`${SEQUENCE_PACKAGE_PAYLOAD_DIR}/evidence/`)) {
    throw new Error('Sequence evidence artifacts must be inside contents/evidence/');
  }
  const sha256 = requiredText(artifact.sha256, 'Sequence package evidence artifact sha256');
  if (!/^sha256:[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Sequence package evidence artifact digest is invalid');
  }
  return { path, sha256 };
}

function assertEvidenceMemberOwnership(
  members: readonly SequencePackageMember[],
  runs: readonly SequencePackageEvidenceRun[]
): void {
  for (const run of runs) {
    const artifacts: Array<[SequencePackageEvidenceArtifact, string]> = [
      [run.reference.artifact, 'evidence-input'],
      ...run.queries.map((query): [SequencePackageEvidenceArtifact, string] => [
        query.artifact,
        'evidence-input',
      ]),
      ...(run.result
        ? [[run.result, 'evidence-result'] as [SequencePackageEvidenceArtifact, string]]
        : []),
      ...(run.states?.map((state): [SequencePackageEvidenceArtifact, string] => [
        state.artifact,
        'evidence-result',
      ]) ?? []),
    ];
    for (const [artifact, role] of artifacts) {
      const owners = members.filter((member) => member.path === artifact.path);
      if (owners.length !== 1 || owners[0].role !== role || owners[0].replaceable) {
        throw new Error(
          `Sequence evidence ${run.id} has no immutable package-owned ${role} artifact.`
        );
      }
    }
  }
}

function assertHistoryMemberOwnership(
  members: readonly SequencePackageMember[],
  history: SequencePackageVersionHistory
): void {
  for (const revision of history.revisions) {
    const matches = members.filter((member) => member.path === revision.productSnapshot.path);
    if (matches.length !== 1 || matches[0].role !== 'sequence-snapshot' || matches[0].replaceable) {
      throw new Error(
        `Sequence package revision ${revision.id} has no immutable package-owned snapshot.`
      );
    }
  }
}

export function normalizeSequencePackageUserAttachments(
  value: unknown
): SequencePackageUserAttachmentMap {
  const record = requirePlainObject(value, 'Sequence package user attachments');
  const entries: Array<[string, SequencePackageUserAttachment]> = [];
  for (const [attachmentId, value] of Object.entries(record)) {
    if (
      !attachmentId ||
      attachmentId.trim() !== attachmentId ||
      attachmentId.length > 256 ||
      containsSequencePackageControlCharacters(attachmentId)
    ) {
      throw new Error('Sequence package user attachment identity is invalid');
    }
    const attachment = requirePlainObject(
      value,
      `Sequence package user attachment ${attachmentId}`
    );
    const memberId = requiredText(attachment.memberId, 'Sequence package user attachment memberId');
    const sha256 = attachment.sha256;
    if (sha256 !== null && (typeof sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(sha256))) {
      throw new Error(`Sequence package user attachment ${attachmentId} digest is invalid`);
    }
    entries.push([attachmentId, { memberId, sha256 }]);
  }
  return Object.fromEntries(entries);
}

export function assertSequencePackageUserAttachmentOwnership(
  members: readonly SequencePackageMember[],
  current: SequencePackageUserAttachmentMap,
  history: SequencePackageVersionHistory
): void {
  const verifiedDigests = new Map<string, string>();
  const check = (attachments: SequencePackageUserAttachmentMap, label: string) => {
    for (const [attachmentId, attachment] of Object.entries(attachments)) {
      const owners = members.filter(
        (member) => member.id === attachment.memberId && member.role === 'user'
      );
      if (owners.length === 0 || (attachment.sha256 !== null && owners.length !== 1)) {
        throw new Error(`${label} attachment ${attachmentId} has no unambiguous user member.`);
      }
      if (attachment.sha256 !== null) {
        const owner = owners[0];
        if (
          owner.replaceable ||
          members.filter((member) => member.path === owner.path).length !== 1
        ) {
          throw new Error(`${label} attachment ${attachmentId} is not an immutable owned member.`);
        }
        const previous = verifiedDigests.get(owner.id);
        if (previous && previous !== attachment.sha256) {
          throw new Error(`User member ${owner.id} has conflicting historical digests.`);
        }
        verifiedDigests.set(owner.id, attachment.sha256);
      }
    }
  };
  check(current, 'Current');
  for (const revision of history.revisions) {
    if (revision.state.userAttachments !== undefined) {
      check(revision.state.userAttachments, `Revision ${revision.id}`);
    }
  }
  const head = history.revisions.find((revision) => revision.id === history.headId);
  if (head?.state.userAttachments !== undefined) {
    const canonical = (attachments: SequencePackageUserAttachmentMap) =>
      JSON.stringify(
        Object.entries(attachments).sort(([left], [right]) => left.localeCompare(right))
      );
    if (canonical(current) !== canonical(head.state.userAttachments)) {
      throw new Error('Current user attachments differ from the published package head.');
    }
  }
}

const REGISTRATION_STATUSES = new Set(['tracked', 'registered', 'drifted', 'unresolved']);

export function normalizeSchemaBoundSequenceEntity(
  value: unknown
): SchemaBoundSequenceEntityMetadata {
  const record = requirePlainObject(value, 'Sequence package entity');
  const schema = normalizeSchemaSnapshot(record.schema);
  const fields = requirePlainObject(record.fields, 'Sequence package entity fields');
  const registrationStatus = requiredText(
    record.registrationStatus,
    'Sequence package entity registrationStatus'
  );
  if (!REGISTRATION_STATUSES.has(registrationStatus)) {
    throw new Error(`Sequence package entity registrationStatus is invalid: ${registrationStatus}`);
  }
  if (record.domainStatus !== null && typeof record.domainStatus !== 'string') {
    throw new Error('Sequence package entity domainStatus must be a string or null');
  }
  if (record.registryId !== null && typeof record.registryId !== 'string') {
    throw new Error('Sequence package entity registryId must be a string or null');
  }
  if (!Array.isArray(record.relationships)) {
    throw new Error('Sequence package entity relationships must be an array');
  }
  let lifecycle: SchemaBoundSequenceEntityMetadata['lifecycle'];
  if (record.lifecycle !== undefined) {
    const state = requirePlainObject(record.lifecycle, 'Sequence package lifecycle');
    if (
      state.archived === true &&
      typeof state.archivedAt === 'number' &&
      Number.isSafeInteger(state.archivedAt) &&
      state.archivedAt >= 0
    ) {
      lifecycle = { ...state, archived: true, archivedAt: state.archivedAt };
    } else if (state.archived === false && state.archivedAt === null) {
      lifecycle = { ...state, archived: false, archivedAt: null };
    } else {
      throw new Error('Sequence package lifecycle requires its exact saved archive timestamp.');
    }
  }
  if (record.source !== undefined && !isPlainObject(record.source)) {
    throw new Error('Sequence package entity source must be an object when present');
  }
  return {
    ...record,
    schema,
    fields: { ...fields },
    registrationStatus:
      registrationStatus as SchemaBoundSequenceEntityMetadata['registrationStatus'],
    domainStatus: record.domainStatus as string | null,
    registryId: record.registryId as string | null,
    relationships: record.relationships.map(normalizeEntityRelationship),
    ...(lifecycle ? { lifecycle } : {}),
    ...(record.source !== undefined ? { source: { ...record.source } } : {}),
  };
}

function normalizeSchemaSnapshot(value: unknown): EntitySchemaRevisionSnapshot {
  const record = requirePlainObject(value, 'Sequence package entity schema');
  const schemaId = requiredText(record.schemaId, 'Sequence package entity schemaId');
  const schemaRevisionId = requiredText(
    record.schemaRevisionId,
    'Sequence package entity schemaRevisionId'
  );
  const name = requiredText(record.name, 'Sequence package entity schema name');
  const displayName = requiredText(
    record.displayName,
    'Sequence package entity schema displayName'
  );
  if (record.baseKind !== 'sequence') {
    throw new Error('Sequence package entity schema baseKind must be sequence');
  }
  if (!Number.isInteger(record.version) || Number(record.version) < 1) {
    throw new Error('Sequence package entity schema version must be a positive integer');
  }
  if (!Array.isArray(record.fields)) {
    throw new Error('Sequence package entity schema fields must be an array');
  }
  const fields = record.fields.map(normalizeSchemaField);
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) {
      throw new Error(`Duplicate sequence package entity schema field: ${field.key}`);
    }
    keys.add(field.key);
  }
  return {
    ...record,
    schemaId,
    schemaRevisionId,
    name,
    displayName,
    baseKind: 'sequence',
    version: Number(record.version),
    fields,
  };
}

function normalizeSchemaField(value: unknown): EntitySchemaFieldSnapshot {
  const record = requirePlainObject(value, 'Sequence package entity schema field');
  return {
    ...record,
    key: requiredText(record.key, 'Sequence package entity schema field key'),
    label: requiredText(record.label, 'Sequence package entity schema field label'),
    type: requiredText(record.type, 'Sequence package entity schema field type'),
  };
}

function normalizeEntityRelationship(value: unknown): SchemaBoundEntityRelationship {
  const record = requirePlainObject(value, 'Sequence package entity relationship');
  return {
    ...record,
    type: requiredText(record.type, 'Sequence package entity relationship type'),
    fromEntityId: requiredText(
      record.fromEntityId,
      'Sequence package entity relationship fromEntityId'
    ),
    toEntityId: requiredText(record.toEntityId, 'Sequence package entity relationship toEntityId'),
    payload: { ...requirePlainObject(record.payload, 'Sequence package relationship payload') },
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requirePlainObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertMembers(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error('Sequence package members must be an array');
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of value) {
    const member = normalizeMember(entry);
    if (ids.has(member.id)) {
      throw new Error(`Duplicate sequence package member id: ${member.id}`);
    }
    if (paths.has(member.path)) {
      throw new Error(`Duplicate sequence package member path: ${member.path}`);
    }
    ids.add(member.id);
    paths.add(member.path);
  }
}

function normalizeMember(value: unknown): SequencePackageMember {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sequence package member must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) {
    throw new Error('Sequence package member is missing id');
  }
  if (typeof record.role !== 'string' || !record.role.trim()) {
    throw new Error('Sequence package member is missing role');
  }
  if (typeof record.path !== 'string' || !record.path.trim()) {
    throw new Error('Sequence package member is missing path');
  }
  assertPackageRelative(record.path, 'members[].path');
  const rewritten = record.path
    .replace(/\\/g, '/')
    .replace(
      new RegExp(`^${SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR}/`),
      `${SEQUENCE_PACKAGE_PAYLOAD_DIR}/`
    );
  if (!rewritten.startsWith(`${SEQUENCE_PACKAGE_PAYLOAD_DIR}/`)) {
    throw new Error(
      `Sequence package member path must start with ${SEQUENCE_PACKAGE_PAYLOAD_DIR}/, got: ${record.path}`
    );
  }
  return {
    id: record.id.trim(),
    role: record.role.trim(),
    path: rewritten,
    replaceable: record.replaceable === true,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}),
  };
}

export function toPackageRelative(absolutePath: string, packageRoot: string): string {
  const normalizedPath = absolutePath.replace(/\\/g, '/');
  const normalizedRoot = packageRoot.replace(/\\/g, '/').replace(/\/+$/, '');

  const prefix = `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) {
    throw new Error(`Path is not inside the package root ${packageRoot}: ${absolutePath}`);
  }
  return normalizedPath.slice(prefix.length);
}

export function fromPackageRelative(relativePath: string, packageRoot: string): string {
  assertPackageRelative(relativePath, 'path');
  const normalizedRoot = packageRoot.replace(/\/+$/, '');
  const sep = normalizedRoot.includes('\\') && !normalizedRoot.includes('/') ? '\\' : '/';
  return `${normalizedRoot}${sep}${relativePath}`;
}

export function isSequencePackageMetaPath(path: string): boolean {
  return SEQUENCE_PACKAGE_META_ALIASES.some((name) => isForgePackageMetaPath(path, name));
}

export function sequencePackageRootForMetaPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const suffix of sequencePackageMetaRelativeSuffixes()) {
    const marker = `/${suffix}`;
    if (normalized.endsWith(marker)) return normalized.slice(0, -marker.length);
  }
  return null;
}

export function sequencePackageMetaRelativeSuffixes(): string[] {
  return SEQUENCE_PACKAGE_META_ALIASES.map((name) => `.forge/${name}`);
}

export function isSequencePackageMemberRelativePath(relativePath: string): boolean {
  if (isForgePackageMemberRelativePath(relativePath, SEQUENCE_MEMBER_SPEC)) return true;
  return SEQUENCE_PACKAGE_META_ALIASES.some((metaName) =>
    isForgePackageMemberRelativePath(relativePath, { ...SEQUENCE_MEMBER_SPEC, metaName })
  );
}

function assertPackageRelative(value: string, field: string): void {
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Sequence package ${field} must be package-relative, got: ${value}`);
  }
}

function assertProductFileName(value: string): void {
  assertPackageRelative(value, 'product.file');
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('/') || normalized === '.' || !normalized.trim()) {
    throw new Error(
      `Sequence package product.file must be a single file name at the package root, got: ${value}`
    );
  }
  if (!sequenceProductExtensionForPath(normalized)) {
    throw new Error(
      `Sequence package product.file must be a GenBank file (${SEQUENCE_PRODUCT_EXTENSIONS.join(', ')}), got: ${value}`
    );
  }
}

function assertAssemblyPrimerPaths(assembly: unknown): void {
  if (assembly === undefined) return;
  if (!assembly || typeof assembly !== 'object' || Array.isArray(assembly)) {
    throw new Error('Sequence package assembly must be a JSON object');
  }
  const primers = (assembly as Record<string, unknown>).primers;
  if (primers === undefined) return;
  if (!primers || typeof primers !== 'object' || Array.isArray(primers)) {
    throw new Error('Sequence package assembly.primers must be a JSON object');
  }
  const record = primers as Record<string, unknown>;
  assertPrimerArtifactPath(record.csv, 'csv');
  assertPrimerArtifactPath(record.fasta, 'fasta');
}

function assertPrimerArtifactPath(value: unknown, kind: 'csv' | 'fasta'): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Sequence package assembly.primers.${kind} must be a non-empty string`);
  }
  assertPackageRelative(value, `assembly.primers.${kind}`);
  const normalized = rewritePrimerRelPath(value);
  const pattern =
    kind === 'csv'
      ? /^(?:contents|files|primers)\/[^/]+\.primers\.csv$/i
      : /^(?:contents|files|primers)\/[^/]+\.primers\.fasta$/i;
  if (!pattern.test(normalized) && !pattern.test(value.replace(/\\/g, '/'))) {
    throw new Error(
      `Sequence package assembly.primers.${kind} must be an exact generated primer file, got: ${value}`
    );
  }
}

export function sequencePrimerArtifactLookupPaths(relativePath: string): string[] {
  const name = relativePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  if (!name) return [];
  const candidates = [
    `${SEQUENCE_PACKAGE_PAYLOAD_DIR}/${name}`,
    `${SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR}/${name}`,
    `${SEQUENCE_PRIMERS_DIR}/${name}`,
  ];
  return [...new Set(candidates)];
}
