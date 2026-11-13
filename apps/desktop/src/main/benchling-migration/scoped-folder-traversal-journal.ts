import { createHash } from 'node:crypto';
import { computeScopedBoundaryPageResponseSha256 } from './scoped-boundary-evidence';
import { requireCanonicalBenchlingItemUrl } from './canonical-item-url';

export const SCOPED_FOLDER_TRAVERSAL_JOURNAL_SCHEMA =
  'dnaforge.scoped-folder-traversal-journal.v1' as const;
export const SCOPED_FOLDER_TRAVERSAL_RESULT_SCHEMA =
  'dnaforge.scoped-folder-traversal-result.v1' as const;
export const SCOPED_FOLDER_PARENT_AUTHORITY_SCHEMA =
  'dnaforge.benchling.scoped-folder-parent-authority.v1' as const;
export const SCOPED_FOLDER_PAGE_CONTENT_DIGEST_SCHEMA =
  'dnaforge.benchling.scoped-folder-page-content-digest.v1' as const;
export const SCOPED_FOLDER_PAGE_REQUEST_SCHEMA =
  'dnaforge.benchling.scoped-folder-page-request.v1' as const;

export const SCOPED_FOLDER_PAGE_LIMIT = 100;
export const SCOPED_FOLDER_MAX_PAGES = 1_000;
export const SCOPED_FOLDER_MAX_ITEMS = 100_000;

export const SCOPED_FOLDER_SEARCH_TYPES = Object.freeze([
  'aa_sequence',
  'basic_folder_item',
  'bulk_assembly',
  'dna_sequence',
  'entity',
  'entry',
  'file',
  'folder',
  'mixture',
  'oligo',
  'pipeline_file',
  'protein',
  'protocol',
  'registry_entity',
  'rna_oligo',
  'rna_sequence',
  'sequence',
  'source',
] as const);

const CURSOR_DIGEST_SCHEMA = 'dnaforge.scoped-folder-continuation.v1';
const FOLDER_ID = /^(?:fld|lib|src)_[A-Za-z0-9]+$/u;
const ITEM_ID = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/u;
const CONTINUATION_HANDLE = /^sha256:[a-f0-9]{64}$/u;

export function compareScopedFolderCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export type ScopedFolderTraversalScopeKind = 'folder' | 'folder_tree';
export type ScopedFolderContinuation =
  | null
  | { requestField: 'offset'; value: number }
  | {
      requestField: 'continuationHandle';
      value: string;
      offset: number;
    };

export type ScopedFolderTraversalParentAuthority = {
  schema: typeof SCOPED_FOLDER_PARENT_AUTHORITY_SCHEMA;
  scopeKind: 'folder_tree';
  selectedRootId: string;
  folderId: string;
  parentFolderId: string;
  observedParentPageIndex: number;
  observedParentPageDigest: string;
};

export type ScopedFolderTraversalItem = {
  id: string;
  type: (typeof SCOPED_FOLDER_SEARCH_TYPES)[number] | 'unknown';
  name: string;
  archived: boolean;
  sourceUrl?: string;
};

export type ScopedFolderTraversalChild = {
  id: string;
  name: string;
  parentId: string;
  archived: boolean;
};

export type ScopedFolderTraversalPage = {
  folderId: string;
  items: ScopedFolderTraversalItem[];
  childFolders: ScopedFolderTraversalChild[];
  nextContinuation: ScopedFolderContinuation;
  terminal: boolean;
  resultCount: number;
  exactTotal: number | null;
};

export type ScopedFolderTraversalJournalEntry = {
  selectedRootId: string;
  folderId: string;
  pageIndex: number;
  requestContinuation: ScopedFolderContinuation;
  parentAuthority: ScopedFolderTraversalParentAuthority | null;
  pageDigest: string;
  page: ScopedFolderTraversalPage;
};

export type ScopedFolderTraversalJournal = {
  schema: typeof SCOPED_FOLDER_TRAVERSAL_JOURNAL_SCHEMA;
  scopeKind: ScopedFolderTraversalScopeKind;
  includeArchived?: boolean;
  selectedRootIds: string[];
  entries: ScopedFolderTraversalJournalEntry[];
};

export type ScopedFolderTraversalPageRequest = {
  selectedRootId: string;
  folderId: string;
  pageIndex: number;
  continuation: ScopedFolderContinuation;
  parentAuthority: ScopedFolderTraversalParentAuthority | null;
};

export function scopedFolderTraversalPageRequestSha256(
  request: ScopedFolderTraversalPageRequest | unknown
): string {
  const normalized = normalizePageRequest(request);
  return `sha256:${sha256Text(
    canonicalJson({
      schema: SCOPED_FOLDER_PAGE_REQUEST_SCHEMA,
      ...normalized,
    })
  )}`;
}

export type ScopedFolderTraversalFolderFact = {
  id: string;
  name: string | null;
  parentFolderId: string | null;
  childrenEnumerated: boolean;
  archived: boolean | null;
  included: boolean;
};

export type ScopedFolderTraversalPageEvidence = {
  pageIndex: number;
  requestCursorHash: string | null;
  nextCursorHash: string | null;
  responseSha256: string;
  sourceIds: string[];
};

export type ScopedFolderTraversalEnumerationEvidence = {
  sourceFolderId: string;
  childFolderPages: ScopedFolderTraversalPageEvidence[];
  directItemPages: ScopedFolderTraversalPageEvidence[];
};

export type ScopedFolderTraversalMembershipEvidence = {
  sourceObjectId: string;
  sourceFolderIds: string[];
};

export type ScopedFolderTraversalSelectedItemFact = ScopedFolderTraversalItem & {
  sourceFolderIds: string[];
};

export type ScopedFolderTraversalTerminalEvidence = {
  folderFacts: ScopedFolderTraversalFolderFact[];
  excludedChildFolderIds: string[];
  enumerations: ScopedFolderTraversalEnumerationEvidence[];
  itemMemberships: ScopedFolderTraversalMembershipEvidence[];
  selectedItems: ScopedFolderTraversalSelectedItemFact[];
};

export type ScopedFolderTraversalResult = {
  schema: typeof SCOPED_FOLDER_TRAVERSAL_RESULT_SCHEMA;
  scopeKind: ScopedFolderTraversalScopeKind;
  includeArchived: boolean;
  selectedRootIds: string[];
  journalDigest: string;
  terminal: boolean;
  nextRequest: ScopedFolderTraversalPageRequest | null;
  progress: {
    pageCount: number;
    providerResultCount: number;
    discoveredFolderCount: number;
    itemMembershipCount: number;
  };
  terminalEvidence: ScopedFolderTraversalTerminalEvidence | null;
};

type EnumerationState = {
  pages: ScopedFolderTraversalJournalEntry[];
  childIds: Set<string>;
  itemIds: Set<string>;
  resultCount: number;
  exactTotal: number | null;
  terminal: boolean;
};

