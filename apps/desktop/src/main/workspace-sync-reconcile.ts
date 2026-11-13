import { createHash } from 'node:crypto';

import {
  decodeBundleFileContent,
  type WorkspaceSyncBundle,
  type WorkspaceSyncFile,
} from '@waypoint/share-bundle';
import { parseSequencePackageAdmissionDescriptor } from '@waypoint/share-bundle/sequence-package-admission';
import {
  applyWorkspaceMutation,
  createRevisionGraph,
  defineBlob,
  parseBlobHash,
  defineResourceState,
  inspectWorkspaceResource,
  listWorkspaceResources,
  mergeWorkspaceVersions,
  parseMemberId,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseResourcePath,
  parseWorkspaceId,
  parseWorkspacePath,
  type ApplyMutationResult,
  type Conflict,
  type ResourceId,
  type ResourceRevisionId,
  type ResourceState,
  type Result,
  type RevisionGraph,
  type WorkspaceMutation,
  type WorkspacePath,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  exportCanonicalClosure,
  importCanonicalRecords,
} from '@waypoint/workspace-revisions/codec';

export type ReconcileResourceKind = 'file' | 'sequence-package' | 'notebook-package';

export interface ReconcileResource {
  id: string;
  kind: ReconcileResourceKind;
  path: string;
  files: WorkspaceSyncFile[];
  contentHash: string;
  memberIds?: ReadonlyMap<string, string>;
  placeholder?: boolean;
}

export type ReconcileConflictReason =
  | 'edit-edit'
  | 'rename-rename'
  | 'delete-edit'
  | 'move-delete'
  | 'membership-remove-edit'
  | 'identity-conflict'
  | 'path-conflict';

export interface ReconcileConflictItem {
  resourceId: string;
  kind: ReconcileResourceKind;
  reason: ReconcileConflictReason;
  path: string;
  base: ReconcileResource | null;
  local: ReconcileResource | null;
  remote: ReconcileResource | null;
  canKeepBoth: boolean;
}

export type ReconcileChoice = 'mine' | 'theirs' | 'both';

export interface ReconcileSummary {
  takenFromLocal: string[];
  takenFromRemote: string[];
  unchanged: string[];
  deleted: string[];
}

export type ReconcileOutcome =
  | { kind: 'merged'; files: WorkspaceSyncFile[]; summary: ReconcileSummary }
  | { kind: 'conflicts'; conflicts: ReconcileConflictItem[] }
  | { kind: 'failed'; reason: string };

export interface ReconcileInput {
  workspaceId: string;
  base: WorkspaceSyncBundle | null;
  local: WorkspaceSyncBundle;
  remote: WorkspaceSyncBundle;
  localCaptureComplete?: boolean;
  remoteAuthorLabel?: string | null;
  localAuthorLabel?: string | null;
}

const REF_NAME = must(parseRefName('main'));
const SENTINEL_ID = '__dnaforge_reconcile_root__';
const SENTINEL_PATH = '.dnaforge/reconcile-root';

function privateResourceReconciliationError(input: ReconcileInput): string | null {
  if (input.localCaptureComplete) {
    const excluded = input.local.excludedSummary;
    if (excluded && (excluded['file-too-large'].count || excluded['bundle-too-large'].count)) {
      return 'Local reconciliation capture is incomplete: some admitted project files could not be captured. Nothing was merged or deleted.';
    }
    return null;
  }
  if (
    [input.base, input.local, input.remote].some((bundle) =>
      bundle?.files.some((file) => file.kind === 'workspace-resource')
    )
  ) {
    return 'This desktop build cannot safely reconcile ordinary project files. Keep this local project and open the cloud version in the web app; their contents have been kept separate.';
  }
  return null;
}

export function reconcileWorkspaceBundles(input: ReconcileInput): ReconcileOutcome {
  const grouped = groupReconciliationInputs(input);
  if ('kind' in grouped) return grouped;
  return reconcileResources(grouped);
}

