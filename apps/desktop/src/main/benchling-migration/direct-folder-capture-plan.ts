import { createHash } from 'node:crypto';

import type {
  BenchlingSourceRef,
  DirectFolderExportAuthority,
  MigrationNetworkAction,
  MigrationScope,
} from '../../shared/benchling-migration';
import type { MigrationCapturePreflight } from './migration-capture-contracts';
import { canonicalBenchlingItemUrl, requireCanonicalBenchlingItemUrl } from './canonical-item-url';
import { benchlingOrganizationBaseUrlFromSourceUrl } from './source-identity';
import {
  SCOPED_FOLDER_SEARCH_TYPES,
  canonicalScopedFolderTraversalJson,
  replayScopedFolderTraversalJournalSync,
  validateAndNormalizeDurableScopedFolderTraversalJournal,
  type ScopedFolderTraversalJournal,
  type ScopedFolderTraversalItem,
} from './scoped-folder-traversal-journal';

export const DIRECT_FOLDER_CAPTURE_PLAN_SCHEMA =
  'dnaforge.benchling.direct-folder-capture-plan.v1' as const;
export const DIRECT_FOLDER_EXPORT_AUTHORITY_SCHEMA =
  'dnaforge.benchling.direct-folder-export-authority.v1' as const;
export const DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY =
  'benchling.notebook-entry-html-export.v1' as const;
export const DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY =
  'benchling.sequence-single-file-export.v1' as const;

const SHA256_REF = /^sha256:[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const NOTEBOOK_ENTRY_EXPORT_ID = /^(?:etr|entry)_[A-Za-z0-9]+$/u;
const SEQUENCE_EXPORT_ID = /^seq_[A-Za-z0-9]+$/u;

export type DirectFolderCaptureContentFamily =
  | 'dna_rna'
  | 'notebook'
  | 'protocol'
  | 'registry'
  | 'protein'
  | 'attachment'
  | 'generic';

export type DirectFolderCapturePlanBlockerCode =
  | 'archived_item_unproven'
  | 'unknown_item_type'
  | 'unproven_item_request';

export type DirectFolderCaptureRequestCapability =
  | {
      state: 'ready';
      id:
        | typeof DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY
        | typeof DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY;
      method: 'POST';
      path: '/1/api/exports/';
      body: { file: string };
    }
  | {
      state: 'blocked';
      code: DirectFolderCapturePlanBlockerCode;
    };

export type DirectFolderCapturePlanItem = {
  sourceId: string;
  sourceUrl?: string;
  sourceType: ScopedFolderTraversalItem['type'];
  contentFamily: DirectFolderCaptureContentFamily | null;
  sourceFolderIds: [string];
  archived: boolean;
  requestCapability: DirectFolderCaptureRequestCapability;
};

export type DirectFolderCapturePlanBlocker = {
  code: DirectFolderCapturePlanBlockerCode;
  sourceId: string;
  sourceType: ScopedFolderTraversalItem['type'];
};

export type DirectFolderCapturePlanV1 = {
  schema: typeof DIRECT_FOLDER_CAPTURE_PLAN_SCHEMA;
  runId: string;
  sourceAccountHash: string;
  selectedRootId: string;
  includeArchived?: boolean;
  traversalJournalDigest: string;
  capturedAt: string;
  items: DirectFolderCapturePlanItem[];
  blockers: DirectFolderCapturePlanBlocker[];
  startAllowed: boolean;
  planDigest: string;
};

export type DirectFolderInitialExportJobIdentity = {
  authority: DirectFolderExportAuthority;
  id: string;
  matchSignature: string;
};

export class DirectFolderCapturePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectFolderCapturePlanError';
  }
}