type ReplayState = {
  journal: ScopedFolderTraversalJournal;
  selectedRootIds: Set<string>;
  folderFacts: Map<string, ScopedFolderTraversalFolderFact>;
  enumerations: Map<string, EnumerationState>;
  memberships: Map<string, Set<string>>;
  itemFacts: Map<string, ScopedFolderTraversalItem>;
  excludedChildFolderIds: Set<string>;
  rootOwner: Map<string, string>;
  parentAuthorities: Map<string, ScopedFolderTraversalParentAuthority | null>;
  issuedContinuationHandles: Set<string>;
  queue: string[];
  queueCursor: number;
  activeFolderId: string | null;
  entryOrdinalByFolderPage: Map<string, number>;
  providerResultCount: number;
  nextRequest: ScopedFolderTraversalPageRequest | null;
};

const scopedFolderCheckpointState = new WeakMap<object, ReplayState>();
const invalidScopedFolderCheckpoints = new WeakSet<object>();

export type DurableScopedFolderTraversalCheckpoint = Readonly<{
  schema: 'dnaforge.scoped-folder-traversal-checkpoint.v1';
}>;

export type DurableScopedFolderTraversalCursor = Readonly<{
  pageCount: number;
  nextRequest: ScopedFolderTraversalPageRequest | null;
}>;

export function createScopedFolderTraversalJournal({
  scopeKind,
  selectedRootIds,
  includeArchived = false,
}: {
  scopeKind: ScopedFolderTraversalScopeKind;
  selectedRootIds: string[];
  includeArchived?: boolean;
}): ScopedFolderTraversalJournal {
  const normalizedScopeKind = requireScopeKind(scopeKind);
  const roots = normalizeSelectedRoots(selectedRootIds, normalizedScopeKind);
  const normalizedIncludeArchived = requireBoolean(includeArchived, 'include-archived authority');
  return immutable({
    schema: SCOPED_FOLDER_TRAVERSAL_JOURNAL_SCHEMA,
    scopeKind: normalizedScopeKind,
    includeArchived: normalizedIncludeArchived,
    selectedRootIds: roots,
    entries: [],
  });
}

export function nextScopedFolderTraversalPage(
  journal: ScopedFolderTraversalJournal | unknown
): ScopedFolderTraversalPageRequest | null {
  const state = replayStructure(journal);
  return state.nextRequest === null ? null : cloneJson(state.nextRequest, 'next request');
}

export function validateAndNormalizeScopedFolderTraversalJournal(
  journal: ScopedFolderTraversalJournal | unknown
): ScopedFolderTraversalJournal {
  return replayStructure(journal).journal;
}

export function validateAndNormalizeDurableScopedFolderTraversalJournal(
  journal: ScopedFolderTraversalJournal | unknown
): ScopedFolderTraversalJournal {
  const normalized = validateAndNormalizeScopedFolderTraversalJournal(journal);
  for (const [ordinal, entry] of normalized.entries.entries())
    assertDurableScopedFolderEntry(entry, ordinal);
  return normalized;
}

export function createDurableScopedFolderTraversalCheckpoint(
  journal: ScopedFolderTraversalJournal | unknown
): DurableScopedFolderTraversalCheckpoint {
  const state = replayStructure(journal);
  for (const [ordinal, entry] of state.journal.entries.entries())
    assertDurableScopedFolderEntry(entry, ordinal);
  const checkpoint = Object.freeze({
    schema: 'dnaforge.scoped-folder-traversal-checkpoint.v1' as const,
  });
  scopedFolderCheckpointState.set(checkpoint, state);
  return checkpoint;
}

export function durableScopedFolderTraversalCheckpointCursor(
  checkpoint: DurableScopedFolderTraversalCheckpoint
): DurableScopedFolderTraversalCursor {
  const state = requireScopedFolderCheckpointState(checkpoint);
  return Object.freeze({
    pageCount: state.journal.entries.length,
    nextRequest:
      state.nextRequest === null ? null : cloneJson(state.nextRequest, 'checkpoint next request'),
  });
}

export function appendDurableScopedFolderTraversalCheckpointEntry(
  checkpoint: DurableScopedFolderTraversalCheckpoint,
  value: unknown
): ScopedFolderTraversalJournalEntry {
  const state = requireScopedFolderCheckpointState(checkpoint);
  try {
    const ordinal = state.journal.entries.length;
    const entry = normalizeJournalEntry(value, ordinal);
    assertDurableScopedFolderEntry(entry, ordinal);
    applyNormalizedReplayEntry(state, entry, ordinal);
    return cloneJson(entry, 'checkpoint appended entry');
  } catch (error) {
    invalidScopedFolderCheckpoints.add(checkpoint);
    throw error;
  }
}

export function verifyDurableScopedFolderTraversalCheckpointReplayEntry(
  checkpoint: DurableScopedFolderTraversalCheckpoint,
  request: ScopedFolderTraversalPageRequest,
  value: unknown
): ScopedFolderTraversalJournalEntry {
  const state = requireScopedFolderCheckpointState(checkpoint);
  const normalizedRequest = normalizePageRequest(request);
  const ordinal = state.entryOrdinalByFolderPage.get(
    scopedFolderEntryIdentity(normalizedRequest.folderId, normalizedRequest.pageIndex)
  );
  if (ordinal === undefined)
    throw new Error('Scoped Folder replay page is not present in the journal.');
  const candidate = normalizeJournalEntry(value, ordinal);
  assertDurableScopedFolderEntry(candidate, ordinal);
  const existing = state.journal.entries[ordinal];
  if (
    canonicalJson(candidate) !== canonicalJson(existing) ||
    canonicalJson(scopedFolderRequestFromJournalEntry(candidate)) !==
      canonicalJson(normalizedRequest)
  ) {
    throw new Error('Scoped Folder replay page conflicts with the immutable journal.');
  }
  return cloneJson(existing, 'checkpoint verified replay entry');
}

export function invalidateDurableScopedFolderTraversalCheckpoint(
  checkpoint: DurableScopedFolderTraversalCheckpoint
): void {
  invalidScopedFolderCheckpoints.add(checkpoint);
}

