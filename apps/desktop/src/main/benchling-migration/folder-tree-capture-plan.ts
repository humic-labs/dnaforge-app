import { createHash } from 'node:crypto';

import type {
  BenchlingSourceRef,
  FolderTreeExportAuthority,
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
  type ScopedFolderTraversalFolderFact,
  type ScopedFolderTraversalJournal,
  type ScopedFolderTraversalItem,
} from './scoped-folder-traversal-journal';

export const FOLDER_TREE_CAPTURE_PLAN_SCHEMA =
  'dnaforge.benchling.folder-tree-capture-plan.v1' as const;
export const FOLDER_TREE_EXPORT_AUTHORITY_SCHEMA =
  'dnaforge.benchling.folder-tree-export-authority.v1' as const;
export const FOLDER_TREE_NOTEBOOK_EXPORT_CAPABILITY =
  'benchling.notebook-entry-html-export.v1' as const;
export const FOLDER_TREE_SEQUENCE_EXPORT_CAPABILITY =
  'benchling.sequence-single-file-export.v1' as const;

const SHA256_REF = /^sha256:[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const FOLDER_ID = /^(?:fld|lib|src)_[A-Za-z0-9]+$/u;
const NOTEBOOK_ENTRY_ID = /^(?:etr|entry)_[A-Za-z0-9]+$/u;
const SEQUENCE_ID = /^seq_[A-Za-z0-9]+$/u;

export type FolderTreePlanBlockerCode =
  | 'archived_item_unproven'
  | 'unknown_item_type'
  | 'unproven_item_request';

export type FolderTreePlanItem = {
  sourceId: string;
  sourceUrl?: string;
  sourceType: ScopedFolderTraversalItem['type'];
  sourceFolderIds: string[];
  archived: boolean;
  requestCapability:
    | {
        state: 'ready';
        id:
          | typeof FOLDER_TREE_NOTEBOOK_EXPORT_CAPABILITY
          | typeof FOLDER_TREE_SEQUENCE_EXPORT_CAPABILITY;
        method: 'POST';
        path: '/1/api/exports/';
        body: { file: string };
      }
    | { state: 'blocked'; code: FolderTreePlanBlockerCode };
};

export type FolderTreeCapturePlanV1 = {
  schema: typeof FOLDER_TREE_CAPTURE_PLAN_SCHEMA;
  runId: string;
  sourceAccountHash: string;
  selectedRootId: string;
  includeArchived?: boolean;
  includedFolderIds: string[];
  excludedFolderIds: string[];
  includedNotebookSourceIds: string[];
  maximumFolderDepth: number;
  traversalJournalDigest: string;
  capturedAt: string;
  items: FolderTreePlanItem[];
  blockers: Array<{
    code: FolderTreePlanBlockerCode;
    sourceId: string;
    sourceType: ScopedFolderTraversalItem['type'];
  }>;
  startAllowed: boolean;
  planDigest: string;
};

export type FolderTreeInitialExportJobIdentity = {
  authority: FolderTreeExportAuthority;
  id: string;
  matchSignature: string;
};

export class FolderTreeCapturePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderTreeCapturePlanError';
  }
}

export async function buildFolderTreeCapturePlan(input: {
  runId: string;
  scope: Extract<MigrationScope, { kind: 'folder_tree' }>;
  sourceAccountHash: string;
  capturedAt: string;
  journal: ScopedFolderTraversalJournal | unknown;
}): Promise<FolderTreeCapturePlanV1> {
  if (input.scope.includeChildren !== true || input.scope.roots.length !== 1) {
    throw new FolderTreeCapturePlanError(
      'The live Folder Tree capture plan requires one exact recursive selected root.'
    );
  }
  const selectedRootId = requireFolderId(input.scope.roots[0]?.id, 'selected root ID');
  const includeArchived = input.scope.includeArchived === true;
  const derived = deriveTreeInventory(input.journal, selectedRootId, { includeArchived });
  const withoutDigest = {
    schema: FOLDER_TREE_CAPTURE_PLAN_SCHEMA,
    runId: requireOpaqueId(input.runId, 'run ID'),
    sourceAccountHash: requireSha256(input.sourceAccountHash, 'source account hash'),
    selectedRootId,
    includeArchived,
    includedFolderIds: derived.includedFolderIds,
    excludedFolderIds: derived.excludedFolderIds,
    includedNotebookSourceIds: derived.includedNotebookSourceIds,
    maximumFolderDepth: derived.maximumFolderDepth,
    traversalJournalDigest: derived.traversalJournalDigest,
    capturedAt: requireTimestamp(input.capturedAt, 'capture time'),
    items: derived.items,
    blockers: derived.blockers,
    startAllowed: true,
  } satisfies Omit<FolderTreeCapturePlanV1, 'planDigest'>;
  return immutable({ ...withoutDigest, planDigest: planDigest(withoutDigest) });
}