export async function buildDirectFolderCapturePlan(input: {
  runId: string;
  scope: Extract<MigrationScope, { kind: 'folder' }>;
  sourceAccountHash: string;
  capturedAt: string;
  journal: ScopedFolderTraversalJournal | unknown;
}): Promise<DirectFolderCapturePlanV1> {
  const runId = requireOpaqueId(input.runId, 'run ID');
  const sourceAccountHash = requireSha256Ref(input.sourceAccountHash, 'source account hash');
  const selectedRootId = requireFolderId(input.scope.folder.id, 'selected root ID');
  if (input.scope.includeChildren !== false) {
    throw new DirectFolderCapturePlanError('Direct Folder capture must exclude child folders.');
  }
  const capturedAt = requireTimestamp(input.capturedAt, 'capture time');
  const includeArchived = input.scope.includeArchived === true;
  const { traversalJournalDigest, items, blockers } = deriveDirectFolderInventory(
    input.journal,
    selectedRootId,
    { includeArchived }
  );
  const planWithoutDigest = {
    schema: DIRECT_FOLDER_CAPTURE_PLAN_SCHEMA,
    runId,
    sourceAccountHash,
    selectedRootId,
    includeArchived,
    traversalJournalDigest,
    capturedAt,
    items,
    blockers,
    startAllowed: true,
  } satisfies Omit<DirectFolderCapturePlanV1, 'planDigest'>;
  return immutable({
    ...planWithoutDigest,
    planDigest: directFolderCapturePlanDigest(planWithoutDigest),
  });
}

export function validateDirectFolderCapturePlan(
  value: DirectFolderCapturePlanV1 | unknown
): DirectFolderCapturePlanV1 {
  const record = requireRecord(value, 'capture plan');
  requireExactKeys(
    record,
    [
      'schema',
      'runId',
      'sourceAccountHash',
      'selectedRootId',
      ...(record.includeArchived === undefined ? [] : ['includeArchived']),
      'traversalJournalDigest',
      'capturedAt',
      'items',
      'blockers',
      'startAllowed',
      'planDigest',
    ],
    'capture plan'
  );
  if (record.schema !== DIRECT_FOLDER_CAPTURE_PLAN_SCHEMA) {
    throw new DirectFolderCapturePlanError('Direct Folder capture plan schema is unsupported.');
  }
  const runId = requireOpaqueId(record.runId, 'run ID');
  const sourceAccountHash = requireSha256Ref(record.sourceAccountHash, 'source account hash');
  const selectedRootId = requireFolderId(record.selectedRootId, 'selected root ID');
  const includeArchived =
    record.includeArchived === undefined
      ? undefined
      : requireBoolean(record.includeArchived, 'include-archived authority');
  const traversalJournalDigest = requireSha256Ref(
    record.traversalJournalDigest,
    'traversal journal digest'
  );
  const capturedAt = requireTimestamp(record.capturedAt, 'capture time');
  if (!Array.isArray(record.items) || !Array.isArray(record.blockers)) {
    throw new DirectFolderCapturePlanError('Direct Folder capture plan arrays are invalid.');
  }
  const items = record.items.map((item, index) =>
    normalizePlanItem(item, index, selectedRootId, includeArchived === true)
  );
  requireCanonicalUniqueIds(
    items.map((item) => item.sourceId),
    'capture-plan item'
  );
  const itemsBySourceId = new Map(items.map((item) => [item.sourceId, item] as const));
  const blockers = record.blockers.map((blocker, index) =>
    normalizeBlocker(blocker, index, itemsBySourceId)
  );
  requireCanonicalUniqueIds(
    blockers.map((blocker) => blocker.sourceId),
    'capture-plan blocker'
  );
  const expectedBlockers = items
    .filter(
      (
        item
      ): item is DirectFolderCapturePlanItem & {
        requestCapability: Extract<DirectFolderCaptureRequestCapability, { state: 'blocked' }>;
      } => item.requestCapability.state === 'blocked'
    )
    .map((item) => ({
      code: item.requestCapability.code,
      sourceId: item.sourceId,
      sourceType: item.sourceType,
    }));
  if (canonicalJson(blockers) !== canonicalJson(expectedBlockers)) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture plan blockers do not match its item capabilities.'
    );
  }
  const startAllowed = record.startAllowed;
  if (typeof startAllowed !== 'boolean' || (!startAllowed && blockers.length === 0)) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture plan start authority contradicts its blockers.'
    );
  }
  const normalizedWithoutDigest = {
    schema: DIRECT_FOLDER_CAPTURE_PLAN_SCHEMA,
    runId,
    sourceAccountHash,
    selectedRootId,
    ...(includeArchived === undefined ? {} : { includeArchived }),
    traversalJournalDigest,
    capturedAt,
    items,
    blockers,
    startAllowed,
  } satisfies Omit<DirectFolderCapturePlanV1, 'planDigest'>;
  const planDigest = requireSha256Ref(record.planDigest, 'plan digest');
  if (planDigest !== directFolderCapturePlanDigest(normalizedWithoutDigest)) {
    throw new DirectFolderCapturePlanError('Direct Folder capture plan digest is invalid.');
  }
  return immutable({ ...normalizedWithoutDigest, planDigest });
}

