import { createHash } from 'node:crypto';
import type {
  BenchlingSourceRef,
  MigrationScope,
  SourceObject,
  ValidationScopedBoundaryEvidence,
  ValidationScopedBoundaryEvidenceBody,
  ValidationScopedBoundaryPageEvidence,
  ValidationScopedBoundarySourceIdMode,
} from '../../shared/benchling-migration';
import {
  assertScopedFolderBoundary,
  classifySourceObjects,
  type ScopedFolderMetadata,
} from './collection-projection';

export const SCOPED_BOUNDARY_EVIDENCE_SCHEMA = 'dnaforge.scoped-boundary-evidence.v1' as const;
export const SCOPED_BOUNDARY_PAGE_DIGEST_SCHEMA =
  'dnaforge.scoped-boundary-page-digest.v1' as const;
export const SCOPED_BOUNDARY_ATTESTATION_SCHEMA =
  'dnaforge.migration.scoped-boundary-attestation.v1' as const;
export const SCOPED_BOUNDARY_EVIDENCE_PATH =
  '.dnaforge/migration/scoped-boundary-evidence.json' as const;

const STABLE_BENCHLING_SOURCE_ID = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]+$/u;
const STABLE_REPLAY_SOURCE_ID = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9](?:[A-Za-z0-9_]*[A-Za-z0-9])?$/u;
const FOLDER_SOURCE_PREFIXES = new Set(['fld', 'lib', 'src']);

export type ScopedBoundaryValidationOptions = {
  sourceIdMode?: ValidationScopedBoundarySourceIdMode;
};

export type ScopedBoundarySourceObjectMatchOptions = ScopedBoundaryValidationOptions & {
  skippedSourceObjectIds?: readonly string[];
};

export type ScopedBoundaryPageEvidenceV1 = ValidationScopedBoundaryPageEvidence & {
  pageIndex: number;
  requestCursorHash: string | null;
  nextCursorHash: string | null;
  responseSha256: string;
  sourceIds: string[];
};

export type ScopedFolderEnumerationEvidenceV1 = {
  sourceFolderId: string;
  childFolderPages: ScopedBoundaryPageEvidenceV1[];
  directItemPages: ScopedBoundaryPageEvidenceV1[];
};

export type ScopedBoundaryEvidenceV1 = Omit<
  ValidationScopedBoundaryEvidenceBody,
  'folders' | 'enumerations'
> & {
  folders: ScopedFolderMetadata[];
  enumerations: ScopedFolderEnumerationEvidenceV1[];
};

export type ScopedItemMembershipEvidenceV1 = {
  sourceObjectId: string;
  sourceFolderIds: string[];
};