export function reconcileWithChoices(
  input: ReconcileInput,
  choices: Readonly<Record<string, ReconcileChoice>>
): ReconcileOutcome {
  const grouped = groupReconciliationInputs(input);
  if ('kind' in grouped) return grouped;
  const { base, local, remote } = grouped;
  const remoteLabel = safeLabel(input.remoteAuthorLabel ?? 'shared');
  const localLabel = safeLabel(input.localAuthorLabel ?? 'my');

  for (const [resourceId, choice] of Object.entries(choices)) {
    const mine = local.get(resourceId) ?? null;
    const theirs = remote.get(resourceId) ?? null;

    const rivalOfMine = mine ? occupantOfPath(remote, mine.path) : null;
    const rivalOfTheirs = theirs ? occupantOfPath(local, theirs.path) : null;
    if (
      mine &&
      rivalOfMine &&
      rivalOfMine.id !== mine.id &&
      (choice === 'mine' || choice === 'both')
    ) {
      remote.set(
        rivalOfMine.id,
        relocateResource(rivalOfMine, labeledCopyPath(rivalOfMine.path, remoteLabel, local, remote))
      );
      continue;
    }
    if (mine && rivalOfMine && rivalOfMine.id !== mine.id && choice === 'theirs') {
      local.set(
        mine.id,
        relocateResource(mine, labeledCopyPath(mine.path, localLabel, local, remote))
      );
      continue;
    }
    if (!mine && theirs && rivalOfTheirs && rivalOfTheirs.id !== theirs.id) {
      if (choice === 'theirs') {
        local.set(
          rivalOfTheirs.id,
          relocateResource(
            rivalOfTheirs,
            labeledCopyPath(rivalOfTheirs.path, localLabel, local, remote)
          )
        );
      } else {
        remote.set(
          theirs.id,
          relocateResource(theirs, labeledCopyPath(theirs.path, remoteLabel, local, remote))
        );
      }
      continue;
    }

    if (choice === 'theirs') {
      if (theirs) local.set(resourceId, theirs);
      else local.delete(resourceId);
    } else if (choice === 'mine') {
      if (mine) remote.set(resourceId, mine);
      else remote.delete(resourceId);
    } else if (choice === 'both') {
      if (!mine || !theirs || mine.kind !== 'file' || theirs.kind !== 'file') {
        return {
          kind: 'failed',
          reason: `Keeping both copies is only possible for a file present on both sides (${resourceId}).`,
        };
      }
      remote.set(resourceId, mine);
      const copy = renameLooseFile(
        theirs,
        labeledCopyPath(theirs.path, remoteLabel, local, remote)
      );
      local.set(copy.id, copy);
    }
  }

  return reconcileResources({ workspaceId: input.workspaceId, base, local, remote });
}

const SEQUENCE_MARKER = /^(.+)\/\.forge\/plasmid\.json$/;
const NOTEBOOK_MARKER = /^(.+)\/\.forge\/notebook\.json$/;