export function verifyScopedFolderTraversalReplayPage({
  journal,
  selectedRootId,
  folderId,
  pageIndex,
  requestContinuation,
  parentAuthority,
  pageDigest,
  page,
}: {
  journal: ScopedFolderTraversalJournal | unknown;
  selectedRootId: string;
  folderId: string;
  pageIndex: number;
  requestContinuation: ScopedFolderContinuation;
  parentAuthority: ScopedFolderTraversalParentAuthority | null;
  pageDigest: string;
  page: ScopedFolderTraversalPage | unknown;
}): ScopedFolderTraversalJournalEntry {
  const state = replayStructure(journal);
  const normalizedFolderId = requireFolderId(folderId, 'replay folder ID');
  const normalizedPageIndex = requireInteger(
    pageIndex,
    'replay page index',
    0,
    SCOPED_FOLDER_MAX_PAGES - 1
  );
  const existing = state.journal.entries.find(
    (entry) => entry.folderId === normalizedFolderId && entry.pageIndex === normalizedPageIndex
  );
  if (!existing) throw new Error('Scoped Folder replay page is not present in the journal.');
  const normalizedPage = normalizeSanitizedPage(page, normalizedFolderId);
  const candidate: ScopedFolderTraversalJournalEntry = {
    selectedRootId: requireFolderId(selectedRootId, 'replay selected root ID'),
    folderId: normalizedFolderId,
    pageIndex: normalizedPageIndex,
    requestContinuation: normalizeContinuation(requestContinuation),
    parentAuthority: normalizeParentAuthority(parentAuthority),
    pageDigest: requireSha256Ref(pageDigest, 'replay page digest'),
    page: normalizedPage,
  };
  const expectedDigest = scopedFolderTraversalPageDigest(candidate.page);
  if (candidate.pageDigest !== expectedDigest) {
    throw new Error('Scoped Folder replay page content digest is invalid.');
  }
  if (canonicalJson(candidate) !== canonicalJson(existing)) {
    throw new Error('Scoped Folder replay page conflicts with the immutable journal.');
  }
  return immutable(cloneJson(existing, 'verified replay page'));
}

export function appendScopedFolderTraversalPage({
  journal,
  folderId,
  requestContinuation = null,
  parentAuthority = null,
  pageDigest,
  page,
}: {
  journal: ScopedFolderTraversalJournal | unknown;
  folderId: string;
  requestContinuation?: ScopedFolderContinuation;
  parentAuthority?: ScopedFolderTraversalParentAuthority | null;
  pageDigest: string;
  page: ScopedFolderTraversalPage | unknown;
}): ScopedFolderTraversalJournal {
  const state = replayStructure(journal);
  const expected = state.nextRequest;
  if (expected === null) throw new Error('Scoped Folder traversal journal is already terminal.');
  const normalizedFolderId = requireFolderId(folderId, 'append folder ID');
  if (normalizedFolderId !== expected.folderId) {
    throw new Error(
      `Scoped Folder traversal expected ${expected.folderId}, not ${normalizedFolderId}.`
    );
  }
  const normalizedRequestContinuation = normalizeContinuation(requestContinuation);
  if (!jsonEqual(normalizedRequestContinuation, expected.continuation)) {
    throw new Error('Scoped Folder traversal request continuation does not match the journal.');
  }
  const normalizedParentAuthority = normalizeParentAuthority(parentAuthority);
  if (!jsonEqual(normalizedParentAuthority, expected.parentAuthority)) {
    throw new Error('Scoped Folder traversal parent authority does not match the journal.');
  }
  const normalizedPage = normalizeSanitizedPage(page, normalizedFolderId);
  const normalizedPageDigest = requireSha256Ref(pageDigest, 'append page digest');
  const expectedPageDigest = scopedFolderTraversalPageDigest(normalizedPage);
  if (normalizedPageDigest !== expectedPageDigest) {
    throw new Error('Scoped Folder traversal page digest does not match the sanitized page.');
  }
  const next: ScopedFolderTraversalJournal = {
    schema: SCOPED_FOLDER_TRAVERSAL_JOURNAL_SCHEMA,
    scopeKind: state.journal.scopeKind,
    ...(state.journal.includeArchived === undefined
      ? {}
      : { includeArchived: state.journal.includeArchived }),
    selectedRootIds: [...state.journal.selectedRootIds],
    entries: [
      ...state.journal.entries,
      {
        selectedRootId: expected.selectedRootId,
        folderId: normalizedFolderId,
        pageIndex: expected.pageIndex,
        requestContinuation: normalizedRequestContinuation,
        parentAuthority: normalizedParentAuthority,
        pageDigest: normalizedPageDigest,
        page: normalizedPage,
      },
    ],
  };
  replayStructure(next);
  return immutable(next);
}

export async function replayScopedFolderTraversalJournal(
  journal: ScopedFolderTraversalJournal | unknown
): Promise<ScopedFolderTraversalResult> {
  return replayScopedFolderTraversalJournalSync(journal);
}

export function replayScopedFolderTraversalJournalSync(
  journal: ScopedFolderTraversalJournal | unknown
): ScopedFolderTraversalResult {
  const state = replayStructure(journal);
  const journalDigest = sha256Text(canonicalJson(state.journal));
  const terminal = state.nextRequest === null;
  let terminalEvidence: ScopedFolderTraversalTerminalEvidence | null = null;
  if (terminal) {
    const enumerations: ScopedFolderTraversalEnumerationEvidence[] = [];
    for (const folderId of [...state.enumerations.keys()].sort(compareScopedFolderCodeUnits)) {
      const enumeration = state.enumerations.get(folderId);
      if (!enumeration) throw new Error(`Scoped Folder ${folderId} enumeration disappeared.`);
      enumerations.push({
        sourceFolderId: folderId,
        childFolderPages: evidencePages(folderId, 'child_folders', enumeration.pages),
        directItemPages: evidencePages(folderId, 'direct_items', enumeration.pages),
      });
    }
    terminalEvidence = {
      folderFacts: canonicalFolderFacts(state.folderFacts),
      excludedChildFolderIds: [...state.excludedChildFolderIds].sort(compareScopedFolderCodeUnits),
      enumerations,
      itemMemberships: canonicalMemberships(state.memberships),
      selectedItems: canonicalSelectedItems(state.itemFacts, state.memberships),
    };
  }
  return immutable({
    schema: SCOPED_FOLDER_TRAVERSAL_RESULT_SCHEMA,
    scopeKind: state.journal.scopeKind,
    includeArchived: state.journal.includeArchived === true,
    selectedRootIds: [...state.journal.selectedRootIds],
    journalDigest,
    terminal,
    nextRequest: state.nextRequest === null ? null : cloneJson(state.nextRequest, 'next request'),
    progress: {
      pageCount: state.journal.entries.length,
      providerResultCount: state.providerResultCount,
      discoveredFolderCount: state.folderFacts.size,
      itemMembershipCount: [...state.memberships.values()].reduce(
        (count, folderIds) => count + folderIds.size,
        0
      ),
    },
    terminalEvidence,
  });
}

