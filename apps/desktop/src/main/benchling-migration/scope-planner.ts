import { createHash } from 'node:crypto';
import type {
  BenchlingSourceRef,
  ExportJob,
  MigrationScope,
} from '../../shared/benchling-migration';
import { observableReceiptMatchKey } from './receipt-match-key';

export type DiscoveredFolderNode = {
  ref: BenchlingSourceRef;
  parentFolderId: string | null;
};

export type PlannedScopeSelection = {
  scope: MigrationScope;
  primarySourceIds: string[];
  selectedRootIds: string[];
  includedFolderIds: string[];
  excludedDirectChildFolderIds: string[];
};

export type ExportContentFamily =
  | 'dna_rna'
  | 'registry'
  | 'protein'
  | 'notebook'
  | 'protocol'
  | 'attachment'
  | 'generic';

export type PlannedExportChunk = {
  root: BenchlingSourceRef;
  contentFamily: ExportContentFamily;
  recursive: boolean;
  rootLevelItems: BenchlingSourceRef[];
  derivedFromFailedJobId: string | null;
};

export type ExportSplitScopeErrorReason = 'split_root_mismatch' | 'direct_folder_item_unverified';

export class ExportSplitScopeError extends Error {
  constructor(
    readonly reason: ExportSplitScopeErrorReason,
    readonly failedJobId: string,
    readonly sourceIds: string[],
    message: string
  ) {
    super(message);
    this.name = 'ExportSplitScopeError';
  }
}

const PENDING_REMOTE_STATES = new Set<ExportJob['state']>([
  'submitted',
  'receipt_pending',
  'receipt_matched',
  'downloading',
]);

export function planScopeSelection(
  scope: MigrationScope,
  discoveredFolders: DiscoveredFolderNode[] = []
): PlannedScopeSelection {
  if (scope.kind === 'file') {
    return {
      scope,
      primarySourceIds: [scope.source.id],
      selectedRootIds: [],
      includedFolderIds: [],
      excludedDirectChildFolderIds: [],
    };
  }

  const roots = scope.kind === 'folder' ? [scope.folder] : dedupeRefs(scope.roots);
  const selectedRootIds = roots.map((root) => root.id).sort();
  const childrenByParent = new Map<string, string[]>();
  for (const folder of discoveredFolders) {
    if (!folder.parentFolderId) continue;
    const children = childrenByParent.get(folder.parentFolderId) ?? [];
    children.push(folder.ref.id);
    childrenByParent.set(folder.parentFolderId, children);
  }

  if (scope.kind === 'folder') {
    return {
      scope,
      primarySourceIds: [],
      selectedRootIds,
      includedFolderIds: selectedRootIds,
      excludedDirectChildFolderIds: [...(childrenByParent.get(scope.folder.id) ?? [])].sort(),
    };
  }

  const included = new Set(selectedRootIds);
  const queue = [...selectedRootIds];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (included.has(child)) continue;
      included.add(child);
      queue.push(child);
    }
  }
  return {
    scope,
    primarySourceIds: [],
    selectedRootIds,
    includedFolderIds: [...included].sort(),
    excludedDirectChildFolderIds: [],
  };
}

export function planInitialExportJobs(input: {
  runId: string;
  scope: MigrationScope;
  contentFamilies: ExportContentFamily[];
  now?: string;
}): ExportJob[] {
  const families = [...new Set(input.contentFamilies)].sort();
  const roots =
    input.scope.kind === 'file'
      ? [input.scope.source]
      : input.scope.kind === 'folder'
        ? [input.scope.folder]
        : dedupeRefs(input.scope.roots);
  return roots
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((root) =>
      families.map((family) => makeExportJob(input.runId, family, [root], input.now ?? null))
    );
}