export function assertScopedBoundaryEvidenceV1(
  evidence: ScopedBoundaryEvidenceV1,
  options: ScopedBoundaryValidationOptions = {}
): void {
  const sourceIdMode = requireSourceIdMode(options.sourceIdMode ?? 'benchling');
  if (!isRecord(evidence)) throw new Error('Scoped boundary evidence must be an object.');
  assertExactKeys(
    evidence,
    ['schema', 'runId', 'scope', 'sourceAccountHash', 'capturedAt', 'folders', 'enumerations'],
    'Scoped boundary evidence'
  );
  if (evidence.schema !== SCOPED_BOUNDARY_EVIDENCE_SCHEMA) {
    throw new Error('Scoped boundary evidence has an unsupported schema.');
  }
  requireText(evidence.runId, 'Scoped boundary run ID');
  requireText(evidence.sourceAccountHash, 'Scoped boundary source account hash');
  requireTimestamp(evidence.capturedAt, 'Scoped boundary capture timestamp');
  if (!isRecord(evidence.scope)) {
    throw new Error('Scoped boundary evidence requires Folder or Folder Tree scope.');
  }
  assertExactScopedBoundaryScope(evidence.scope);
  if (!Array.isArray(evidence.folders) || !Array.isArray(evidence.enumerations)) {
    throw new Error('Scoped boundary evidence requires folder and enumeration arrays.');
  }
  for (const folder of evidence.folders) {
    if (!isRecord(folder)) throw new Error('Scoped boundary folder metadata must be an object.');
    assertExactKeys(
      folder,
      ['ref', 'name', 'parentFolderId', 'childrenEnumerated', 'sourceAccountHash'],
      'Scoped boundary folder metadata'
    );
    assertExactSourceRef(folder.ref, 'Scoped boundary folder reference');
    requireFolderSourceId(folder.ref.id, 'Scoped boundary folder ID', sourceIdMode);
  }
  const selectedRefs =
    evidence.scope.kind === 'folder' ? [evidence.scope.folder] : evidence.scope.roots;
  for (const ref of selectedRefs) {
    requireFolderSourceId(ref.id, 'Selected scoped boundary folder ID', sourceIdMode);
  }

  assertScopedFolderBoundary({
    scope: evidence.scope,
    sourceAccountHash: evidence.sourceAccountHash,
    capturedAt: evidence.capturedAt,
    folders: evidence.folders,
  });

  const folderById = new Map(evidence.folders.map((folder) => [folder.ref.id, folder]));
  const includedFolderIds = new Set(
    evidence.scope.kind === 'folder'
      ? [evidence.scope.folder.id]
      : evidence.folders.map((folder) => folder.ref.id)
  );
  const enumerationByFolder = new Map<string, ScopedFolderEnumerationEvidenceV1>();

  for (const enumeration of evidence.enumerations) {
    if (!isRecord(enumeration)) {
      throw new Error('Scoped folder enumeration evidence must be an object.');
    }
    assertExactKeys(
      enumeration,
      ['sourceFolderId', 'childFolderPages', 'directItemPages'],
      'Scoped folder enumeration evidence'
    );
    const folderId = requireFolderSourceId(
      enumeration.sourceFolderId,
      'Enumerated source folder ID',
      sourceIdMode
    );
    if (!includedFolderIds.has(folderId)) {
      throw new Error(`Folder enumeration ${folderId} is outside the selected scope.`);
    }
    if (enumerationByFolder.has(folderId)) {
      throw new Error(`Folder enumeration ${folderId} is duplicated.`);
    }
    assertTerminalPageChain(
      enumeration.childFolderPages,
      folderId,
      'child folders',
      'folder',
      sourceIdMode
    );
    assertTerminalPageChain(
      enumeration.directItemPages,
      folderId,
      'direct items',
      'item',
      sourceIdMode
    );
    enumerationByFolder.set(folderId, enumeration);
  }

  for (const folderId of includedFolderIds) {
    const enumeration = enumerationByFolder.get(folderId);
    if (!enumeration) {
      throw new Error(`Selected folder ${folderId} has no terminal enumeration evidence.`);
    }
    const expectedChildIds = [...folderById.values()]
      .filter((folder) => folder.parentFolderId === folderId)
      .map((folder) => folder.ref.id)
      .sort();
    const enumeratedChildIds = flattenedSourceIds(enumeration.childFolderPages);
    if (canonicalStrings(expectedChildIds) !== canonicalStrings(enumeratedChildIds)) {
      throw new Error(`Folder ${folderId} child enumeration does not match its folder graph.`);
    }
  }

  if (enumerationByFolder.size !== includedFolderIds.size) {
    throw new Error('Scoped folder enumeration evidence is incomplete.');
  }

  void scopedItemMembershipEvidence(evidence, false);
}

export function scopedItemMembershipEvidence(
  evidence: ScopedBoundaryEvidenceV1,
  validate = true,
  options: ScopedBoundaryValidationOptions = {}
): ScopedItemMembershipEvidenceV1[] {
  if (validate) assertScopedBoundaryEvidenceV1(evidence, options);
  const folderIdsByObject = new Map<string, Set<string>>();
  for (const enumeration of evidence.enumerations) {
    const seenInFolder = new Set<string>();
    for (const sourceObjectId of flattenedSourceIds(enumeration.directItemPages)) {
      if (seenInFolder.has(sourceObjectId)) {
        throw new Error(
          `Source object ${sourceObjectId} is duplicated in folder ${enumeration.sourceFolderId} pagination.`
        );
      }
      seenInFolder.add(sourceObjectId);
      const folderIds = folderIdsByObject.get(sourceObjectId) ?? new Set<string>();
      folderIds.add(enumeration.sourceFolderId);
      folderIdsByObject.set(sourceObjectId, folderIds);
    }
  }
  return [...folderIdsByObject]
    .map(([sourceObjectId, sourceFolderIds]) => ({
      sourceObjectId,
      sourceFolderIds: [...sourceFolderIds].sort(),
    }))
    .sort((left, right) => left.sourceObjectId.localeCompare(right.sourceObjectId));
}