export function assertDirectFolderCapturePlanMatchesJournal(
  value: DirectFolderCapturePlanV1 | unknown,
  journal: ScopedFolderTraversalJournal | unknown
): DirectFolderCapturePlanV1 {
  const plan = validateDirectFolderCapturePlan(value);
  const legacyUrlFreeReadySourceIds = new Set(
    plan.items
      .filter((item) => item.sourceUrl === undefined && item.requestCapability.state === 'ready')
      .map((item) => item.sourceId)
  );
  const derived = deriveDirectFolderInventory(journal, plan.selectedRootId, {
    includeArchived: plan.includeArchived === true,
    preserveLegacyBlockedSequences: planUsesLegacyBlockedSequenceAuthority(plan),
    legacyUrlFreeReadySourceIds,
  });
  if (
    plan.traversalJournalDigest !== derived.traversalJournalDigest ||
    canonicalJson(plan.items) !== canonicalJson(derived.items) ||
    canonicalJson(plan.blockers) !== canonicalJson(derived.blockers) ||
    (!plan.startAllowed && derived.blockers.length === 0)
  ) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture plan does not match the terminal traversal journal inventory.'
    );
  }
  return plan;
}

export function directFolderTraversalJournalDigest(
  journal: ScopedFolderTraversalJournal | unknown
): string {
  const normalized = validateAndNormalizeDurableScopedFolderTraversalJournal(journal);
  return `sha256:${createHash('sha256')
    .update(canonicalScopedFolderTraversalJson(normalized))
    .digest('hex')}`;
}