function replayStructure(rawJournal: unknown): ReplayState {
  const normalizedJournal = normalizeJournal(rawJournal);
  const entries = normalizedJournal.entries;
  const journal: ScopedFolderTraversalJournal = {
    ...normalizedJournal,
    entries: [],
  };
  const selectedRootIds = new Set(normalizedJournal.selectedRootIds);
  const folderFacts = new Map<string, ScopedFolderTraversalFolderFact>();
  const rootOwner = new Map<string, string>();
  const parentAuthorities = new Map<string, ScopedFolderTraversalParentAuthority | null>();
  const enumerations = new Map<string, EnumerationState>();
  const queue = [...normalizedJournal.selectedRootIds];
  const memberships = new Map<string, Set<string>>();
  const itemFacts = new Map<string, ScopedFolderTraversalItem>();
  const excludedChildFolderIds = new Set<string>();
  const issuedContinuationHandles = new Set<string>();

  for (const rootId of normalizedJournal.selectedRootIds) {
    folderFacts.set(rootId, rootFact(rootId));
    rootOwner.set(rootId, rootId);
    parentAuthorities.set(rootId, null);
  }

  const state: ReplayState = {
    journal,
    selectedRootIds,
    folderFacts,
    enumerations,
    memberships,
    itemFacts,
    excludedChildFolderIds,
    rootOwner,
    parentAuthorities,
    issuedContinuationHandles,
    queue,
    queueCursor: 0,
    activeFolderId: null,
    entryOrdinalByFolderPage: new Map(),
    providerResultCount: 0,
    nextRequest: null,
  };
  state.nextRequest = nextRequestForState(state);
  for (const [entryOrdinal, entry] of entries.entries())
    applyNormalizedReplayEntry(state, entry, entryOrdinal);
  assertTerminalReplayStateIsComplete(state);
  return state;
}

function applyNormalizedReplayEntry(
  state: ReplayState,
  entry: ScopedFolderTraversalJournalEntry,
  entryOrdinal: number
): void {
  const expected = state.nextRequest;
  if (expected === null) {
    throw new Error('Scoped Folder traversal journal contains a page after terminality.');
  }
  if (
    entry.selectedRootId !== expected.selectedRootId ||
    entry.folderId !== expected.folderId ||
    entry.pageIndex !== expected.pageIndex
  ) {
    throw new Error(`Scoped Folder traversal page ${entryOrdinal} is out of deterministic order.`);
  }
  if (!jsonEqual(entry.requestContinuation, expected.continuation)) {
    throw new Error(`Scoped Folder traversal page ${entryOrdinal} has a broken cursor chain.`);
  }
  if (!jsonEqual(entry.parentAuthority, expected.parentAuthority)) {
    throw new Error(`Scoped Folder traversal page ${entryOrdinal} has broken parent authority.`);
  }
  const page = entry.page;
  if (page.folderId !== entry.folderId) {
    throw new Error(`Scoped Folder traversal page ${entryOrdinal} changed folder identity.`);
  }
  if (
    !page.terminal &&
    page.resultCount === 0 &&
    page.nextContinuation?.requestField !== 'continuationHandle'
  ) {
    throw new Error('Scoped Folder traversal pagination made no progress.');
  }

  state.activeFolderId = entry.folderId;
  const enumeration = state.enumerations.get(entry.folderId) ?? emptyEnumeration();
  validateContinuationProgress({
    requestContinuation: entry.requestContinuation,
    nextContinuation: page.nextContinuation,
    observedBefore: enumeration.resultCount,
    resultCount: page.resultCount,
  });
  if (
    page.nextContinuation?.requestField === 'continuationHandle' &&
    state.issuedContinuationHandles.has(page.nextContinuation.value)
  ) {
    throw new Error('Scoped Folder traversal pagination reused a prior continuation handle.');
  }
  if (page.nextContinuation?.requestField === 'continuationHandle') {
    state.issuedContinuationHandles.add(page.nextContinuation.value);
  }
  const expectedPageDigest = scopedFolderTraversalPageDigest(page);
  if (entry.pageDigest !== expectedPageDigest) {
    throw new Error(`Scoped Folder traversal page ${entryOrdinal} has an invalid page digest.`);
  }
  state.providerResultCount += page.resultCount;
  requireAtMost(state.providerResultCount, SCOPED_FOLDER_MAX_ITEMS, 'provider result count');
  enumeration.resultCount += page.resultCount;
  if (page.exactTotal !== null) {
    if (enumeration.exactTotal !== null && enumeration.exactTotal !== page.exactTotal) {
      throw new Error(`Scoped Folder ${entry.folderId} exact count changed between pages.`);
    }
    enumeration.exactTotal = page.exactTotal;
  }
  if (enumeration.exactTotal !== null && enumeration.resultCount > enumeration.exactTotal) {
    throw new Error(`Scoped Folder ${entry.folderId} exceeded its exact result count.`);
  }
  if (
    enumeration.exactTotal !== null &&
    enumeration.resultCount === enumeration.exactTotal &&
    page.nextContinuation !== null
  ) {
    throw new Error(`Scoped Folder ${entry.folderId} continued after its exact result count.`);
  }

  for (const item of page.items) {
    if (enumeration.itemIds.has(item.id)) {
      throw new Error(
        `Scoped Folder item ${item.id} is duplicated in ${entry.folderId} pagination.`
      );
    }
    enumeration.itemIds.add(item.id);
    const priorItem = state.itemFacts.get(item.id);
    if (
      priorItem &&
      (priorItem.type !== item.type ||
        priorItem.name !== item.name ||
        priorItem.archived !== item.archived ||
        priorItem.sourceUrl !== item.sourceUrl)
    ) {
      throw new Error(`Scoped Folder item ${item.id} has conflicting metadata across folders.`);
    }
    if (!priorItem) state.itemFacts.set(item.id, { ...item });
    const folderIds = state.memberships.get(item.id) ?? new Set<string>();
    folderIds.add(entry.folderId);
    state.memberships.set(item.id, folderIds);
  }
  for (const child of page.childFolders) {
    if (enumeration.childIds.has(child.id)) {
      throw new Error(
        `Scoped Folder child ${child.id} is duplicated in ${entry.folderId} pagination.`
      );
    }
    enumeration.childIds.add(child.id);
    if (state.journal.scopeKind === 'folder') {
      addDirectExcludedChild({
        child,
        parentFolderId: entry.folderId,
        selectedRootIds: state.selectedRootIds,
        folderFacts: state.folderFacts,
        excludedChildFolderIds: state.excludedChildFolderIds,
      });
    } else {
      addTreeChild({
        child,
        parentFolderId: entry.folderId,
        selectedRootId: entry.selectedRootId,
        observedParentPageIndex: entry.pageIndex,
        observedParentPageDigest: entry.pageDigest,
        selectedRootIds: state.selectedRootIds,
        folderFacts: state.folderFacts,
        excludedChildFolderIds: state.excludedChildFolderIds,
        rootOwner: state.rootOwner,
        parentAuthorities: state.parentAuthorities,
        includeArchived: state.journal.includeArchived === true,
      });
    }
  }

  enumeration.pages.push(entry);
  if (page.terminal) {
    if (enumeration.exactTotal !== null && enumeration.resultCount !== enumeration.exactTotal) {
      throw new Error(`Scoped Folder ${entry.folderId} terminated before its exact count.`);
    }
    enumeration.terminal = true;
    const folderFact = state.folderFacts.get(entry.folderId);
    if (!folderFact) throw new Error(`Scoped Folder ${entry.folderId} has no folder fact.`);
    folderFact.childrenEnumerated = true;
    if (state.journal.scopeKind === 'folder_tree') {
      state.queue.push(
        ...[...enumeration.childIds]
          .filter((childId) => state.folderFacts.get(childId)?.included === true)
          .sort(compareScopedFolderCodeUnits)
      );
    }
    state.activeFolderId = null;
    state.queueCursor += 1;
  }
  state.enumerations.set(entry.folderId, enumeration);
  const entryIdentity = scopedFolderEntryIdentity(entry.folderId, entry.pageIndex);
  if (state.entryOrdinalByFolderPage.has(entryIdentity)) {
    throw new Error('Scoped Folder traversal journal contains a duplicate folder page.');
  }
  state.entryOrdinalByFolderPage.set(entryIdentity, entryOrdinal);
  state.journal.entries.push(entry);
  requireAtMost(state.journal.entries.length, SCOPED_FOLDER_MAX_PAGES, 'page count');
  requireAtMost(state.folderFacts.size, SCOPED_FOLDER_MAX_ITEMS, 'folder count');
  requireAtMost(state.memberships.size, SCOPED_FOLDER_MAX_ITEMS, 'item count');
  state.nextRequest = nextRequestForState(state);
  assertTerminalReplayStateIsComplete(state);
}