export function assertScopedBoundaryEvidenceMatchesSourceObjects(
  evidence: ScopedBoundaryEvidenceV1,
  sourceObjects: readonly SourceObject[],
  options: ScopedBoundarySourceObjectMatchOptions = {}
): void {
  assertScopedBoundaryEvidenceV1(evidence, options);
  const sourceIdMode = requireSourceIdMode(options.sourceIdMode ?? 'benchling');
  const expectedMemberships = new Map(
    scopedItemMembershipEvidence(evidence, false).map((membership) => [
      membership.sourceObjectId,
      membership.sourceFolderIds,
    ])
  );
  const skippedSourceObjectIds = new Set(
    (options.skippedSourceObjectIds ?? []).map((sourceObjectId) =>
      requireItemSourceId(sourceObjectId, 'Skipped source object ID', sourceIdMode)
    )
  );
  for (const sourceObjectId of skippedSourceObjectIds) {
    if (!expectedMemberships.has(sourceObjectId)) {
      throw new Error(
        `Skipped source object ${sourceObjectId} is absent from scoped boundary item enumeration.`
      );
    }
  }
  const includedFolderIds = new Set(
    evidence.scope.kind === 'folder'
      ? [evidence.scope.folder.id]
      : evidence.folders.map((folder) => folder.ref.id)
  );
  const objectById = new Map<string, SourceObject>();
  for (const sourceObject of sourceObjects) {
    const sourceObjectId = requireText(sourceObject.id, 'Captured source object ID');
    if (objectById.has(sourceObjectId)) {
      throw new Error(`Captured source object ${sourceObjectId} is duplicated.`);
    }
    objectById.set(sourceObjectId, sourceObject);
  }

  for (const [sourceObjectId, expectedFolderIds] of expectedMemberships) {
    const sourceObject = objectById.get(sourceObjectId);
    if (skippedSourceObjectIds.has(sourceObjectId)) {
      if (sourceObject) {
        throw new Error(`Skipped boundary item ${sourceObjectId} was captured as a source object.`);
      }
      continue;
    }
    if (!sourceObject) {
      throw new Error(`Boundary item ${sourceObjectId} is missing from captured source objects.`);
    }
    const capturedFolderIds = sortedUnique(
      sourceObject.memberships.filter((folderId) => includedFolderIds.has(folderId)),
      `Source object ${sourceObjectId} membership ID`
    );
    if (canonicalStrings(capturedFolderIds) !== canonicalStrings(expectedFolderIds)) {
      throw new Error(
        `Source object ${sourceObjectId} memberships disagree with scoped boundary evidence.`
      );
    }
  }

  for (const sourceObject of objectById.values()) {
    const capturedFolderIds = sourceObject.memberships.filter((folderId) =>
      includedFolderIds.has(folderId)
    );
    if (capturedFolderIds.length > 0 && !expectedMemberships.has(sourceObject.id)) {
      throw new Error(
        `Captured source object ${sourceObject.id} is absent from scoped boundary item enumeration.`
      );
    }
  }

  classifySourceObjects(evidence.scope, includedFolderIds, objectById);
}