export function directFolderProviderPreflightFromPlan(input: {
  scope: Extract<MigrationScope, { kind: 'folder' }>;
  plan: DirectFolderCapturePlanV1 | unknown;
  base: MigrationCapturePreflight;
}): MigrationCapturePreflight {
  const plan = validateDirectFolderCapturePlan(input.plan);
  const selectedRootId = input.scope.folder.id;
  if (plan.selectedRootId !== selectedRootId) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture plan belongs to a different selected root.'
    );
  }
  if ((plan.includeArchived === true) !== (input.scope.includeArchived === true)) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture plan has different archived-item authority.'
    );
  }
  if (!plan.startAllowed) {
    return {
      ...structuredClone(input.base),
      plannedContentFamilies: [],
      exportJobs: [],
      plannedActions: [],
      compressedArchiveBytes: 0,
      declaredUncompressedBytes: 0,
      projectedObjectBytes: 0,
      largestTemporaryBytes: 0,
    };
  }
  const exportJobs = plan.items
    .filter(
      (
        item
      ): item is DirectFolderCapturePlanItem & {
        contentFamily: DirectFolderCaptureContentFamily;
        requestCapability: Extract<DirectFolderCaptureRequestCapability, { state: 'ready' }>;
      } => item.requestCapability.state === 'ready' && item.contentFamily !== null
    )
    .map((item) => {
      if (item.sourceId === selectedRootId) {
        throw new DirectFolderCapturePlanError(
          `Direct Folder item ${item.sourceId} is not runnable under its capture plan.`
        );
      }
      if (item.sourceUrl === undefined) {
        throw new DirectFolderCapturePlanError(
          `Direct Folder item ${item.sourceId} has legacy URL-free authority; start a new URL-authorized discovery run.`
        );
      }
      const sourceItemUrl = canonicalBenchlingItemUrl(
        item.sourceUrl,
        item.sourceId,
        benchlingOrganizationBaseUrlFromSourceUrl(input.scope.folder.url)
      );
      const authority = exportAuthority(plan, item);
      const identity = directFolderInitialExportJobIdentityForValidatedPlan(plan, authority);
      return {
        id: identity.id,
        contentFamily: item.contentFamily,
        sourceRoots: [
          {
            id: item.sourceId,
            url: sourceItemUrl,
            objectType: item.sourceType,
          } satisfies BenchlingSourceRef,
        ],
        matchSignature: identity.matchSignature,
        directFolderAuthority: authority,
      };
    });
  const itemIds = exportJobs.map((job) => job.sourceRoots[0].id);
  const plannedActions: MigrationNetworkAction[] = [
    ...exportJobs.map((job) => ({
      id: `action-submit-${job.id}`,
      kind: 'export_submit' as const,
      description: `Primary: submit one ${job.contentFamily} export for direct item ${job.sourceRoots[0].id}; never submit Folder ${selectedRootId}.`,
      sourceIds: [job.sourceRoots[0].id],
    })),
    ...(exportJobs.length === 0
      ? []
      : [
          {
            id: `action-task-poll-${plan.planDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`,
            kind: 'gmail_poll' as const,
            description: `Check only the exact export tasks and the confirmed Gmail mailbox for these serialized selected items (${itemIds.join(', ')}). A Gmail receipt requires explicit item confirmation; each durable provider operation permits at most three provider attempts.`,
            sourceIds: itemIds,
          },
        ]),
    ...exportJobs.map((job) => ({
      id: `action-download-${job.id}`,
      kind: 'export_download' as const,
      description: `Primary: inspect and download only the explicitly confirmed receipt bound to direct item ${job.sourceRoots[0].id}.`,
      sourceIds: [job.sourceRoots[0].id],
    })),
    ...(exportJobs.length === 0
      ? []
      : [
          {
            id: `action-one-hop-${plan.planDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`,
            kind: 'targeted_read' as const,
            description:
              'Bounded contingency: read only deduplicated missing outbound targets at maximum depth one; never discover inbound or second-hop references.',
            sourceIds: itemIds,
          },
        ]),
  ];
  return {
    ...structuredClone(input.base),
    plannedContentFamilies: [...new Set(exportJobs.map((job) => job.contentFamily))].sort(),
    exportJobs,
    plannedActions,
    compressedArchiveBytes: exportJobs.length === 0 ? 0 : null,
    declaredUncompressedBytes: exportJobs.length === 0 ? 0 : null,
    projectedObjectBytes: exportJobs.length === 0 ? 0 : null,
    largestTemporaryBytes: exportJobs.length === 0 ? 0 : null,
  };
}

export function directFolderInitialExportJobIdentity(input: {
  plan: DirectFolderCapturePlanV1 | unknown;
  authority: DirectFolderExportAuthority | unknown;
}): { id: string; matchSignature: string } {
  const authorityRecord = requireRecord(input.authority, 'export authority');
  requireExactKeys(
    authorityRecord,
    [
      'schema',
      'capturePlanDigest',
      'traversalJournalDigest',
      'selectedRootId',
      'sourceItemId',
      'sourceItemUrl',
      'sourceItemType',
      'sourceFolderIds',
      'requestCapabilityId',
    ],
    'export authority'
  );
  const sourceItemId = requireOpaqueId(authorityRecord.sourceItemId, 'authority source item ID');
  const identity = directFolderInitialExportJobIdentityIndex(input.plan).get(sourceItemId);
  if (!identity) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder export authority item ${sourceItemId} is not runnable.`
    );
  }
  if (canonicalJson(authorityRecord) !== canonicalJson(identity.authority)) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder export authority item ${sourceItemId} conflicts with its capture plan.`
    );
  }
  return { id: identity.id, matchSignature: identity.matchSignature };
}