function nextRequestForState(state: ReplayState): ScopedFolderTraversalPageRequest | null {
  const folderId = state.activeFolderId ?? state.queue[state.queueCursor] ?? null;
  if (folderId === null) return null;
  const selectedRootId = state.rootOwner.get(folderId);
  if (!selectedRootId) {
    throw new Error(`Scoped Folder ${folderId} has no selected-root authority.`);
  }
  if (!state.parentAuthorities.has(folderId)) {
    throw new Error(`Scoped Folder ${folderId} has no parent authority.`);
  }
  const pages = state.enumerations.get(folderId)?.pages ?? [];
  const continuation = pages.length === 0 ? null : pages[pages.length - 1].page.nextContinuation;
  return {
    selectedRootId,
    folderId,
    pageIndex: pages.length,
    continuation: cloneJson(continuation, 'request continuation'),
    parentAuthority: cloneJson(state.parentAuthorities.get(folderId) ?? null, 'parent authority'),
  };
}

function assertTerminalReplayStateIsComplete(state: ReplayState): void {
  if (state.nextRequest !== null) return;
  for (const folderId of state.queue) {
    if (state.enumerations.get(folderId)?.terminal !== true) {
      throw new Error(`Scoped Folder ${folderId} lacks terminal enumeration evidence.`);
    }
  }
}

function addDirectExcludedChild({
  child,
  parentFolderId,
  selectedRootIds,
  folderFacts,
  excludedChildFolderIds,
}: {
  child: ScopedFolderTraversalChild;
  parentFolderId: string;
  selectedRootIds: Set<string>;
  folderFacts: Map<string, ScopedFolderTraversalFolderFact>;
  excludedChildFolderIds: Set<string>;
}): void {
  if (selectedRootIds.has(child.id) || child.id === parentFolderId) {
    throw new Error(`Scoped Folder hierarchy contains a cycle at ${child.id}.`);
  }
  if (folderFacts.has(child.id)) {
    throw new Error(`Scoped Folder child ${child.id} has conflicting parent evidence.`);
  }
  folderFacts.set(child.id, childFact(child, false));
  excludedChildFolderIds.add(child.id);
}

function addTreeChild({
  child,
  parentFolderId,
  selectedRootId,
  observedParentPageIndex,
  observedParentPageDigest,
  selectedRootIds,
  folderFacts,
  excludedChildFolderIds,
  rootOwner,
  parentAuthorities,
  includeArchived,
}: {
  child: ScopedFolderTraversalChild;
  parentFolderId: string;
  selectedRootId: string;
  observedParentPageIndex: number;
  observedParentPageDigest: string;
  selectedRootIds: Set<string>;
  folderFacts: Map<string, ScopedFolderTraversalFolderFact>;
  excludedChildFolderIds: Set<string>;
  rootOwner: Map<string, string>;
  parentAuthorities: Map<string, ScopedFolderTraversalParentAuthority | null>;
  includeArchived: boolean;
}): void {
  if (selectedRootIds.has(child.id)) {
    throw new Error(`Selected root ${child.id} was rediscovered as a descendant.`);
  }
  let cursor: string | null = parentFolderId;
  while (cursor !== null) {
    if (cursor === child.id) {
      throw new Error(`Scoped Folder hierarchy contains a cycle at ${child.id}.`);
    }
    cursor = folderFacts.get(cursor)?.parentFolderId ?? null;
  }
  const existing = folderFacts.get(child.id);
  if (existing) {
    const priorOwner = rootOwner.get(child.id);
    const nextOwner = rootOwner.get(parentFolderId);
    if (existing.parentFolderId !== parentFolderId || priorOwner !== nextOwner) {
      throw new Error(`Scoped Folder child ${child.id} crosses selected-root boundaries.`);
    }
    throw new Error(`Scoped Folder child ${child.id} is duplicated.`);
  }
  const owner = rootOwner.get(parentFolderId);
  if (!owner) throw new Error(`Scoped Folder parent ${parentFolderId} has no selected root.`);
  if (owner !== selectedRootId) {
    throw new Error(`Scoped Folder parent ${parentFolderId} changed selected-root authority.`);
  }
  const included = includeArchived || !child.archived;
  folderFacts.set(child.id, childFact(child, included));
  if (!included) {
    excludedChildFolderIds.add(child.id);
    return;
  }
  rootOwner.set(child.id, owner);
  parentAuthorities.set(
    child.id,
    immutable({
      schema: SCOPED_FOLDER_PARENT_AUTHORITY_SCHEMA,
      scopeKind: 'folder_tree',
      selectedRootId,
      folderId: child.id,
      parentFolderId,
      observedParentPageIndex,
      observedParentPageDigest: requireSha256Ref(
        observedParentPageDigest,
        'observed parent page digest'
      ),
    })
  );
}

function rootFact(id: string): ScopedFolderTraversalFolderFact {
  return {
    id,
    name: null,
    parentFolderId: null,
    childrenEnumerated: false,
    archived: null,
    included: true,
  };
}

function childFact(
  child: ScopedFolderTraversalChild,
  included: boolean
): ScopedFolderTraversalFolderFact {
  return {
    id: child.id,
    name: child.name,
    parentFolderId: child.parentId,
    childrenEnumerated: false,
    archived: child.archived,
    included,
  };
}