export function computeScopedBoundaryPageResponseSha256(
  input: {
    sourceFolderId: string;
    pageKind: 'child_folders' | 'direct_items';
    pageIndex: number;
    requestCursorHash: string | null;
    nextCursorHash: string | null;
    sourceIds: readonly string[];
  },
  options: ScopedBoundaryValidationOptions = {}
): string {
  const sourceIdMode = requireSourceIdMode(options.sourceIdMode ?? 'benchling');
  const sourceFolderId = requireFolderSourceId(
    input.sourceFolderId,
    'Page digest source folder ID',
    sourceIdMode
  );
  if (input.pageKind !== 'child_folders' && input.pageKind !== 'direct_items') {
    throw new Error('Page digest kind is invalid.');
  }
  if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0) {
    throw new Error('Page digest index must be a non-negative safe integer.');
  }
  assertNullableSha256(input.requestCursorHash, 'Page digest request cursor hash');
  assertNullableSha256(input.nextCursorHash, 'Page digest next cursor hash');
  if (!Array.isArray(input.sourceIds)) throw new Error('Page digest requires source IDs.');
  const requireSourceId =
    input.pageKind === 'child_folders' ? requireFolderSourceId : requireItemSourceId;
  const sourceIds = input.sourceIds
    .map((sourceId) => requireSourceId(sourceId, 'Page digest source ID', sourceIdMode))
    .sort();
  const canonical = JSON.stringify({
    schema: SCOPED_BOUNDARY_PAGE_DIGEST_SCHEMA,
    sourceFolderId,
    pageKind: input.pageKind,
    pageIndex: input.pageIndex,
    requestCursorHash: input.requestCursorHash,
    nextCursorHash: input.nextCursorHash,
    sourceIds,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function createScopedBoundaryAttestation(
  evidence: ScopedBoundaryEvidenceV1,
  options: ScopedBoundaryValidationOptions = {}
): ValidationScopedBoundaryEvidence {
  const sourceIdMode = requireSourceIdMode(options.sourceIdMode ?? 'benchling');
  const serialized = serializeScopedBoundaryEvidenceV1(evidence, { sourceIdMode });
  const canonicalEvidence = JSON.parse(serialized) as ScopedBoundaryEvidenceV1;
  return {
    schema: SCOPED_BOUNDARY_ATTESTATION_SCHEMA,
    evidencePath: SCOPED_BOUNDARY_EVIDENCE_PATH,
    canonicalSha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    sourceIdMode,
    evidence: canonicalEvidence,
  };
}

export function assertScopedBoundaryAttestationMatchesEvidence(
  attestation: ValidationScopedBoundaryEvidence,
  evidence: ScopedBoundaryEvidenceV1
): void {
  if (!isRecord(attestation)) throw new Error('Scoped boundary attestation must be an object.');
  assertExactKeys(
    attestation,
    ['schema', 'evidencePath', 'canonicalSha256', 'sourceIdMode', 'evidence'],
    'Scoped boundary attestation'
  );
  if (
    attestation.schema !== SCOPED_BOUNDARY_ATTESTATION_SCHEMA ||
    attestation.evidencePath !== SCOPED_BOUNDARY_EVIDENCE_PATH
  ) {
    throw new Error('Scoped boundary attestation has an unsupported schema or path.');
  }
  assertSha256(attestation.canonicalSha256, 'Scoped boundary canonical evidence hash');
  const sourceIdMode = requireSourceIdMode(attestation.sourceIdMode);
  assertScopedBoundaryEvidenceV1(attestation.evidence as ScopedBoundaryEvidenceV1, {
    sourceIdMode,
  });
  const expected = createScopedBoundaryAttestation(evidence, {
    sourceIdMode,
  });
  if (
    attestation.canonicalSha256 !== expected.canonicalSha256 ||
    JSON.stringify(attestation.evidence) !== JSON.stringify(expected.evidence)
  ) {
    throw new Error('Scoped boundary attestation does not match the persisted evidence.');
  }
}

export function serializeScopedBoundaryEvidenceV1(
  evidence: ScopedBoundaryEvidenceV1,
  options: ScopedBoundaryValidationOptions = {}
): string {
  assertScopedBoundaryEvidenceV1(evidence, options);
  const canonical: ScopedBoundaryEvidenceV1 = {
    schema: evidence.schema,
    runId: evidence.runId,
    scope: canonicalScopedBoundaryScope(evidence.scope),
    sourceAccountHash: evidence.sourceAccountHash,
    capturedAt: evidence.capturedAt,
    folders: evidence.folders
      .map((folder) => ({
        ref: canonicalSourceRef(folder.ref),
        name: folder.name,
        parentFolderId: folder.parentFolderId,
        childrenEnumerated: folder.childrenEnumerated,
        sourceAccountHash: folder.sourceAccountHash,
      }))
      .sort((left, right) => left.ref.id.localeCompare(right.ref.id)),
    enumerations: evidence.enumerations
      .map((enumeration) => ({
        sourceFolderId: enumeration.sourceFolderId,
        childFolderPages: canonicalPages(enumeration.childFolderPages),
        directItemPages: canonicalPages(enumeration.directItemPages),
      }))
      .sort((left, right) => left.sourceFolderId.localeCompare(right.sourceFolderId)),
  };
  const indentation = options.sourceIdMode === 'replay_fixture' ? 4 : 2;
  return `${JSON.stringify(canonical, null, indentation)}\n`;
}

export function parseScopedBoundaryEvidenceV1(
  serialized: string,
  options: ScopedBoundaryValidationOptions = {}
): ScopedBoundaryEvidenceV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Scoped boundary evidence is not valid JSON.');
  }
  assertScopedBoundaryEvidenceV1(parsed as ScopedBoundaryEvidenceV1, options);
  return parsed as ScopedBoundaryEvidenceV1;
}