export function directFolderInitialExportJobIdentityIndex(
  value: DirectFolderCapturePlanV1 | unknown
): ReadonlyMap<string, DirectFolderInitialExportJobIdentity> {
  const plan = validateDirectFolderCapturePlan(value);
  const identities = new Map<string, DirectFolderInitialExportJobIdentity>();
  for (const item of plan.items) {
    if (item.contentFamily === null || item.requestCapability.state !== 'ready') continue;
    const authority = immutable(
      exportAuthority(plan, {
        ...item,
        contentFamily: item.contentFamily,
        requestCapability: item.requestCapability,
      })
    );
    const identity = directFolderInitialExportJobIdentityForValidatedPlan(plan, authority);
    identities.set(
      item.sourceId,
      immutable({
        authority,
        id: identity.id,
        matchSignature: identity.matchSignature,
      })
    );
  }
  return identities;
}

function directFolderInitialExportJobIdentityForValidatedPlan(
  plan: DirectFolderCapturePlanV1,
  authority: DirectFolderExportAuthority
): { id: string; matchSignature: string } {
  const signatureDigest = hashCanonical({
    schema: DIRECT_FOLDER_EXPORT_AUTHORITY_SCHEMA,
    planDigest: plan.planDigest,
    authority,
  });
  return {
    id: `direct_item_export_${signatureDigest.slice(0, 24)}`,
    matchSignature: `benchling-direct-item-export:v1:${signatureDigest}`,
  };
}