function emptyEnumeration(): EnumerationState {
  return {
    pages: [],
    childIds: new Set(),
    itemIds: new Set(),
    resultCount: 0,
    exactTotal: null,
    terminal: false,
  };
}

function evidencePages(
  sourceFolderId: string,
  pageKind: 'child_folders' | 'direct_items',
  entries: ScopedFolderTraversalJournalEntry[]
): ScopedFolderTraversalPageEvidence[] {
  return entries.map((entry) => {
    const requestCursorHash = cursorHash(entry.requestContinuation);
    const nextCursorHash = cursorHash(entry.page.nextContinuation);
    const sourceIds = (pageKind === 'child_folders' ? entry.page.childFolders : entry.page.items)
      .map(({ id }) => id)
      .sort(compareScopedFolderCodeUnits);
    const page: ScopedFolderTraversalPageEvidence = {
      pageIndex: entry.pageIndex,
      requestCursorHash,
      nextCursorHash,
      responseSha256: computeScopedBoundaryPageResponseSha256({
        sourceFolderId,
        pageKind,
        pageIndex: entry.pageIndex,
        requestCursorHash,
        nextCursorHash,
        sourceIds,
      }),
      sourceIds,
    };
    return page;
  });
}

function cursorHash(continuation: ScopedFolderContinuation): string | null {
  if (continuation === null) return null;
  return sha256Text(canonicalJson({ schema: CURSOR_DIGEST_SCHEMA, continuation }));
}

function requireScopedFolderCheckpointState(
  checkpoint: DurableScopedFolderTraversalCheckpoint
): ReplayState {
  if (invalidScopedFolderCheckpoints.has(checkpoint)) {
    throw new Error('Scoped Folder traversal checkpoint is invalid and must be rebuilt.');
  }
  const state = scopedFolderCheckpointState.get(checkpoint);
  if (!state) throw new Error('Scoped Folder traversal checkpoint is not recognized.');
  return state;
}

function assertDurableScopedFolderEntry(
  entry: ScopedFolderTraversalJournalEntry,
  ordinal: number
): void {
  const exposedFactCount = entry.page.items.length + entry.page.childFolders.length;
  if (entry.page.resultCount !== exposedFactCount) {
    throw new Error(
      `Scoped Folder durable page ${ordinal} result count does not equal its exposed in-scope facts.`
    );
  }
  if (entry.page.exactTotal !== null) {
    throw new Error(
      `Scoped Folder durable page ${ordinal} must not persist a provider exact total.`
    );
  }
}

function scopedFolderRequestFromJournalEntry(
  entry: ScopedFolderTraversalJournalEntry
): ScopedFolderTraversalPageRequest {
  return {
    selectedRootId: entry.selectedRootId,
    folderId: entry.folderId,
    pageIndex: entry.pageIndex,
    continuation: entry.requestContinuation,
    parentAuthority: entry.parentAuthority,
  };
}

function scopedFolderEntryIdentity(folderId: string, pageIndex: number): string {
  return `${folderId}\u0000${pageIndex}`;
}

export function scopedFolderTraversalPageDigest(page: ScopedFolderTraversalPage): string {
  const normalizedPage = normalizeSanitizedPage(page, page.folderId);
  return `sha256:${sha256Text(
    canonicalJson({
      schema: SCOPED_FOLDER_PAGE_CONTENT_DIGEST_SCHEMA,
      folderId: normalizedPage.folderId,
      items: normalizedPage.items,
      childFolders: normalizedPage.childFolders,
      terminal: normalizedPage.terminal,
      resultCount: normalizedPage.resultCount,
      exactTotal: normalizedPage.exactTotal,
    })
  )}`;
}

function sha256Text(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex');
  if (!SHA256.test(digest)) throw new Error('Scoped Folder traversal SHA-256 failed.');
  return digest;
}

function normalizeJournal(value: unknown): ScopedFolderTraversalJournal {
  requireRecord(value, 'journal');
  assertExactKeys(
    value,
    ['schema', 'scopeKind', 'includeArchived', 'selectedRootIds', 'entries'],
    'journal'
  );
  if (value.schema !== SCOPED_FOLDER_TRAVERSAL_JOURNAL_SCHEMA) {
    throw new Error('Scoped Folder traversal journal schema is unsupported.');
  }
  const scopeKind = requireScopeKind(value.scopeKind);
  const includeArchived =
    value.includeArchived === undefined
      ? undefined
      : requireBoolean(value.includeArchived, 'include-archived authority');
  const selectedRootIds = normalizeSelectedRoots(value.selectedRootIds, scopeKind);
  if (!Array.isArray(value.entries)) {
    throw new Error('Scoped Folder traversal journal entries must be an array.');
  }
  requireAtMost(value.entries.length, SCOPED_FOLDER_MAX_PAGES, 'page count');
  const entries = value.entries.map((entry, index) => normalizeJournalEntry(entry, index));
  return {
    schema: value.schema,
    scopeKind,
    ...(includeArchived === undefined ? {} : { includeArchived }),
    selectedRootIds,
    entries,
  };
}

function normalizePageRequest(value: unknown): ScopedFolderTraversalPageRequest {
  requireRecord(value, 'page request');
  assertExactKeys(
    value,
    ['selectedRootId', 'folderId', 'pageIndex', 'continuation', 'parentAuthority'],
    'page request'
  );
  const selectedRootId = requireFolderId(value.selectedRootId, 'page request selected root ID');
  const folderId = requireFolderId(value.folderId, 'page request folder ID');
  const pageIndex = requireInteger(
    value.pageIndex,
    'page request page index',
    0,
    SCOPED_FOLDER_MAX_PAGES - 1
  );
  const continuation = normalizeContinuation(value.continuation);
  const parentAuthority = normalizeParentAuthority(value.parentAuthority);
  if (pageIndex === 0 && continuation !== null) {
    throw new Error('Scoped Folder traversal first page request cannot have a continuation.');
  }
  if (pageIndex > 0 && continuation === null) {
    throw new Error('Scoped Folder traversal later page request requires a continuation.');
  }
  if (parentAuthority === null) {
    if (selectedRootId !== folderId) {
      throw new Error('Scoped Folder traversal root page request has a mismatched selected root.');
    }
  } else if (
    parentAuthority.selectedRootId !== selectedRootId ||
    parentAuthority.folderId !== folderId
  ) {
    throw new Error('Scoped Folder traversal page request conflicts with its parent authority.');
  }
  return { selectedRootId, folderId, pageIndex, continuation, parentAuthority };
}