export function splitFailedExportRoot(input: {
  scope: MigrationScope;
  failedJob: ExportJob;
  root: BenchlingSourceRef;
  directChildFolders: BenchlingSourceRef[];
  rootLevelItems: BenchlingSourceRef[];
}): PlannedExportChunk[] {
  const failedRoot = input.failedJob.sourceRoots[0];
  if (
    input.failedJob.sourceRoots.length !== 1 ||
    !failedRoot ||
    failedRoot.id !== input.root.id ||
    failedRoot.url !== input.root.url
  ) {
    throw new ExportSplitScopeError(
      'split_root_mismatch',
      input.failedJob.id,
      [input.root.id, ...input.failedJob.sourceRoots.map((root) => root.id)].sort(),
      `Export split inventory root ${input.root.id} does not match failed job ${input.failedJob.id}.`
    );
  }

  const directChildFolders = dedupeRefs(input.directChildFolders).sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const rootItems = dedupeRefs(input.rootLevelItems).sort((left, right) =>
    left.id.localeCompare(right.id)
  );

  if (input.scope.kind === 'folder') {
    if (input.root.id !== input.scope.folder.id || input.root.url !== input.scope.folder.url) {
      throw new ExportSplitScopeError(
        'split_root_mismatch',
        input.failedJob.id,
        [input.root.id, input.scope.folder.id].sort(),
        `Direct Folder split root ${input.root.id} does not match selected folder ${input.scope.folder.id}.`
      );
    }
    const unverifiedItems = rootItems.filter(
      (item) => !item.objectType || item.objectType === 'folder' || item.id === input.root.id
    );
    if (unverifiedItems.length > 0) {
      throw new ExportSplitScopeError(
        'direct_folder_item_unverified',
        input.failedJob.id,
        unverifiedItems.map((item) => item.id),
        `Direct Folder split for ${input.root.id} contains items without explicit non-folder direct-member evidence.`
      );
    }
  }

  const childChunks =
    input.scope.kind === 'folder'
      ? []
      : directChildFolders.map((root) => ({
          root,
          contentFamily: input.failedJob.contentFamily as ExportContentFamily,
          recursive: true,
          rootLevelItems: [],
          derivedFromFailedJobId: input.failedJob.id,
        }));
  const rootChunk: PlannedExportChunk[] =
    rootItems.length > 0
      ? [
          {
            root: input.root,
            contentFamily: input.failedJob.contentFamily as ExportContentFamily,
            recursive: false,
            rootLevelItems: rootItems,
            derivedFromFailedJobId: input.failedJob.id,
          },
        ]
      : [];
  return [...rootChunk, ...childChunks];
}

export function nextSubmittableExportJob(jobs: ExportJob[]): ExportJob | null {
  const pending = jobs.filter((job) => PENDING_REMOTE_STATES.has(job.state));
  if (pending.length >= 2) return null;
  const pendingReceiptMatchKeys = new Set(pending.map(observableReceiptMatchKey));
  return (
    jobs
      .filter(
        (job) =>
          job.state === 'planned' && !pendingReceiptMatchKeys.has(observableReceiptMatchKey(job))
      )
      .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null
  );
}

export function makeExportJob(
  runId: string,
  contentFamily: string,
  roots: BenchlingSourceRef[],
  submittedAt: string | null = null
): ExportJob {
  const stableRoots = dedupeRefs(roots).sort((left, right) => left.id.localeCompare(right.id));
  const signaturePayload = `${contentFamily}:${stableRoots.map((root) => root.id).join(',')}`;
  const signature = createHash('sha256').update(signaturePayload).digest('hex');
  return {
    id: `export_${signature.slice(0, 20)}`,
    runId,
    contentFamily,
    sourceRoots: stableRoots,
    matchSignature: `benchling-export:${signature}`,
    state: submittedAt ? 'submitted' : 'planned',
    submittedAt,
    attempts: submittedAt ? 1 : 0,
    receiptId: null,
    downloadUrlHash: null,
    snapshotPartId: null,
  };
}