function planItem(
  item: {
    id: string;
    type: ScopedFolderTraversalItem['type'];
    archived: boolean;
    sourceFolderIds: string[];
    sourceUrl?: string;
  },
  selectedRootId: string,
  includeArchived: boolean
): DirectFolderCapturePlanItem {
  if (
    item.sourceFolderIds.length !== 1 ||
    item.sourceFolderIds[0] !== selectedRootId ||
    item.id === selectedRootId
  ) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder item ${item.id} is not an exact direct member of ${selectedRootId}.`
    );
  }
  const contentFamily = contentFamilyForType(item.type);
  const requestCapability: DirectFolderCaptureRequestCapability =
    item.archived && !includeArchived
      ? { state: 'blocked', code: 'archived_item_unproven' }
      : item.type === 'unknown'
        ? { state: 'blocked', code: 'unknown_item_type' }
        : item.sourceUrl === undefined
          ? { state: 'blocked', code: 'unproven_item_request' }
          : item.type === 'entry' && NOTEBOOK_ENTRY_EXPORT_ID.test(item.id)
            ? {
                state: 'ready',
                id: DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY,
                method: 'POST',
                path: '/1/api/exports/',
                body: { file: item.id },
              }
            : item.type === 'sequence' && SEQUENCE_EXPORT_ID.test(item.id)
              ? {
                  state: 'ready',
                  id: DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY,
                  method: 'POST',
                  path: '/1/api/exports/',
                  body: { file: item.id },
                }
              : { state: 'blocked', code: 'unproven_item_request' };
  return {
    sourceId: item.id,
    ...(item.sourceUrl === undefined ? {} : { sourceUrl: item.sourceUrl }),
    sourceType: item.type,
    contentFamily,
    sourceFolderIds: [selectedRootId],
    archived: item.archived,
    requestCapability,
  };
}

function deriveDirectFolderInventory(
  rawJournal: ScopedFolderTraversalJournal | unknown,
  selectedRootId: string,
  options: {
    includeArchived?: boolean;
    preserveLegacyBlockedSequences?: boolean;
    legacyUrlFreeReadySourceIds?: ReadonlySet<string>;
  } = {}
): {
  traversalJournalDigest: string;
  items: DirectFolderCapturePlanItem[];
  blockers: DirectFolderCapturePlanBlocker[];
} {
  const journal = validateAndNormalizeDurableScopedFolderTraversalJournal(rawJournal);
  const includeArchived = options.includeArchived ?? journal.includeArchived === true;
  if (
    journal.scopeKind !== 'folder' ||
    journal.selectedRootIds.length !== 1 ||
    journal.selectedRootIds[0] !== selectedRootId
  ) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture journal does not match the immutable selected root.'
    );
  }
  if ((journal.includeArchived === true) !== includeArchived) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture journal has different archived-item authority.'
    );
  }
  const replay = replayScopedFolderTraversalJournalSync(journal);
  if (!replay.terminal || !replay.terminalEvidence) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture requires a terminal traversal journal.'
    );
  }
  if (
    replay.terminalEvidence.folderFacts.some((fact) => fact.id !== selectedRootId && fact.included)
  ) {
    throw new DirectFolderCapturePlanError(
      'Direct Folder capture journal included a descendant folder.'
    );
  }
  const items = replay.terminalEvidence.selectedItems.map((item) => {
    const planned = planItem(item, selectedRootId, includeArchived);
    if (
      planned.sourceUrl === undefined &&
      planned.requestCapability.state === 'blocked' &&
      planned.requestCapability.code === 'unproven_item_request' &&
      options.legacyUrlFreeReadySourceIds?.has(planned.sourceId)
    ) {
      if (planned.sourceType === 'entry' && NOTEBOOK_ENTRY_EXPORT_ID.test(planned.sourceId)) {
        return {
          ...planned,
          requestCapability: {
            state: 'ready',
            id: DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY,
            method: 'POST',
            path: '/1/api/exports/',
            body: { file: planned.sourceId },
          } as const,
        };
      }
      if (planned.sourceType === 'sequence' && SEQUENCE_EXPORT_ID.test(planned.sourceId)) {
        return {
          ...planned,
          requestCapability: {
            state: 'ready',
            id: DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY,
            method: 'POST',
            path: '/1/api/exports/',
            body: { file: planned.sourceId },
          } as const,
        };
      }
    }
    if (
      options.preserveLegacyBlockedSequences === true &&
      planned.sourceType === 'sequence' &&
      planned.requestCapability.state === 'ready' &&
      planned.requestCapability.id === DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY
    ) {
      return {
        ...planned,
        requestCapability: {
          state: 'blocked',
          code: 'unproven_item_request',
        } as const,
      };
    }
    return planned;
  });
  return {
    traversalJournalDigest: `sha256:${replay.journalDigest}`,
    items,
    blockers: blockersForItems(items),
  };
}

function blockersForItems(items: DirectFolderCapturePlanItem[]): DirectFolderCapturePlanBlocker[] {
  return items
    .filter(
      (
        item
      ): item is DirectFolderCapturePlanItem & {
        requestCapability: Extract<DirectFolderCaptureRequestCapability, { state: 'blocked' }>;
      } => item.requestCapability.state === 'blocked'
    )
    .map((item) => ({
      code: item.requestCapability.code,
      sourceId: item.sourceId,
      sourceType: item.sourceType,
    }));
}

function contentFamilyForType(
  type: ScopedFolderTraversalItem['type']
): DirectFolderCaptureContentFamily | null {
  switch (type) {
    case 'aa_sequence':
    case 'protein':
      return 'protein';
    case 'bulk_assembly':
    case 'dna_sequence':
    case 'oligo':
    case 'rna_oligo':
    case 'rna_sequence':
    case 'sequence':
      return 'dna_rna';
    case 'entry':
      return 'notebook';
    case 'entity':
    case 'registry_entity':
      return 'registry';
    case 'file':
      return 'attachment';
    case 'protocol':
      return 'protocol';
    case 'basic_folder_item':
    case 'folder':
    case 'mixture':
    case 'pipeline_file':
    case 'source':
      return 'generic';
    case 'unknown':
      return null;
    default:
      return assertNever(type);
  }
}

function exportAuthority(
  plan: DirectFolderCapturePlanV1,
  item: DirectFolderCapturePlanItem & {
    contentFamily: DirectFolderCaptureContentFamily;
    requestCapability: Extract<DirectFolderCaptureRequestCapability, { state: 'ready' }>;
  }
): DirectFolderExportAuthority {
  const base = {
    schema: DIRECT_FOLDER_EXPORT_AUTHORITY_SCHEMA,
    capturePlanDigest: plan.planDigest,
    traversalJournalDigest: plan.traversalJournalDigest,
    selectedRootId: plan.selectedRootId,
    sourceItemId: item.sourceId,
    sourceItemUrl: requireObservedItemUrl(item.sourceUrl, item.sourceId),
    sourceFolderIds: [plan.selectedRootId] as [string],
  };
  if (
    item.sourceType === 'entry' &&
    item.requestCapability.id === DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY
  ) {
    return {
      ...base,
      sourceItemType: 'entry',
      requestCapabilityId: DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY,
    };
  }
  if (
    item.sourceType === 'sequence' &&
    item.requestCapability.id === DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY
  ) {
    return {
      ...base,
      sourceItemType: 'sequence',
      requestCapabilityId: DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY,
    };
  }
  throw new DirectFolderCapturePlanError(
    `Direct Folder item ${item.sourceId} has mismatched ready export authority.`
  );
}

function normalizePlanItem(
  value: unknown,
  index: number,
  selectedRootId: string,
  includeArchived: boolean
): DirectFolderCapturePlanItem {
  const record = requireRecord(value, `item ${index}`);
  requireExactKeys(
    record,
    [
      'sourceId',
      ...(record.sourceUrl === undefined ? [] : ['sourceUrl']),
      'sourceType',
      'contentFamily',
      'sourceFolderIds',
      'archived',
      'requestCapability',
    ],
    `item ${index}`
  );
  const sourceId = requireOpaqueId(record.sourceId, `item ${index} source ID`);
  if (sourceId === selectedRootId) {
    throw new DirectFolderCapturePlanError('A Direct Folder item cannot be the Folder root.');
  }
  const sourceType = requireSourceType(record.sourceType, `item ${sourceId} source type`);
  const sourceUrl =
    record.sourceUrl === undefined ? undefined : requireObservedItemUrl(record.sourceUrl, sourceId);
  const expectedFamily = contentFamilyForType(sourceType);
  if (record.contentFamily !== expectedFamily) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder item ${sourceId} has a conflicting content family.`
    );
  }
  if (
    !Array.isArray(record.sourceFolderIds) ||
    record.sourceFolderIds.length !== 1 ||
    record.sourceFolderIds[0] !== selectedRootId
  ) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder item ${sourceId} has invalid root membership.`
    );
  }
  if (typeof record.archived !== 'boolean') {
    throw new DirectFolderCapturePlanError(
      `Direct Folder item ${sourceId} archive state is invalid.`
    );
  }
  const requestCapability = normalizeRequestCapability(
    record.requestCapability,
    sourceId,
    sourceType,
    record.archived,
    includeArchived
  );
  return {
    sourceId,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    sourceType,
    contentFamily: expectedFamily,
    sourceFolderIds: [selectedRootId],
    archived: record.archived,
    requestCapability,
  };
}

function requireObservedItemUrl(value: unknown, sourceItemId: string): string {
  try {
    return requireCanonicalBenchlingItemUrl(value, sourceItemId);
  } catch {
    throw new DirectFolderCapturePlanError(
      `Direct Folder item ${sourceItemId} has no exact canonical observed URL; start a new URL-authorized discovery run.`
    );
  }
}

function normalizeRequestCapability(
  value: unknown,
  sourceId: string,
  sourceType: ScopedFolderTraversalItem['type'],
  archived: boolean,
  includeArchived: boolean
): DirectFolderCaptureRequestCapability {
  const record = requireRecord(value, `item ${sourceId} request capability`);
  if (record.state === 'ready') {
    requireExactKeys(record, ['state', 'id', 'method', 'path', 'body'], 'ready request capability');
    const body = requireRecord(record.body, 'ready request capability body');
    requireExactKeys(body, ['file'], 'ready request capability body');
    const exactNotebookAuthority =
      sourceType === 'entry' &&
      NOTEBOOK_ENTRY_EXPORT_ID.test(sourceId) &&
      record.id === DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY;
    const exactSequenceAuthority =
      sourceType === 'sequence' &&
      SEQUENCE_EXPORT_ID.test(sourceId) &&
      record.id === DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY;
    if (
      (archived && !includeArchived) ||
      (!exactNotebookAuthority && !exactSequenceAuthority) ||
      record.method !== 'POST' ||
      record.path !== '/1/api/exports/' ||
      body.file !== sourceId
    ) {
      throw new DirectFolderCapturePlanError(
        `Direct Folder item ${sourceId} has invalid ready request authority.`
      );
    }
    return {
      state: 'ready',
      id: exactNotebookAuthority
        ? DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY
        : DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY,
      method: 'POST',
      path: '/1/api/exports/',
      body: { file: sourceId },
    };
  }
  requireExactKeys(record, ['state', 'code'], 'blocked request capability');
  const expectedCode: DirectFolderCapturePlanBlockerCode =
    archived && !includeArchived
      ? 'archived_item_unproven'
      : sourceType === 'unknown'
        ? 'unknown_item_type'
        : 'unproven_item_request';
  if (record.state !== 'blocked' || record.code !== expectedCode) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder item ${sourceId} has invalid blocked request authority.`
    );
  }
  return { state: 'blocked', code: expectedCode };
}