export function validateFolderTreeCapturePlan(value: unknown): FolderTreeCapturePlanV1 {
  const record = requireRecord(value, 'Folder Tree capture plan');
  exactKeys(record, [
    'schema',
    'runId',
    'sourceAccountHash',
    'selectedRootId',
    ...(record.includeArchived === undefined ? [] : ['includeArchived']),
    'includedFolderIds',
    'excludedFolderIds',
    'includedNotebookSourceIds',
    'maximumFolderDepth',
    'traversalJournalDigest',
    'capturedAt',
    'items',
    'blockers',
    'startAllowed',
    'planDigest',
  ]);
  if (record.schema !== FOLDER_TREE_CAPTURE_PLAN_SCHEMA) {
    throw new FolderTreeCapturePlanError('Folder Tree capture plan schema is unsupported.');
  }
  const selectedRootId = requireFolderId(record.selectedRootId, 'selected root ID');
  const includeArchived =
    record.includeArchived === undefined
      ? undefined
      : requireBoolean(record.includeArchived, 'include-archived authority');
  const includedFolderIds = folderIdArray(record.includedFolderIds, 'included folders');
  const excludedFolderIds = folderIdArray(record.excludedFolderIds, 'excluded folders');
  if (!includedFolderIds.includes(selectedRootId)) {
    throw new FolderTreeCapturePlanError('Folder Tree plan omitted its selected root.');
  }
  if (excludedFolderIds.some((id) => includedFolderIds.includes(id))) {
    throw new FolderTreeCapturePlanError('Folder Tree plan included an excluded folder.');
  }
  if (!Array.isArray(record.items)) {
    throw new FolderTreeCapturePlanError('Folder Tree plan items are invalid.');
  }
  const items = record.items.map((item, index) =>
    normalizeItem(item, index, includedFolderIds, includeArchived === true)
  );
  uniqueCanonical(
    items.map(({ sourceId }) => sourceId),
    'item'
  );
  const readyIds = items
    .filter(({ requestCapability }) => requestCapability.state === 'ready')
    .map(({ sourceId }) => sourceId);
  const includedNotebookSourceIds = opaqueIdArray(
    record.includedNotebookSourceIds,
    'included notebook source IDs'
  );
  if (canonical(includedNotebookSourceIds) !== canonical(readyIds)) {
    throw new FolderTreeCapturePlanError('Folder Tree notebook IDs contradict item authority.');
  }
  const blockers = normalizeBlockers(record.blockers, items);
  const expectedBlockers = items
    .filter(
      (
        item
      ): item is FolderTreePlanItem & {
        requestCapability: Extract<FolderTreePlanItem['requestCapability'], { state: 'blocked' }>;
      } => item.requestCapability.state === 'blocked'
    )
    .map((item) => ({
      code: item.requestCapability.code,
      sourceId: item.sourceId,
      sourceType: item.sourceType,
    }));
  if (canonical(blockers) !== canonical(expectedBlockers)) {
    throw new FolderTreeCapturePlanError('Folder Tree blockers contradict item authority.');
  }
  const maximumFolderDepth = requireInteger(record.maximumFolderDepth, 'maximum folder depth');
  if (typeof record.startAllowed !== 'boolean' || (!record.startAllowed && blockers.length === 0)) {
    throw new FolderTreeCapturePlanError('Folder Tree start authority contradicts blockers.');
  }
  const withoutDigest = {
    schema: FOLDER_TREE_CAPTURE_PLAN_SCHEMA,
    runId: requireOpaqueId(record.runId, 'run ID'),
    sourceAccountHash: requireSha256(record.sourceAccountHash, 'source account hash'),
    selectedRootId,
    ...(includeArchived === undefined ? {} : { includeArchived }),
    includedFolderIds,
    excludedFolderIds,
    includedNotebookSourceIds,
    maximumFolderDepth,
    traversalJournalDigest: requireSha256(record.traversalJournalDigest, 'journal digest'),
    capturedAt: requireTimestamp(record.capturedAt, 'capture time'),
    items,
    blockers,
    startAllowed: record.startAllowed,
  } satisfies Omit<FolderTreeCapturePlanV1, 'planDigest'>;
  const digest = requireSha256(record.planDigest, 'plan digest');
  if (digest !== planDigest(withoutDigest)) {
    throw new FolderTreeCapturePlanError('Folder Tree capture plan digest is invalid.');
  }
  return immutable({ ...withoutDigest, planDigest: digest });
}