export function makeReplacementExportJob(input: {
  failedJob: ExportJob;
  sourceRoots: BenchlingSourceRef[];
  reason: 'export_timed_out' | 'download_link_expired';
  ordinal: number;
}): ExportJob {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error('Replacement export ordinal must be a non-negative safe integer.');
  }
  const stableRoots = dedupeRefs(input.sourceRoots).sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  if (stableRoots.length === 0) throw new Error('Replacement export requires source roots.');
  const directFolderAuthority = input.failedJob.directFolderAuthority;
  const folderTreeAuthority = input.failedJob.folderTreeAuthority;
  if (directFolderAuthority && folderTreeAuthority) {
    throw new Error('A replacement export cannot carry two selected-scope authorities.');
  }
  const selectedFolderAuthority = directFolderAuthority ?? folderTreeAuthority;
  if (selectedFolderAuthority) {
    const failedRoot = input.failedJob.sourceRoots[0];
    const replacementRoot = stableRoots[0];
    if (
      input.failedJob.sourceRoots.length !== 1 ||
      input.sourceRoots.length !== 1 ||
      stableRoots.length !== 1 ||
      !failedRoot ||
      !replacementRoot ||
      failedRoot.id !== selectedFolderAuthority.sourceItemId ||
      failedRoot.objectType !== selectedFolderAuthority.sourceItemType ||
      replacementRoot.id !== failedRoot.id ||
      replacementRoot.url !== failedRoot.url ||
      replacementRoot.objectType !== failedRoot.objectType
    ) {
      throw new Error(
        `${directFolderAuthority ? 'Direct Folder' : 'Folder Tree'} replacement must preserve the exact authorized single-item source.`
      );
    }
  }
  if (folderTreeAuthority && (input.reason !== 'download_link_expired' || input.ordinal !== 0)) {
    throw new Error(
      'Folder Tree replacement authority permits only the first expired-link successor.'
    );
  }
  const identity = deriveReplacementExportIdentity({
    predecessorJobId: input.failedJob.id,
    reason: input.reason,
    ordinal: input.ordinal,
    contentFamily: input.failedJob.contentFamily,
    sourceRootIds: stableRoots.map((root) => root.id),
  });
  return {
    id: identity.id,
    runId: input.failedJob.runId,
    contentFamily: input.failedJob.contentFamily,
    sourceRoots: stableRoots,
    matchSignature: identity.matchSignature,
    ...(directFolderAuthority
      ? { directFolderAuthority: structuredClone(directFolderAuthority) }
      : {}),
    ...(folderTreeAuthority ? { folderTreeAuthority: structuredClone(folderTreeAuthority) } : {}),
    ...(folderTreeAuthority
      ? {
          folderTreeReplacementLineage: {
            schema: 'dnaforge.benchling.folder-tree-export-replacement-lineage.v1' as const,
            predecessorJobId: input.failedJob.id,
            predecessorMatchSignature: input.failedJob.matchSignature,
            reason: 'download_link_expired' as const,
            ordinal: 0 as const,
          },
        }
      : {}),
    state: 'planned',
    submittedAt: null,
    attempts: 0,
    receiptId: null,
    downloadUrlHash: null,
    snapshotPartId: null,
  };
}

export function deriveReplacementExportIdentity(input: {
  predecessorJobId: string;
  reason: 'export_timed_out' | 'download_link_expired';
  ordinal: number;
  contentFamily: string;
  sourceRootIds: readonly string[];
}): { id: string; matchSignature: string } {
  const payload = [
    input.predecessorJobId,
    input.reason,
    String(input.ordinal),
    input.contentFamily,
    input.sourceRootIds.join(','),
  ].join(':');
  const digest = createHash('sha256').update(payload).digest('hex');
  return {
    id: `export_${digest.slice(0, 20)}`,
    matchSignature: `benchling-export:${digest}`,
  };
}

function dedupeRefs(refs: BenchlingSourceRef[]): BenchlingSourceRef[] {
  const byId = new Map<string, BenchlingSourceRef>();
  for (const ref of refs) {
    const existing = byId.get(ref.id);
    if (existing && existing.url !== ref.url) {
      throw new Error(`Stable source ID ${ref.id} has conflicting URLs.`);
    }
    byId.set(ref.id, existing ?? ref);
  }
  return [...byId.values()];
}