function planUsesLegacyBlockedSequenceAuthority(plan: DirectFolderCapturePlanV1): boolean {
  const eligibleSequences = plan.items.filter(
    (item) =>
      !item.archived && item.sourceType === 'sequence' && SEQUENCE_EXPORT_ID.test(item.sourceId)
  );
  return (
    eligibleSequences.length > 0 &&
    eligibleSequences.every(
      (item) =>
        item.requestCapability.state === 'blocked' &&
        item.requestCapability.code === 'unproven_item_request'
    )
  );
}

function normalizeBlocker(
  value: unknown,
  index: number,
  itemsBySourceId: ReadonlyMap<string, DirectFolderCapturePlanItem>
): DirectFolderCapturePlanBlocker {
  const record = requireRecord(value, `blocker ${index}`);
  requireExactKeys(record, ['code', 'sourceId', 'sourceType'], `blocker ${index}`);
  const sourceId = requireOpaqueId(record.sourceId, `blocker ${index} source ID`);
  const item = itemsBySourceId.get(sourceId);
  if (
    !item ||
    item.requestCapability.state !== 'blocked' ||
    record.code !== item.requestCapability.code ||
    record.sourceType !== item.sourceType
  ) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder blocker ${sourceId} does not match a blocked item.`
    );
  }
  return {
    code: item.requestCapability.code,
    sourceId,
    sourceType: item.sourceType,
  };
}

function directFolderCapturePlanDigest(
  value: Omit<DirectFolderCapturePlanV1, 'planDigest'>
): string {
  return `sha256:${hashCanonical(value)}`;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DirectFolderCapturePlanError(`Direct Folder ${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder ${label} fields are invalid (${actual.join(', ')}).`
    );
  }
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new DirectFolderCapturePlanError(`Direct Folder ${label} is invalid.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DirectFolderCapturePlanError(`Direct Folder ${label} is invalid.`);
  }
  return value;
}