export function assertFolderTreeCapturePlanMatchesJournal(
  value: unknown,
  journal: unknown
): FolderTreeCapturePlanV1 {
  const plan = validateFolderTreeCapturePlan(value);
  const derived = deriveTreeInventory(journal, plan.selectedRootId, {
    includeArchived: plan.includeArchived === true,
    legacyUrlFreeReadySourceIds: new Set(
      plan.items
        .filter((item) => item.sourceUrl === undefined && item.requestCapability.state === 'ready')
        .map((item) => item.sourceId)
    ),
  });
  for (const key of [
    'includedFolderIds',
    'excludedFolderIds',
    'includedNotebookSourceIds',
    'items',
    'blockers',
  ] as const) {
    if (canonical(plan[key]) !== canonical(derived[key])) {
      throw new FolderTreeCapturePlanError(
        `Folder Tree capture plan ${key} does not match its terminal traversal.`
      );
    }
  }
  if (
    plan.traversalJournalDigest !== derived.traversalJournalDigest ||
    plan.maximumFolderDepth !== derived.maximumFolderDepth ||
    (!plan.startAllowed && derived.blockers.length === 0)
  ) {
    throw new FolderTreeCapturePlanError(
      'Folder Tree capture plan depth or journal digest is stale.'
    );
  }
  return plan;
}

export function folderTreeTraversalJournalDigest(journal: unknown): string {
  const normalized = validateAndNormalizeDurableScopedFolderTraversalJournal(journal);
  return `sha256:${createHash('sha256')
    .update(canonicalScopedFolderTraversalJson(normalized))
    .digest('hex')}`;
}

export function folderTreeInitialExportJobIdentityIndex(
  value: unknown
): ReadonlyMap<string, FolderTreeInitialExportJobIdentity> {
  const plan = validateFolderTreeCapturePlan(value);
  const identities = new Map<string, FolderTreeInitialExportJobIdentity>();
  for (const item of plan.items) {
    if (item.requestCapability.state !== 'ready') continue;
    const authorityBase = {
      schema: FOLDER_TREE_EXPORT_AUTHORITY_SCHEMA,
      capturePlanDigest: plan.planDigest,
      traversalJournalDigest: plan.traversalJournalDigest,
      selectedRootId: plan.selectedRootId,
      sourceItemId: item.sourceId,
      sourceItemUrl: requireObservedItemUrl(item.sourceUrl, item.sourceId),
      sourceFolderIds: [...item.sourceFolderIds],
      maximumFolderDepth: plan.maximumFolderDepth,
    };
    const authority: FolderTreeExportAuthority =
      item.sourceType === 'sequence'
        ? immutable({
            ...authorityBase,
            sourceItemType: 'sequence',
            requestCapabilityId: FOLDER_TREE_SEQUENCE_EXPORT_CAPABILITY,
          })
        : immutable({
            ...authorityBase,
            sourceItemType: 'entry',
            requestCapabilityId: FOLDER_TREE_NOTEBOOK_EXPORT_CAPABILITY,
          });
    const digest = hashCanonical({ schema: FOLDER_TREE_EXPORT_AUTHORITY_SCHEMA, authority });
    identities.set(
      item.sourceId,
      immutable({
        authority,
        id: `tree_item_export_${digest.slice(0, 24)}`,
        matchSignature: `benchling-tree-item-export:v1:${digest}`,
      })
    );
  }
  return identities;
}