function assertTerminalPageChain(
  pages: ScopedBoundaryPageEvidenceV1[],
  sourceFolderId: string,
  label: string,
  sourceKind: 'folder' | 'item',
  sourceIdMode: ValidationScopedBoundarySourceIdMode
): void {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(`Folder ${sourceFolderId} ${label} pagination has no terminal page.`);
  }
  const seenSourceIds = new Set<string>();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!isRecord(page)) {
      throw new Error(`Folder ${sourceFolderId} ${label} page ${index} is invalid.`);
    }
    assertExactKeys(
      page,
      ['pageIndex', 'requestCursorHash', 'nextCursorHash', 'responseSha256', 'sourceIds'],
      `Folder ${sourceFolderId} ${label} page ${index}`
    );
    if (page.pageIndex !== index) {
      throw new Error(`Folder ${sourceFolderId} ${label} pagination is not contiguous.`);
    }
    const expectedRequestCursorHash = index === 0 ? null : pages[index - 1].nextCursorHash;
    assertNullableSha256(page.requestCursorHash, `${label} page ${index} request cursor hash`);
    assertNullableSha256(page.nextCursorHash, `${label} page ${index} next cursor hash`);
    assertSha256(page.responseSha256, `${label} page ${index} response hash`);
    if (page.requestCursorHash !== expectedRequestCursorHash) {
      throw new Error(`Folder ${sourceFolderId} ${label} pagination cursor chain is broken.`);
    }
    const terminal = index === pages.length - 1;
    if ((terminal && page.nextCursorHash !== null) || (!terminal && page.nextCursorHash === null)) {
      throw new Error(`Folder ${sourceFolderId} ${label} pagination lacks terminal evidence.`);
    }
    if (!Array.isArray(page.sourceIds)) {
      throw new Error(`Folder ${sourceFolderId} ${label} page ${index} has no source ID list.`);
    }
    for (const rawSourceId of page.sourceIds) {
      const sourceId =
        sourceKind === 'folder'
          ? requireFolderSourceId(rawSourceId, `${label} page ${index} source ID`, sourceIdMode)
          : requireItemSourceId(rawSourceId, `${label} page ${index} source ID`, sourceIdMode);
      if (seenSourceIds.has(sourceId)) {
        throw new Error(
          `Source ID ${sourceId} is duplicated in folder ${sourceFolderId} ${label} pagination.`
        );
      }
      seenSourceIds.add(sourceId);
    }
    const expectedResponseSha256 = computeScopedBoundaryPageResponseSha256(
      {
        sourceFolderId,
        pageKind: sourceKind === 'folder' ? 'child_folders' : 'direct_items',
        pageIndex: page.pageIndex,
        requestCursorHash: page.requestCursorHash,
        nextCursorHash: page.nextCursorHash,
        sourceIds: page.sourceIds,
      },
      { sourceIdMode }
    );
    if (page.responseSha256 !== expectedResponseSha256) {
      throw new Error(
        `Folder ${sourceFolderId} ${label} page ${index} response digest does not match its normalized page evidence.`
      );
    }
  }
}

function canonicalPages(pages: ScopedBoundaryPageEvidenceV1[]): ScopedBoundaryPageEvidenceV1[] {
  return pages.map((page) => ({
    pageIndex: page.pageIndex,
    requestCursorHash: page.requestCursorHash,
    nextCursorHash: page.nextCursorHash,
    responseSha256: page.responseSha256,
    sourceIds: [...page.sourceIds].sort(),
  }));
}

function canonicalScopedBoundaryScope(
  scope: Exclude<MigrationScope, { kind: 'file' }>
): Exclude<MigrationScope, { kind: 'file' }> {
  return scope.kind === 'folder'
    ? {
        version: scope.version,
        kind: scope.kind,
        folder: canonicalSourceRef(scope.folder),
        includeChildren: scope.includeChildren,
        ...(scope.includeArchived === undefined ? {} : { includeArchived: scope.includeArchived }),
      }
    : {
        version: scope.version,
        kind: scope.kind,
        roots: scope.roots.map(canonicalSourceRef),
        includeChildren: scope.includeChildren,
        ...(scope.includeArchived === undefined ? {} : { includeArchived: scope.includeArchived }),
      };
}