function requireFolderId(value: unknown, label: string): string {
  const id = requireOpaqueId(value, label);
  if (!/^(?:fld|lib|src)_[A-Za-z0-9]+$/u.test(id)) {
    throw new DirectFolderCapturePlanError(`Direct Folder ${label} is not a stable folder ID.`);
  }
  return id;
}

function requireSha256Ref(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_REF.test(value)) {
    throw new DirectFolderCapturePlanError(`Direct Folder ${label} is invalid.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new DirectFolderCapturePlanError(`Direct Folder ${label} is invalid.`);
  }
  return value;
}

function requireSourceType(value: unknown, label: string): ScopedFolderTraversalItem['type'] {
  if (
    typeof value !== 'string' ||
    (value !== 'unknown' &&
      !SCOPED_FOLDER_SEARCH_TYPES.includes(value as (typeof SCOPED_FOLDER_SEARCH_TYPES)[number]))
  ) {
    throw new DirectFolderCapturePlanError(`Direct Folder ${label} is invalid.`);
  }
  return value as ScopedFolderTraversalItem['type'];
}

function requireCanonicalUniqueIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...ids].sort())) {
    throw new DirectFolderCapturePlanError(
      `Direct Folder ${label} IDs are duplicated or non-canonical.`
    );
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

function assertNever(value: never): never {
  throw new DirectFolderCapturePlanError(`Unsupported Direct Folder item type ${String(value)}.`);
}