export function folderTreeProviderPreflightFromPlan(input: {
  scope: Extract<MigrationScope, { kind: 'folder_tree' }>;
  plan: unknown;
  base: MigrationCapturePreflight;
}): MigrationCapturePreflight {
  const plan = validateFolderTreeCapturePlan(input.plan);
  const root = input.scope.roots[0];
  if (input.scope.roots.length !== 1 || root?.id !== plan.selectedRootId) {
    throw new FolderTreeCapturePlanError('Folder Tree plan belongs to another selected root.');
  }
  if ((plan.includeArchived === true) !== (input.scope.includeArchived === true)) {
    throw new FolderTreeCapturePlanError(
      'Folder Tree capture plan has different archived-item authority.'
    );
  }
  if (!plan.startAllowed) return blockedPreflight(input.base);
  const identities = folderTreeInitialExportJobIdentityIndex(plan);
  const exportJobs = plan.items
    .filter(({ requestCapability }) => requestCapability.state === 'ready')
    .map((item) => {
      const sourceId = item.sourceId;
      const identity = identities.get(sourceId);
      if (!identity || !root) {
        throw new FolderTreeCapturePlanError(`Folder Tree item ${sourceId} lost plan authority.`);
      }
      if (item.sourceUrl === undefined) {
        throw new FolderTreeCapturePlanError(
          `Folder Tree item ${sourceId} has legacy URL-free authority; start a new URL-authorized discovery run.`
        );
      }
      const sourceItemUrl = canonicalBenchlingItemUrl(
        item.sourceUrl,
        item.sourceId,
        benchlingOrganizationBaseUrlFromSourceUrl(root.url)
      );
      return {
        id: identity.id,
        contentFamily: contentFamilyForReadyTreeItem(item),
        sourceRoots: [
          {
            id: sourceId,
            url: sourceItemUrl,
            objectType: item.sourceType,
          } satisfies BenchlingSourceRef,
        ],
        matchSignature: identity.matchSignature,
        folderTreeAuthority: identity.authority,
      };
    });
  const plannedActions: MigrationNetworkAction[] = [
    ...exportJobs.map((job) => ({
      id: `action-submit-${job.id}`,
      kind: 'export_submit' as const,
      description: `Submit one plan-authorized ${job.contentFamily} export for Tree item ${job.sourceRoots[0].id}.`,
      sourceIds: [job.sourceRoots[0].id],
    })),
    ...(exportJobs.length === 0
      ? []
      : [
          {
            id: `action-receipt-${plan.planDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`,
            kind: 'gmail_poll' as const,
            description: `Check only the exact export tasks and confirmed Gmail mailbox for these serialized Tree items (${exportJobs.map((job) => job.sourceRoots[0].id).join(', ')}). Every Gmail receipt requires explicit item confirmation.`,
            sourceIds: exportJobs.map((job) => job.sourceRoots[0].id),
          },
        ]),
    ...exportJobs.map((job) => ({
      id: `action-download-${job.id}`,
      kind: 'export_download' as const,
      description: `Download only the explicitly confirmed receipt bound to Tree item ${job.sourceRoots[0].id}.`,
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
            sourceIds: exportJobs.map((job) => job.sourceRoots[0].id),
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

function deriveTreeInventory(
  journal: unknown,
  selectedRootId: string,
  options: {
    includeArchived?: boolean;
    legacyUrlFreeReadySourceIds?: ReadonlySet<string>;
  } = {}
) {
  const normalized = validateAndNormalizeDurableScopedFolderTraversalJournal(journal);
  const includeArchived = options.includeArchived ?? normalized.includeArchived === true;
  if (
    normalized.scopeKind !== 'folder_tree' ||
    normalized.selectedRootIds.length !== 1 ||
    normalized.selectedRootIds[0] !== selectedRootId
  ) {
    throw new FolderTreeCapturePlanError('Tree journal escaped the selected root.');
  }
  if ((normalized.includeArchived === true) !== includeArchived) {
    throw new FolderTreeCapturePlanError('Tree journal has different archived-item authority.');
  }
  const replay = replayScopedFolderTraversalJournalSync(normalized);
  if (!replay.terminal || !replay.terminalEvidence) {
    throw new FolderTreeCapturePlanError('Tree capture requires a terminal traversal journal.');
  }
  const facts = replay.terminalEvidence.folderFacts;
  const includedFolderIds = facts.filter(({ included }) => included).map(({ id }) => id);
  const excludedFolderIds = replay.terminalEvidence.excludedChildFolderIds;
  const includedSet = new Set(includedFolderIds);
  const items = replay.terminalEvidence.selectedItems.map((item): FolderTreePlanItem => {
    if (
      item.sourceFolderIds.length === 0 ||
      item.sourceFolderIds.some((id) => !includedSet.has(id))
    ) {
      throw new FolderTreeCapturePlanError(`Tree item ${item.id} escaped included folders.`);
    }
    const legacyUrlFreeReady =
      item.sourceUrl === undefined &&
      options.legacyUrlFreeReadySourceIds?.has(item.id) === true &&
      ((item.type === 'entry' && NOTEBOOK_ENTRY_ID.test(item.id)) ||
        (item.type === 'sequence' && SEQUENCE_ID.test(item.id)));
    const blocker: FolderTreePlanBlockerCode | null =
      item.archived && !includeArchived
        ? 'archived_item_unproven'
        : item.type === 'unknown'
          ? 'unknown_item_type'
          : item.sourceUrl === undefined && !legacyUrlFreeReady
            ? 'unproven_item_request'
            : item.type === 'entry' && NOTEBOOK_ENTRY_ID.test(item.id)
              ? null
              : item.type === 'sequence' && SEQUENCE_ID.test(item.id)
                ? null
                : 'unproven_item_request';
    return {
      sourceId: item.id,
      ...(item.sourceUrl === undefined ? {} : { sourceUrl: item.sourceUrl }),
      sourceType: item.type,
      sourceFolderIds: [...item.sourceFolderIds],
      archived: item.archived,
      requestCapability: blocker
        ? { state: 'blocked', code: blocker }
        : {
            state: 'ready',
            id:
              item.type === 'sequence'
                ? FOLDER_TREE_SEQUENCE_EXPORT_CAPABILITY
                : FOLDER_TREE_NOTEBOOK_EXPORT_CAPABILITY,
            method: 'POST',
            path: '/1/api/exports/',
            body: { file: item.id },
          },
    };
  });
  const blockers = items
    .filter(
      (
        item
      ): item is FolderTreePlanItem & {
        requestCapability: Extract<FolderTreePlanItem['requestCapability'], { state: 'blocked' }>;
      } => item.requestCapability.state === 'blocked'
    )
    .map((item) => ({
      code: item.requestCapability.code,
      sourceId: item.sourceId,
      sourceType: item.sourceType,
    }));
  return {
    includedFolderIds,
    excludedFolderIds,
    includedNotebookSourceIds: items
      .filter(({ requestCapability }) => requestCapability.state === 'ready')
      .map(({ sourceId }) => sourceId),
    maximumFolderDepth: maximumDepth(facts, selectedRootId),
    traversalJournalDigest: `sha256:${replay.journalDigest}`,
    items,
    blockers,
  };
}

function contentFamilyForReadyTreeItem(item: FolderTreePlanItem): 'notebook' | 'dna_rna' {
  if (item.requestCapability.state !== 'ready') {
    throw new FolderTreeCapturePlanError(`Tree item ${item.sourceId} is not runnable.`);
  }
  return item.sourceType === 'sequence' ? 'dna_rna' : 'notebook';
}

function maximumDepth(facts: ScopedFolderTraversalFolderFact[], rootId: string): number {
  const byId = new Map(facts.map((fact) => [fact.id, fact] as const));
  let maximum = 0;
  for (const fact of facts.filter(({ included }) => included)) {
    let depth = 0;
    let cursor: ScopedFolderTraversalFolderFact | undefined = fact;
    const seen = new Set<string>();
    while (cursor.id !== rootId) {
      if (seen.has(cursor.id) || !cursor.parentFolderId) {
        throw new FolderTreeCapturePlanError('Tree folder ancestry escaped its selected root.');
      }
      seen.add(cursor.id);
      const parent: ScopedFolderTraversalFolderFact | undefined = byId.get(cursor.parentFolderId);
      if (!parent?.included) {
        throw new FolderTreeCapturePlanError('Tree folder ancestry contains an excluded parent.');
      }
      cursor = parent;
      depth += 1;
    }
    maximum = Math.max(maximum, depth);
  }
  return maximum;
}

function normalizeItem(
  value: unknown,
  index: number,
  includedFolderIds: string[],
  includeArchived: boolean
): FolderTreePlanItem {
  const record = requireRecord(value, `Tree item ${index}`);
  exactKeys(record, [
    'sourceId',
    ...(record.sourceUrl === undefined ? [] : ['sourceUrl']),
    'sourceType',
    'sourceFolderIds',
    'archived',
    'requestCapability',
  ]);
  const sourceId = requireOpaqueId(record.sourceId, 'item source ID');
  const sourceUrl =
    record.sourceUrl === undefined ? undefined : requireObservedItemUrl(record.sourceUrl, sourceId);
  const sourceType = record.sourceType as ScopedFolderTraversalItem['type'];
  if (
    sourceType !== 'unknown' &&
    !SCOPED_FOLDER_SEARCH_TYPES.includes(sourceType as (typeof SCOPED_FOLDER_SEARCH_TYPES)[number])
  ) {
    throw new FolderTreeCapturePlanError(`Tree item ${sourceId} source type is invalid.`);
  }
  const sourceFolderIds = folderIdArray(record.sourceFolderIds, 'item memberships');
  if (
    sourceFolderIds.length === 0 ||
    sourceFolderIds.some((id) => !includedFolderIds.includes(id))
  ) {
    throw new FolderTreeCapturePlanError(`Tree item ${sourceId} has out-of-plan membership.`);
  }
  if (typeof record.archived !== 'boolean') {
    throw new FolderTreeCapturePlanError(`Tree item ${sourceId} archive state is invalid.`);
  }
  const capability = requireRecord(record.requestCapability, 'item request capability');
  const eligibleNotebook =
    (!record.archived || includeArchived) &&
    sourceType === 'entry' &&
    NOTEBOOK_ENTRY_ID.test(sourceId);
  const eligibleSequence =
    (!record.archived || includeArchived) &&
    sourceType === 'sequence' &&
    SEQUENCE_ID.test(sourceId);
  const readyNotebook = sourceUrl !== undefined && eligibleNotebook;
  const readySequence = sourceUrl !== undefined && eligibleSequence;
  const legacyReady =
    sourceUrl === undefined &&
    capability.state === 'ready' &&
    (eligibleNotebook || eligibleSequence);
  if (readyNotebook || readySequence || legacyReady) {
    exactKeys(capability, ['state', 'id', 'method', 'path', 'body']);
    const body = requireRecord(capability.body, 'item request body');
    exactKeys(body, ['file']);
    if (
      capability.state !== 'ready' ||
      capability.id !==
        (eligibleSequence
          ? FOLDER_TREE_SEQUENCE_EXPORT_CAPABILITY
          : FOLDER_TREE_NOTEBOOK_EXPORT_CAPABILITY) ||
      capability.method !== 'POST' ||
      capability.path !== '/1/api/exports/' ||
      body.file !== sourceId
    ) {
      throw new FolderTreeCapturePlanError(`Tree item ${sourceId} has invalid request authority.`);
    }
    return {
      sourceId,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      sourceType,
      sourceFolderIds,
      archived: record.archived,
      requestCapability: {
        state: 'ready',
        id: eligibleSequence
          ? FOLDER_TREE_SEQUENCE_EXPORT_CAPABILITY
          : FOLDER_TREE_NOTEBOOK_EXPORT_CAPABILITY,
        method: 'POST',
        path: '/1/api/exports/',
        body: { file: sourceId },
      },
    };
  }
  exactKeys(capability, ['state', 'code']);
  const expected: FolderTreePlanBlockerCode =
    record.archived && !includeArchived
      ? 'archived_item_unproven'
      : sourceType === 'unknown'
        ? 'unknown_item_type'
        : 'unproven_item_request';
  if (capability.state !== 'blocked' || capability.code !== expected) {
    throw new FolderTreeCapturePlanError(`Tree item ${sourceId} has invalid blocker authority.`);
  }
  return {
    sourceId,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    sourceType,
    sourceFolderIds,
    archived: record.archived,
    requestCapability: { state: 'blocked', code: expected },
  };
}

function requireObservedItemUrl(value: unknown, sourceItemId: string): string {
  try {
    return requireCanonicalBenchlingItemUrl(value, sourceItemId);
  } catch {
    throw new FolderTreeCapturePlanError(
      `Folder Tree item ${sourceItemId} has no exact canonical observed URL; start a new URL-authorized discovery run.`
    );
  }
}

function normalizeBlockers(value: unknown, items: FolderTreePlanItem[]) {
  if (!Array.isArray(value)) throw new FolderTreeCapturePlanError('Tree blockers are invalid.');
  return value.map((candidate, index) => {
    const record = requireRecord(candidate, `Tree blocker ${index}`);
    exactKeys(record, ['code', 'sourceId', 'sourceType']);
    const item = items.find(({ sourceId }) => sourceId === record.sourceId);
    if (
      !item ||
      item.requestCapability.state !== 'blocked' ||
      record.code !== item.requestCapability.code ||
      record.sourceType !== item.sourceType
    ) {
      throw new FolderTreeCapturePlanError('Tree blocker does not match a blocked item.');
    }
    return {
      code: item.requestCapability.code,
      sourceId: item.sourceId,
      sourceType: item.sourceType,
    };
  });
}

function blockedPreflight(base: MigrationCapturePreflight): MigrationCapturePreflight {
  return {
    ...structuredClone(base),
    plannedContentFamilies: [],
    exportJobs: [],
    plannedActions: [],
    compressedArchiveBytes: 0,
    declaredUncompressedBytes: 0,
    projectedObjectBytes: 0,
    largestTemporaryBytes: 0,
  };
}

function planDigest(value: Omit<FolderTreeCapturePlanV1, 'planDigest'>): string {
  return `sha256:${hashCanonical(value)}`;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FolderTreeCapturePlanError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: string[]): void {
  if (canonical(Object.keys(record).sort()) !== canonical([...expected].sort())) {
    throw new FolderTreeCapturePlanError('Folder Tree contract contains unexpected fields.');
  }
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new FolderTreeCapturePlanError(`${label} is invalid.`);
  }
  return value;
}

function requireFolderId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !FOLDER_ID.test(value)) {
    throw new FolderTreeCapturePlanError(`${label} is invalid.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new FolderTreeCapturePlanError(`${label} is invalid.`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_REF.test(value)) {
    throw new FolderTreeCapturePlanError(`${label} is invalid.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new FolderTreeCapturePlanError(`${label} is invalid.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100_000) {
    throw new FolderTreeCapturePlanError(`${label} is invalid.`);
  }
  return value as number;
}

function folderIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new FolderTreeCapturePlanError(`${label} are invalid.`);
  const ids = value.map((item) => requireFolderId(item, label));
  uniqueCanonical(ids, label);
  return ids;
}

function opaqueIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new FolderTreeCapturePlanError(`${label} are invalid.`);
  const ids = value.map((item) => requireOpaqueId(item, label));
  uniqueCanonical(ids, label);
  return ids;
}

function uniqueCanonical(ids: string[], label: string): void {
  const sorted = [...ids].sort();
  if (new Set(ids).size !== ids.length || canonical(ids) !== canonical(sorted)) {
    throw new FolderTreeCapturePlanError(`${label} must be unique and canonical.`);
  }
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(immutable);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(immutable);
    return Object.freeze(value);
  }
  return value;
}