function normalizeJournalEntry(value: unknown, ordinal: number): ScopedFolderTraversalJournalEntry {
  requireRecord(value, `journal entry ${ordinal}`);
  assertExactKeys(
    value,
    [
      'selectedRootId',
      'folderId',
      'pageIndex',
      'requestContinuation',
      'parentAuthority',
      'pageDigest',
      'page',
    ],
    `journal entry ${ordinal}`
  );
  const selectedRootId = requireFolderId(
    value.selectedRootId,
    `journal entry ${ordinal} selected root ID`
  );
  const folderId = requireFolderId(value.folderId, `journal entry ${ordinal} folder ID`);
  const pageIndex = requireInteger(
    value.pageIndex,
    `journal entry ${ordinal} page index`,
    0,
    SCOPED_FOLDER_MAX_PAGES
  );
  return {
    selectedRootId,
    folderId,
    pageIndex,
    requestContinuation: normalizeContinuation(value.requestContinuation),
    parentAuthority: normalizeParentAuthority(value.parentAuthority),
    pageDigest: requireSha256Ref(value.pageDigest, `journal entry ${ordinal} page digest`),
    page: normalizeSanitizedPage(value.page, folderId),
  };
}

function normalizeSanitizedPage(
  value: unknown,
  expectedFolderId: string
): ScopedFolderTraversalPage {
  requireRecord(value, 'sanitized page');
  assertExactKeys(
    value,
    [
      'folderId',
      'items',
      'childFolders',
      'nextContinuation',
      'terminal',
      'resultCount',
      'exactTotal',
    ],
    'sanitized page'
  );
  const folderId = requireFolderId(value.folderId, 'sanitized page folder ID');
  if (folderId !== expectedFolderId) {
    throw new Error('Scoped Folder sanitized page belongs to a different folder.');
  }
  if (!Array.isArray(value.items) || !Array.isArray(value.childFolders)) {
    throw new Error('Scoped Folder sanitized page requires item and child-folder arrays.');
  }
  if (value.items.length + value.childFolders.length > SCOPED_FOLDER_PAGE_LIMIT) {
    throw new Error('Scoped Folder sanitized page exceeded the page limit.');
  }
  const items = value.items.map(normalizeItem);
  const childFolders = value.childFolders.map((child) => normalizeChild(child, folderId));
  requireCanonicalIds(items, 'sanitized item');
  requireCanonicalIds(childFolders, 'sanitized child folder');
  const combinedIds = [...items, ...childFolders].map(({ id }) => id);
  if (new Set(combinedIds).size !== combinedIds.length) {
    throw new Error('Scoped Folder sanitized page contains a duplicate source ID.');
  }
  const nextContinuation = normalizeContinuation(value.nextContinuation);
  if (typeof value.terminal !== 'boolean' || value.terminal !== (nextContinuation === null)) {
    throw new Error('Scoped Folder sanitized page terminality contradicts its continuation.');
  }
  const resultCount = requireInteger(
    value.resultCount,
    'sanitized page result count',
    0,
    SCOPED_FOLDER_PAGE_LIMIT
  );
  if (items.length + childFolders.length > resultCount) {
    throw new Error('Scoped Folder sanitized page exposes more facts than provider results.');
  }
  const exactTotal =
    value.exactTotal === null
      ? null
      : requireInteger(value.exactTotal, 'sanitized page exact total', 0, SCOPED_FOLDER_MAX_ITEMS);
  return {
    folderId,
    items,
    childFolders,
    nextContinuation,
    terminal: value.terminal,
    resultCount,
    exactTotal,
  };
}

function normalizeItem(value: unknown): ScopedFolderTraversalItem {
  requireRecord(value, 'sanitized item');
  assertExactKeys(
    value,
    ['id', 'type', 'name', 'archived', ...(value.sourceUrl === undefined ? [] : ['sourceUrl'])],
    'sanitized item'
  );
  const id = requireItemId(value.id, 'sanitized item ID');
  const type =
    typeof value.type === 'string' &&
    (SCOPED_FOLDER_SEARCH_TYPES.includes(
      value.type as (typeof SCOPED_FOLDER_SEARCH_TYPES)[number]
    ) ||
      value.type === 'unknown')
      ? (value.type as ScopedFolderTraversalItem['type'])
      : null;
  if (type === null) throw new Error(`Scoped Folder sanitized item ${id} has an invalid type.`);
  return {
    id,
    type,
    name: requireName(value.name, `sanitized item ${id} name`),
    archived: requireBoolean(value.archived, `sanitized item ${id} archived state`),
    ...(value.sourceUrl === undefined
      ? {}
      : { sourceUrl: requireCanonicalItemUrl(value.sourceUrl, id) }),
  };
}

function requireCanonicalItemUrl(value: unknown, sourceItemId: string): string {
  try {
    return requireCanonicalBenchlingItemUrl(value, sourceItemId);
  } catch {
    throw new Error(`Scoped Folder sanitized item ${sourceItemId} URL is not canonical.`);
  }
}

function normalizeChild(value: unknown, folderId: string): ScopedFolderTraversalChild {
  requireRecord(value, 'sanitized child folder');
  assertExactKeys(value, ['id', 'name', 'parentId', 'archived'], 'sanitized child folder');
  const id = requireFolderId(value.id, 'sanitized child folder ID');
  const parentId = requireFolderId(value.parentId, `sanitized child folder ${id} parent ID`);
  if (parentId !== folderId) {
    throw new Error(`Scoped Folder sanitized child ${id} has a cross-folder parent.`);
  }
  return {
    id,
    name: requireName(value.name, `sanitized child folder ${id} name`),
    parentId,
    archived: requireBoolean(value.archived, `sanitized child folder ${id} archived state`),
  };
}

function normalizeContinuation(value: unknown): ScopedFolderContinuation {
  if (value === null) return null;
  requireRecord(value, 'continuation');
  const field = value.requestField;
  if (field === 'offset') {
    assertExactKeys(value, ['requestField', 'value'], 'offset continuation');
    return {
      requestField: field,
      value: requireInteger(value.value, 'continuation offset', 0, SCOPED_FOLDER_MAX_ITEMS),
    };
  }
  if (field !== 'continuationHandle') {
    throw new Error('Scoped Folder continuation field is not allowlisted.');
  }
  assertExactKeys(value, ['requestField', 'value', 'offset'], 'continuation handle');
  const normalized: Exclude<ScopedFolderContinuation, null | { requestField: 'offset' }> = {
    requestField: field,
    value: requireContinuationHandle(value.value),
    offset: requireInteger(value.offset, 'continuation offset', 0, SCOPED_FOLDER_MAX_ITEMS),
  };
  return normalized;
}

function requireContinuationHandle(value: unknown): string {
  if (typeof value !== 'string' || !CONTINUATION_HANDLE.test(value)) {
    throw new Error('Scoped Folder continuation handle is invalid.');
  }
  return value;
}