export function groupBundleResources(
  bundle: WorkspaceSyncBundle | null
): Map<string, ReconcileResource> {
  const resources = new Map<string, ReconcileResource>();
  if (!bundle) return resources;

  const paths = new Set<string>();
  for (const file of bundle.files) {
    if (paths.has(file.relativePath))
      throw new Error(`Duplicate captured path: ${file.relativePath}.`);
    paths.add(file.relativePath);
  }
  const roots: Array<{
    root: string;
    kind: ReconcileResourceKind;
    id: string;
    memberIds?: ReadonlyMap<string, string>;
  }> = [];
  for (const file of bundle.files) {
    const sequence = SEQUENCE_MARKER.exec(file.relativePath);
    const notebook = sequence ? null : NOTEBOOK_MARKER.exec(file.relativePath);
    const match = sequence ?? notebook;
    if (!match) continue;
    const kind: ReconcileResourceKind = sequence ? 'sequence-package' : 'notebook-package';
    const root = match[1];
    const marker = readMarkerDocument(file);
    const markerId = readMarkerId(marker, file.relativePath);
    const prefix = kind === 'sequence-package' ? 'seq' : 'nb';
    let memberIds: Map<string, string> | undefined;
    if (sequence) {
      const authority = parseSequencePackageAdmissionDescriptor(marker, file.relativePath);
      if (!authority.ok) {
        throw new Error(
          `Invalid sequence package ${root}: ${authority.errors.map((error) => error.message).join('; ')}`
        );
      }
      for (const path of authority.descriptor.requiredPaths) {
        if (!paths.has(path))
          throw new Error(`Sequence package ${root} is incomplete: missing ${path}.`);
      }
      memberIds = new Map([
        [file.relativePath.slice(root.length + 1), 'implicit:sequence-marker'],
        [authority.descriptor.productPath.slice(root.length + 1), 'implicit:sequence-product'],
        ...authority.descriptor.members.map((member): [string, string] => [
          member.path.slice(root.length + 1),
          `member:${member.memberId}`,
        ]),
      ]);
    }
    roots.push({ root, kind, id: `${prefix}:${markerId}`, ...(memberIds ? { memberIds } : {}) });
  }
  roots.sort((a, b) => b.root.length - a.root.length);

  const identities = new Map<string, string>();
  for (const entry of roots) {
    const existing = identities.get(entry.id);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate package identity ${entry.id}: ${existing}, ${entry.root}. A copied package needs a new identity.`
      );
    }
    identities.set(entry.id, entry.root);
    const nested = roots.find(
      (other) =>
        other !== entry && (entry.root === other.root || entry.root.startsWith(`${other.root}/`))
    );
    if (nested) {
      throw new Error(`Overlapping package authorities: ${nested.root}, ${entry.root}.`);
    }
  }

  const grouped = new Map<string, WorkspaceSyncFile[]>();
  const rootByKey = new Map<string, (typeof roots)[number]>();
  for (const entry of roots) rootByKey.set(entry.root, entry);

  const loose: WorkspaceSyncFile[] = [];
  for (const file of bundle.files) {
    const owner = roots.find((entry) => file.relativePath.startsWith(`${entry.root}/`));
    if (!owner) {
      loose.push(file);
      continue;
    }
    const members = grouped.get(owner.root) ?? [];
    members.push(file);
    grouped.set(owner.root, members);
  }

  for (const [root, files] of grouped) {
    const entry = rootByKey.get(root);
    if (!entry) continue;
    const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const resource: ReconcileResource = {
      id: entry.id,
      kind: entry.kind,
      path: root,
      files: sorted,
      contentHash: hashFiles(sorted, root),
      ...(entry.memberIds ? { memberIds: entry.memberIds } : {}),
    };
    resources.set(resource.id, resource);
  }
  for (const file of loose) {
    const resource: ReconcileResource = {
      id: `file:${file.relativePath}`,
      kind: 'file',
      path: file.relativePath,
      files: [file],
      contentHash: hashFiles([file], null),
    };
    resources.set(resource.id, resource);
  }
  return resources;
}

function readMarkerDocument(file: WorkspaceSyncFile): unknown {
  try {
    return JSON.parse(Buffer.from(decodeBundleFileContent(file)).toString('utf8'));
  } catch {
    throw new Error(`Package identity marker is unreadable: ${file.relativePath}.`);
  }
}

function readMarkerId(parsed: unknown, markerPath: string): string {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const id = (parsed as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  throw new Error(`Package marker is missing its stable id: ${markerPath}.`);
}

function hashFiles(files: readonly WorkspaceSyncFile[], root: string | null): string {
  const hash = createHash('sha256');
  for (const file of files) {
    const relative = root ? file.relativePath.slice(root.length + 1) : file.relativePath;
    hash.update(relative).update('\0').update(file.sha256).update('\n');
  }
  return hash.digest('hex');
}

interface ResourceSets {
  workspaceId: string;
  base: Map<string, ReconcileResource>;
  local: Map<string, ReconcileResource>;
  remote: Map<string, ReconcileResource>;
}

function groupReconciliationInputs(
  input: ReconcileInput
): ResourceSets | Extract<ReconcileOutcome, { kind: 'failed' }> {
  const unsupported = privateResourceReconciliationError(input);
  if (unsupported) return { kind: 'failed', reason: unsupported };
  try {
    return {
      workspaceId: input.workspaceId,
      base: groupBundleResources(input.base),
      local: groupBundleResources(input.local),
      remote: groupBundleResources(input.remote),
    };
  } catch (error) {
    return {
      kind: 'failed',
      reason:
        error instanceof Error ? error.message : 'Package identities could not be reconciled.',
    };
  }
}

interface BranchState {
  graph: RevisionGraph;
  head: WorkspaceVersionId;
}

interface ModelContext {
  workspaceId: ReturnType<typeof mustWorkspaceId>;
  revisionContent: Map<ResourceRevisionId, ReconcileResource>;
  operationCounter: { value: number };
}

function reconcileResources(sets: ResourceSets): ReconcileOutcome {
  try {
    const context: ModelContext = {
      workspaceId: mustWorkspaceId(sets.workspaceId),
      revisionContent: new Map(),
      operationCounter: { value: 0 },
    };
    const seededBase = seedBothCreated(sets);
    const baseBranch = buildBase(context, seededBase);
    const left = applyDifference(context, baseBranch, seededBase, sets.local, 'local');
    const right = applyDifference(context, baseBranch, seededBase, sets.remote, 'remote');

    const combined = combineBranches(context, left, right);
    const merged = mergeWorkspaceVersions({
      graph: combined,
      refName: REF_NAME,
      expectedHead: left.head,
      operationId: nextOperationId(context, 'merge'),
      leftVersionId: left.head,
      rightVersionId: right.head,
    });

    if (merged.kind === 'conflict') {
      return { kind: 'conflicts', conflicts: describeConflicts(merged.conflicts, sets) };
    }
    if (merged.kind === 'rejected') {
      return {
        kind: 'failed',
        reason: `The revision model refused the merge: ${rejectedReason(merged)}`,
      };
    }
    if (merged.kind === 'replay') {
      return {
        kind: 'failed',
        reason: 'The revision model replayed an earlier merge unexpectedly.',
      };
    }
    const graph = merged.graph;
    const headVersion = merged.kind === 'changed' ? merged.version.id : merged.head;
    const slots = must(listWorkspaceResources(graph, headVersion));

    const files: WorkspaceSyncFile[] = [];
    const summary: ReconcileSummary = {
      takenFromLocal: [],
      takenFromRemote: [],
      unchanged: [],
      deleted: [],
    };
    for (const slot of slots) {
      if (slot.resourceId === SENTINEL_ID) continue;
      if (slot.tombstone || !slot.path) {
        const id = String(slot.resourceId);
        summary.deleted.push(
          (sets.base.get(id) ?? sets.local.get(id) ?? sets.remote.get(id))?.path ?? id
        );
        continue;
      }
      const revision = context.revisionContent.get(slot.revisionId);
      if (!revision) {
        return {
          kind: 'failed',
          reason: `Merged revision ${slot.revisionId} has no known content.`,
        };
      }
      const content = revision.placeholder
        ? (sets.local.get(String(slot.resourceId)) ??
          sets.remote.get(String(slot.resourceId)) ??
          revision)
        : revision;
      const placed = content.path === slot.path ? content : relocateResource(content, slot.path);
      files.push(...placed.files);
      const inLocal = sets.local.get(String(slot.resourceId));
      const inRemote = sets.remote.get(String(slot.resourceId));
      const inBase = sets.base.get(String(slot.resourceId));
      if (inBase && sameResource(inBase, placed)) summary.unchanged.push(placed.path);
      else if (inLocal && sameResource(inLocal, placed)) summary.takenFromLocal.push(placed.path);
      else if (inRemote && sameResource(inRemote, placed))
        summary.takenFromRemote.push(placed.path);
      else summary.takenFromLocal.push(placed.path);
    }
    for (const [id, resource] of sets.base) {
      if (!slots.some((slot) => String(slot.resourceId) === id && !slot.tombstone)) {
        if (!summary.deleted.includes(resource.path)) summary.deleted.push(resource.path);
      }
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { kind: 'merged', files, summary };
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : 'Reconciliation failed unexpectedly.',
    };
  }
}

function seedBothCreated(sets: ResourceSets): Map<string, ReconcileResource> {
  const seeded = new Map(sets.base);
  for (const [id, mine] of sets.local) {
    if (seeded.has(id) || !sets.remote.has(id)) continue;
    seeded.set(id, {
      id,
      kind: mine.kind,
      path: mine.path,
      files: [],
      contentHash: `placeholder:${id}`,
      placeholder: true,
    });
  }
  return seeded;
}

function buildBase(context: ModelContext, base: Map<string, ReconcileResource>): BranchState {
  let graph = createRevisionGraph({ workspaceId: context.workspaceId, acceptedRef: REF_NAME });
  let head: WorkspaceVersionId | null = null;
  const sentinel: ReconcileResource = {
    id: SENTINEL_ID,
    kind: 'file',
    path: SENTINEL_PATH,
    files: [],
    contentHash: 'sentinel',
  };
  const ordered = [sentinel, ...[...base.values()].sort((a, b) => a.id.localeCompare(b.id))];
  for (const resource of ordered) {
    const result = applyWorkspaceMutation({
      graph,
      refName: REF_NAME,
      expectedHead: head,
      operationId: nextOperationId(context, 'base-create'),
      mutation: {
        kind: 'create-resource',
        resourceId: mustResourceId(resource.id),
        path: mustWorkspacePath(resource.path),
        state: resourceState(resource),
        origin: { kind: 'created' },
      },
    });
    const changed = expectChanged(result, `base create ${resource.id}`);
    graph = changed.graph;
    head = changed.version.id;
    rememberRevision(context, graph, head, resource);
  }
  if (!head) throw new Error('Reconciliation base could not be created.');
  return { graph, head };
}

function applyDifference(
  context: ModelContext,
  from: BranchState,
  base: Map<string, ReconcileResource>,
  target: Map<string, ReconcileResource>,
  label: string
): BranchState {
  let { graph, head } = from;
  const ids = [...new Set([...base.keys(), ...target.keys()])].sort();
  for (const id of ids) {
    const before = base.get(id) ?? null;
    const after = target.get(id) ?? null;
    if (!before && !after) continue;
    const resourceId = mustResourceId(id);
    let mutation: WorkspaceMutation | null = null;
    if (!before && after) {
      mutation = {
        kind: 'create-resource',
        resourceId,
        path: mustWorkspacePath(after.path),
        state: resourceState(after),
        origin: { kind: 'created' },
      };
    } else if (before && !after) {
      const slot = currentSlot(graph, head, resourceId);
      mutation = {
        kind: 'delete-resource',
        resourceId,
        expectedRevision: slot.revisionId,
        expectedPath: mustWorkspacePath(before.path),
      };
    } else if (before && after) {
      const changed = before.contentHash !== after.contentHash;
      const moved = before.path !== after.path;
      if (!changed && !moved) continue;
      const slot = currentSlot(graph, head, resourceId);
      if (changed && moved) {
        mutation = {
          kind: 'edit-and-move-resource',
          resourceId,
          expectedRevision: slot.revisionId,
          expectedPath: mustWorkspacePath(before.path),
          state: resourceState(after),
          destination: mustWorkspacePath(after.path),
        };
      } else if (changed) {
        mutation = {
          kind: 'edit-resource',
          resourceId,
          expectedRevision: slot.revisionId,
          state: resourceState(after),
        };
      } else {
        mutation = {
          kind: 'move-resource',
          resourceId,
          expectedPath: mustWorkspacePath(before.path),
          destination: mustWorkspacePath(after.path),
        };
      }
    }
    if (!mutation) continue;
    const result = applyWorkspaceMutation({
      graph,
      refName: REF_NAME,
      expectedHead: head,
      operationId: nextOperationId(context, `${label}-${mutation.kind}`),
      mutation,
    });
    if (result.kind === 'no-op') {
      graph = result.graph;
      continue;
    }
    const changedResult = expectChanged(result, `${label} ${mutation.kind} ${id}`);
    graph = changedResult.graph;
    head = changedResult.version.id;
    if (after) rememberRevision(context, graph, head, after);
  }
  return { graph, head };
}

function combineBranches(
  context: ModelContext,
  left: BranchState,
  right: BranchState
): RevisionGraph {
  const leftClosure = exportCanonicalClosure(left.graph);
  const rightClosure = exportCanonicalClosure(right.graph);
  const imported = importCanonicalRecords({
    formatVersion: 1,
    workspaceId: leftClosure.workspaceId,
    refs: [{ name: 'main', head: left.head }],
    records: [...leftClosure.records, ...rightClosure.records],
  });
  if (!imported.ok) {
    throw new Error(
      `Could not combine local and shared histories: ${JSON.stringify(imported.error)}`
    );
  }
  void context;
  return imported.value;
}

function describeConflicts(
  conflicts: readonly Conflict[],
  sets: ResourceSets
): ReconcileConflictItem[] {
  const items: ReconcileConflictItem[] = [];
  for (const conflict of conflicts) {
    if (conflict.kind === 'resource-conflict') {
      const id = String(conflict.resourceId);
      const base = sets.base.get(id) ?? null;
      const local = sets.local.get(id) ?? null;
      const remote = sets.remote.get(id) ?? null;
      const any = local ?? remote ?? base;
      if (!any) continue;
      items.push({
        resourceId: id,
        kind: any.kind,
        reason: conflict.reason,
        path: (local ?? remote ?? base)?.path ?? id,
        base,
        local,
        remote,
        canKeepBoth: Boolean(local && remote && local.kind === 'file' && remote.kind === 'file'),
      });
    } else if (conflict.kind === 'path-conflict') {
      for (const path of conflict.paths) {
        const local = occupantOfPath(sets.local, String(path));
        const remote = occupantOfPath(sets.remote, String(path));
        const owner = local ?? remote;
        if (!owner) continue;
        items.push({
          resourceId: owner.id,
          kind: owner.kind,
          reason: 'path-conflict',
          path: String(path),
          base: sets.base.get(owner.id) ?? null,
          local,
          remote,
          canKeepBoth: Boolean(local && remote),
        });
      }
    }
  }
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.resourceId}:${item.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function occupantOfPath(
  resources: ReadonlyMap<string, ReconcileResource>,
  path: string
): ReconcileResource | null {
  for (const resource of resources.values()) if (resource.path === path) return resource;
  return null;
}

function resourceState(resource: ReconcileResource): ResourceState {
  if (resource.placeholder) {
    if (resource.kind === 'file') {
      return must(
        defineResourceState({
          layout: 'file',
          resourceKind: 'dnaforge.placeholder',
          mediaType: 'application/octet-stream',
          blob: defineBlob(new Uint8Array(0)),
        })
      );
    }
    return must(
      defineResourceState({
        layout: 'directory',
        resourceKind: `dnaforge.${resource.kind}`,
        format:
          resource.kind === 'sequence-package'
            ? 'dnaforge.sequence-package/1'
            : 'dnaforge.notebook-package/1',
        members: [
          {
            memberId: must(parseMemberId('.dnaforge/placeholder')),
            relativePath: must(parseResourcePath('.dnaforge/placeholder')),
            mediaType: 'application/octet-stream',
            blob: defineBlob(new Uint8Array(0)),
          },
        ],
      })
    );
  }
  if (resource.id === SENTINEL_ID) {
    return must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'dnaforge.reconcile-sentinel',
        mediaType: 'application/octet-stream',
        blob: defineBlob(new Uint8Array()),
      })
    );
  }
  if (resource.kind === 'file') {
    const file = resource.files[0];
    if (!file) throw new Error(`Loose file resource ${resource.id} has no file.`);
    return must(
      defineResourceState({
        layout: 'file',
        resourceKind: `dnaforge.${file.kind}`,
        mediaType: file.contentType || 'application/octet-stream',
        blob:
          file.encoding === 'blob'
            ? { hash: must(parseBlobHash(`sha256:${file.sha256}`)), byteLength: file.sizeBytes }
            : defineBlob(decodeBundleFileContent(file)),
      })
    );
  }
  const format =
    resource.kind === 'sequence-package'
      ? 'dnaforge.sequence-package/1'
      : 'dnaforge.notebook-package/1';
  return must(
    defineResourceState({
      layout: 'directory',
      resourceKind: `dnaforge.${resource.kind}`,
      format,
      members: resource.files.map((file) => {
        const relative = file.relativePath.slice(resource.path.length + 1);
        return {
          memberId: must(parseMemberId(resource.memberIds?.get(relative) ?? `path:${relative}`)),
          relativePath: must(parseResourcePath(relative)),
          mediaType: file.contentType || 'application/octet-stream',
          blob:
            file.encoding === 'blob'
              ? { hash: must(parseBlobHash(`sha256:${file.sha256}`)), byteLength: file.sizeBytes }
              : defineBlob(decodeBundleFileContent(file)),
        };
      }),
    })
  );
}

function rememberRevision(
  context: ModelContext,
  graph: RevisionGraph,
  head: WorkspaceVersionId,
  resource: ReconcileResource
): void {
  const slot = currentSlot(graph, head, mustResourceId(resource.id));
  if (!context.revisionContent.has(slot.revisionId)) {
    context.revisionContent.set(slot.revisionId, resource);
  }
}

function currentSlot(graph: RevisionGraph, head: WorkspaceVersionId, resourceId: ResourceId) {
  const slot = inspectWorkspaceResource(graph, head, resourceId);
  if (!slot.ok) {
    throw new Error(`Resource ${resourceId} is not present at ${head}: ${slot.error.kind}`);
  }
  return slot.value;
}

function expectChanged(
  result: ApplyMutationResult,
  label: string
): Extract<ApplyMutationResult, { kind: 'changed' }> {
  if (result.kind === 'changed') return result;
  if (result.kind === 'conflict') {
    throw new Error(
      `${label} conflicted while building history: ${JSON.stringify(result.conflicts)}`
    );
  }
  if (result.kind === 'rejected') {
    throw new Error(`${label} was rejected while building history: ${rejectedReason(result)}`);
  }
  throw new Error(`${label} produced ${result.kind} while building history.`);
}

function rejectedReason(result: Extract<ApplyMutationResult, { kind: 'rejected' }>): string {
  const error = result.error;
  if ('reason' in error && typeof error.reason === 'string') return error.reason;
  return error.kind;
}

function nextOperationId(context: ModelContext, label: string) {
  context.operationCounter.value += 1;
  return must(parseOperationId(`reconcile-${label}-${context.operationCounter.value}`));
}

function relocateResource(
  resource: ReconcileResource,
  path: WorkspacePath | string
): ReconcileResource {
  const destination = String(path);
  if (resource.kind === 'file') return renameLooseFile(resource, destination);
  const files = resource.files.map((file) => {
    const relative = file.relativePath.slice(resource.path.length + 1);
    return {
      ...file,
      relativePath: `${destination}/${relative}`,
      name: relative.split('/').pop() ?? file.name,
    };
  });
  return { ...resource, path: destination, files };
}

function renameLooseFile(resource: ReconcileResource, destination: string): ReconcileResource {
  const file = resource.files[0];
  if (!file) return resource;
  const renamed: WorkspaceSyncFile = {
    ...file,
    relativePath: destination,
    name: destination.split('/').pop() ?? file.name,
  };
  return {
    ...resource,
    id: resource.id === `file:${resource.path}` ? `file:${destination}` : resource.id,
    path: destination,
    files: [renamed],
    contentHash: hashFiles([renamed], null),
  };
}

function labeledCopyPath(
  path: string,
  label: string,
  ...taken: ReadonlyArray<Map<string, ReconcileResource>>
): string {
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const used = new Set<string>();
  for (const set of taken) for (const resource of set.values()) used.add(resource.path);
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const suffix = attempt === 1 ? '' : ` ${attempt}`;
    const candidate = `${directory}${stem} (${label}'s version${suffix})${extension}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Could not choose a name for the second copy.');
}

function safeLabel(label: string): string {
  const cleaned = label
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'shared').slice(0, 40);
}

function sameResource(a: ReconcileResource, b: ReconcileResource): boolean {
  return a.contentHash === b.contentHash && a.path === b.path;
}

function mustWorkspaceId(value: string) {
  return must(parseWorkspaceId(value));
}

function mustResourceId(value: string): ResourceId {
  return must(parseResourceId(value));
}

function mustWorkspacePath(value: string): WorkspacePath {
  return must(parseWorkspacePath(value));
}

function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) {
    throw new Error(`Revision model rejected input: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