function canonicalSourceRef(ref: BenchlingSourceRef): BenchlingSourceRef {
  return {
    id: ref.id,
    url: ref.url,
    ...(ref.objectType === undefined ? {} : { objectType: ref.objectType }),
  };
}

function assertExactScopedBoundaryScope(
  scope: Record<string, unknown>
): asserts scope is Exclude<MigrationScope, { kind: 'file' }> {
  if (scope.kind === 'folder') {
    assertExactKeys(
      scope,
      [
        'version',
        'kind',
        'folder',
        'includeChildren',
        ...(scope.includeArchived === undefined ? [] : ['includeArchived']),
      ],
      'Folder scope'
    );
    if (scope.includeArchived !== undefined && typeof scope.includeArchived !== 'boolean') {
      throw new Error('Folder include-archived authority must be a boolean.');
    }
    assertExactSourceRef(scope.folder, 'Folder scope reference');
    return;
  }
  if (scope.kind === 'folder_tree') {
    assertExactKeys(
      scope,
      [
        'version',
        'kind',
        'roots',
        'includeChildren',
        ...(scope.includeArchived === undefined ? [] : ['includeArchived']),
      ],
      'Folder Tree scope'
    );
    if (scope.includeArchived !== undefined && typeof scope.includeArchived !== 'boolean') {
      throw new Error('Folder Tree include-archived authority must be a boolean.');
    }
    if (!Array.isArray(scope.roots)) throw new Error('Folder Tree scope roots must be an array.');
    for (const ref of scope.roots) assertExactSourceRef(ref, 'Folder Tree root reference');
    return;
  }
  throw new Error('Scoped boundary evidence requires Folder or Folder Tree scope.');
}

function assertExactSourceRef(value: unknown, label: string): asserts value is BenchlingSourceRef {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ['id', 'url', 'objectType'], label);
  if (!Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'url')) {
    throw new Error(`${label} is missing a required field.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
) {
  const allowedKeys = new Set(allowed);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${label} contains non-allowlisted field(s): ${unknownKeys.sort().join(', ')}.`
    );
  }
}

function flattenedSourceIds(pages: readonly ScopedBoundaryPageEvidenceV1[]): string[] {
  return pages.flatMap((page) => page.sourceIds.map((sourceId) => sourceId.trim()));
}

function sortedUnique(values: readonly string[], label: string): string[] {
  return [...new Set(values.map((value) => requireText(value, label)))].sort();
}

function canonicalStrings(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}

function assertNullableSha256(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertSha256(value, label);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(text).toISOString();
}

function requireSourceIdMode(value: unknown): ValidationScopedBoundarySourceIdMode {
  if (value !== 'benchling' && value !== 'replay_fixture') {
    throw new Error('Scoped boundary source ID mode is invalid.');
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be non-empty single-line text.`);
  }
  return value.trim();
}

function requireStableSourceId(
  value: unknown,
  label: string,
  sourceIdMode: ValidationScopedBoundarySourceIdMode
): string {
  const text = requireText(value, label);
  const pattern =
    sourceIdMode === 'replay_fixture' ? STABLE_REPLAY_SOURCE_ID : STABLE_BENCHLING_SOURCE_ID;
  if (text.length > 200 || !pattern.test(text)) {
    throw new Error(`${label} must be a stable Benchling source ID.`);
  }
  return text;
}

function requireFolderSourceId(
  value: unknown,
  label: string,
  sourceIdMode: ValidationScopedBoundarySourceIdMode
): string {
  const id = requireStableSourceId(value, label, sourceIdMode);
  if (!FOLDER_SOURCE_PREFIXES.has(id.slice(0, id.indexOf('_')).toLowerCase())) {
    throw new Error(`${label} must identify a Benchling folder.`);
  }
  return id;
}

function requireItemSourceId(
  value: unknown,
  label: string,
  sourceIdMode: ValidationScopedBoundarySourceIdMode
): string {
  const id = requireStableSourceId(value, label, sourceIdMode);
  if (FOLDER_SOURCE_PREFIXES.has(id.slice(0, id.indexOf('_')).toLowerCase())) {
    throw new Error(`${label} must identify a non-folder Benchling object.`);
  }
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