function normalizeParentAuthority(value: unknown): ScopedFolderTraversalParentAuthority | null {
  if (value === null) return null;
  requireRecord(value, 'parent authority');
  assertExactKeys(
    value,
    [
      'schema',
      'scopeKind',
      'selectedRootId',
      'folderId',
      'parentFolderId',
      'observedParentPageIndex',
      'observedParentPageDigest',
    ],
    'parent authority'
  );
  if (value.schema !== SCOPED_FOLDER_PARENT_AUTHORITY_SCHEMA || value.scopeKind !== 'folder_tree') {
    throw new Error('Scoped Folder parent authority schema or scope is invalid.');
  }
  return {
    schema: SCOPED_FOLDER_PARENT_AUTHORITY_SCHEMA,
    scopeKind: 'folder_tree',
    selectedRootId: requireFolderId(value.selectedRootId, 'parent authority selected root ID'),
    folderId: requireFolderId(value.folderId, 'parent authority folder ID'),
    parentFolderId: requireFolderId(value.parentFolderId, 'parent authority parent folder ID'),
    observedParentPageIndex: requireInteger(
      value.observedParentPageIndex,
      'parent authority page index',
      0,
      SCOPED_FOLDER_MAX_PAGES - 1
    ),
    observedParentPageDigest: requireSha256Ref(
      value.observedParentPageDigest,
      'parent authority page digest'
    ),
  };
}

function validateContinuationProgress({
  requestContinuation,
  nextContinuation,
  observedBefore,
  resultCount,
}: {
  requestContinuation: ScopedFolderContinuation;
  nextContinuation: ScopedFolderContinuation;
  observedBefore: number;
  resultCount: number;
}): void {
  const requestOffset = continuationExactOffset(requestContinuation);
  if (requestOffset !== observedBefore) {
    throw new Error(
      'Scoped Folder traversal request continuation offset skipped provider results.'
    );
  }
  if (nextContinuation === null) return;
  const observedAfter = observedBefore + resultCount;
  const nextOffset = continuationExactOffset(nextContinuation);
  if (nextOffset !== observedAfter) {
    throw new Error('Scoped Folder traversal next continuation offset skipped provider results.');
  }
  if (
    requestContinuation !== null &&
    requestContinuation.requestField === 'continuationHandle' &&
    nextContinuation.requestField === 'continuationHandle' &&
    requestContinuation.value === nextContinuation.value
  ) {
    throw new Error('Scoped Folder traversal pagination token did not advance.');
  }
}

function continuationExactOffset(continuation: ScopedFolderContinuation): number {
  if (continuation === null) return 0;
  return continuation.requestField === 'offset' ? continuation.value : continuation.offset;
}

function canonicalFolderFacts(
  folderFacts: Map<string, ScopedFolderTraversalFolderFact>
): ScopedFolderTraversalFolderFact[] {
  return [...folderFacts.values()]
    .map((fact) => ({ ...fact }))
    .sort((left, right) => compareScopedFolderCodeUnits(left.id, right.id));
}

function canonicalMemberships(
  memberships: Map<string, Set<string>>
): ScopedFolderTraversalMembershipEvidence[] {
  return [...memberships.entries()]
    .map(([sourceObjectId, sourceFolderIds]) => ({
      sourceObjectId,
      sourceFolderIds: [...sourceFolderIds].sort(compareScopedFolderCodeUnits),
    }))
    .sort((left, right) => compareScopedFolderCodeUnits(left.sourceObjectId, right.sourceObjectId));
}

function canonicalSelectedItems(
  itemFacts: Map<string, ScopedFolderTraversalItem>,
  memberships: Map<string, Set<string>>
): ScopedFolderTraversalSelectedItemFact[] {
  return [...itemFacts.values()]
    .map((item) => {
      const sourceFolderIds = memberships.get(item.id);
      if (!sourceFolderIds || sourceFolderIds.size === 0) {
        throw new Error(`Scoped Folder item ${item.id} has no selected-folder membership.`);
      }
      return {
        ...item,
        sourceFolderIds: [...sourceFolderIds].sort(compareScopedFolderCodeUnits),
      };
    })
    .sort((left, right) => compareScopedFolderCodeUnits(left.id, right.id));
}

function normalizeSelectedRoots(
  value: unknown,
  scopeKind: ScopedFolderTraversalScopeKind
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Scoped Folder traversal requires selected root IDs.');
  }
  if (scopeKind === 'folder' && value.length !== 1) {
    throw new Error('Direct Folder traversal requires exactly one selected root.');
  }
  requireAtMost(value.length, SCOPED_FOLDER_MAX_PAGES, 'selected root count');
  const roots = value
    .map((id) => requireFolderId(id, 'selected root ID'))
    .sort(compareScopedFolderCodeUnits);
  if (new Set(roots).size !== roots.length) {
    throw new Error('Scoped Folder traversal selected roots contain duplicates.');
  }
  return roots;
}

function requireCanonicalIds(values: Array<{ id: string }>, label: string): void {
  const ids = values.map(({ id }) => id);
  const sorted = [...ids].sort(compareScopedFolderCodeUnits);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Scoped Folder ${label} IDs contain duplicates.`);
  }
  if (!jsonEqual(ids, sorted)) {
    throw new Error(`Scoped Folder ${label} IDs are not canonically ordered.`);
  }
}

function requireScopeKind(value: unknown): ScopedFolderTraversalScopeKind {
  if (value !== 'folder' && value !== 'folder_tree') {
    throw new Error('Scoped Folder traversal scope kind is invalid.');
  }
  return value;
}

function requireFolderId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !FOLDER_ID.test(value)) {
    throw new Error(`Scoped Folder ${label} is not a stable folder ID.`);
  }
  return value;
}

function requireItemId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ITEM_ID.test(value) || FOLDER_ID.test(value)) {
    throw new Error(`Scoped Folder ${label} is not a stable item ID.`);
  }
  return value;
}

function requireSha256Ref(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_REF.test(value)) {
    throw new Error(`Scoped Folder ${label} is not a prefixed SHA-256 digest.`);
  }
  return value;
}

function requireName(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 500 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`Scoped Folder ${label} is invalid.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Scoped Folder ${label} is invalid.`);
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Scoped Folder ${label} is out of bounds.`);
  }
  return value as number;
}

function requireAtMost(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new Error(`Scoped Folder traversal ${label} exceeded its bound.`);
}

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Scoped Folder traversal ${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowlist = new Set(allowed);
  const extras = Object.keys(value)
    .filter((key) => !allowlist.has(key))
    .sort(compareScopedFolderCodeUnits);
  if (extras.length > 0) {
    throw new Error(
      `Scoped Folder traversal ${label} contains non-allowlisted field(s): ${extras.join(', ')}.`
    );
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function canonicalScopedFolderTraversalJson(value: unknown): string {
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareScopedFolderCodeUnits)
      .map((key) => [key, sortJson(value[key])])
  );
}

function cloneJson<T>(value: T, label: string): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw new Error(`Scoped Folder traversal ${label} is not JSON-safe.`);
  }
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) immutable(child);
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) immutable(child);
    return Object.freeze(value) as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
