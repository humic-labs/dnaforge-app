import type {
  WorkspaceSessionFile,
  WorkspaceSessionFileWrite,
  WorkspaceSessionSnapshot,
} from '@waypoint/domain-services';
import {
  isSequencePackageAdmissionMarker,
  parseSequencePackageAdmissionDescriptor,
  SEQUENCE_PACKAGE_ADMISSION_MAX_MARKER_BYTES,
} from '@waypoint/share-bundle/sequence-package-admission';
import {
  defineBlob,
  parseResourceId,
  parseWorkspacePath,
  pathCollisionKey,
  resolveDimension,
  validateMaterializedTree,
  type MaterializedPathEntry,
} from '@waypoint/workspace-revisions';

export interface WorkspaceSessionReconcileConflict {
  readonly resourceId: string;
  readonly kind: 'file' | 'sequence-package';
  readonly reason:
    | 'edit-edit'
    | 'rename-rename'
    | 'delete-edit'
    | 'move-delete'
    | 'identity-conflict'
    | 'path-conflict';
  readonly path: string;
  readonly base: WorkspaceSessionReconcileSide | null;
  readonly local: WorkspaceSessionReconcileSide | null;
  readonly remote: WorkspaceSessionReconcileSide | null;
  readonly reviewFingerprint: string;
}

export interface WorkspaceSessionReconcileSide {
  readonly path: string;
  readonly payloadFingerprint: string;
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly files: readonly WorkspaceSessionFile[];
}

export interface WorkspaceSessionReconcileInput {
  readonly base: WorkspaceSessionSnapshot | null;
  readonly local: WorkspaceSessionSnapshot;
  readonly remote: WorkspaceSessionSnapshot;
  readonly readBytes: (
    snapshot: WorkspaceSessionSnapshot,
    file: WorkspaceSessionFile
  ) => Promise<Uint8Array>;
  readonly choices?: Readonly<
    Record<string, { readonly choice: 'mine' | 'theirs'; readonly reviewFingerprint: string }>
  >;
}

export type WorkspaceSessionReconcileResult =
  | {
      readonly kind: 'merged';
      readonly writes: readonly WorkspaceSessionFileWrite[];
      readonly removePaths: readonly string[];
    }
  | {
      readonly kind: 'conflict';
      readonly reviewFingerprint: string;
      readonly conflicts: readonly WorkspaceSessionReconcileConflict[];
    }
  | { readonly kind: 'invalid'; readonly reason: string };

interface Resource extends WorkspaceSessionReconcileSide {
  readonly resourceId: string;
  readonly kind: 'file' | 'sequence-package';
  readonly snapshot: WorkspaceSessionSnapshot;
}

type Resources = ReadonlyMap<string, Resource>;

export async function reconcileWorkspaceSessionSnapshots(
  input: WorkspaceSessionReconcileInput
): Promise<WorkspaceSessionReconcileResult> {
  try {
    if (
      !input.local.workspaceId ||
      input.local.workspaceId !== input.remote.workspaceId ||
      (input.base && input.base.workspaceId !== input.local.workspaceId)
    ) {
      throw new Error('Reconciliation snapshots must belong to the same workspace.');
    }
    const base = input.base
      ? await groupResources(input.base, input.readBytes)
      : new Map<string, Resource>();
    const local = await groupResources(input.local, input.readBytes);
    const remote = await groupResources(input.remote, input.readBytes);
    const allIds = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort();
    const selected = new Map<string, Resource>();
    const conflicts: WorkspaceSessionReconcileConflict[] = [];

    for (const id of allIds) {
      const before = base.get(id) ?? null;
      const mine = local.get(id) ?? null;
      const theirs = remote.get(id) ?? null;
      const merged = composeResource(before, mine, theirs);
      if ('reason' in merged) {
        const conflict = makeConflict(id, merged.reason, before, mine, theirs);
        const choice = input.choices?.[id];
        if (
          choice?.reviewFingerprint === conflict.reviewFingerprint &&
          (choice.choice === 'mine' || choice.choice === 'theirs')
        ) {
          const chosen = choice.choice === 'mine' ? mine : theirs;
          if (chosen) selected.set(id, chosen);
        } else conflicts.push(conflict);
      } else if (merged.resource) selected.set(id, merged.resource);
    }
    if (conflicts.length) return conflictResult(input.local.workspaceId, conflicts);

    const collisions = selectedTreeCollisions(selected);
    if (collisions.size) {
      const beforeChoices = new Map(selected);
      const pathConflict = (id: string) =>
        makeConflict(
          id,
          'path-conflict',
          base.get(id) ?? null,
          local.get(id) ?? null,
          remote.get(id) ?? null,
          beforeChoices.get(id)?.path
        );
      const unresolved = new Set<string>();
      for (const id of [...collisions].sort()) {
        const conflict = pathConflict(id);
        const choice = input.choices?.[id];
        if (
          choice?.reviewFingerprint === conflict.reviewFingerprint &&
          (choice.choice === 'mine' || choice.choice === 'theirs')
        ) {
          const chosen = choice.choice === 'mine' ? local.get(id) : remote.get(id);
          if (chosen) selected.set(id, chosen);
          else selected.delete(id);
        } else unresolved.add(id);
      }
      for (const id of selectedTreeCollisions(selected)) unresolved.add(id);
      if (unresolved.size)
        return conflictResult(input.local.workspaceId, [...unresolved].sort().map(pathConflict));
    }

    const target = new Map<
      string,
      { readonly resource: Resource; readonly file: WorkspaceSessionFile }
    >();
    for (const resource of selected.values())
      for (const file of resource.files) target.set(file.path, { resource, file });
    const remoteFiles = new Map(input.remote.files.map((file) => [file.path, file]));
    const removePaths = input.remote.files
      .filter((file) => !target.has(file.path))
      .map((file) => file.path)
      .sort();
    const writes: WorkspaceSessionFileWrite[] = [];
    for (const [path, entry] of [...target.entries()].sort(([a], [b]) => compare(a, b))) {
      if (sameFile(remoteFiles.get(path), entry.file)) continue;
      const source = entry.resource.snapshot.files.find(
        (file) => file.resourceId === entry.file.resourceId
      );
      if (!source) throw new Error(`Frozen candidate source is missing: ${path}.`);
      const bytes = await verifiedBytes(entry.resource.snapshot, source, input.readBytes);
      writes.push({
        path,
        resourceId: entry.file.resourceId,
        contentType: entry.file.contentType,
        bytes,
      });
    }
    return { kind: 'merged', writes, removePaths };
  } catch (error) {
    return {
      kind: 'invalid',
      reason: error instanceof Error ? error.message : 'Reconciliation failed safely.',
    };
  }
}

async function groupResources(
  snapshot: WorkspaceSessionSnapshot,
  readBytes: WorkspaceSessionReconcileInput['readBytes']
): Promise<Resources> {
  const byPath = new Map<string, WorkspaceSessionFile>();
  const resourceIds = new Set<string>();
  const entries: MaterializedPathEntry[] = [];
  for (const file of snapshot.files) {
    const path = parseWorkspacePath(file.path);
    if (!path.ok || path.value !== file.path)
      throw new Error(`File path is not portable: ${file.path}.`);
    if (byPath.has(file.path)) throw new Error(`Duplicate file path: ${file.path}.`);
    if (!file.resourceId || !parseResourceId(file.resourceId).ok)
      throw new Error(`File is missing a valid stable identity: ${file.path}.`);
    if (resourceIds.has(file.resourceId))
      throw new Error(`Duplicate file identity: ${file.resourceId}.`);
    if (
      !file.contentSha256 ||
      !/^[a-f0-9]{64}$/u.test(file.contentSha256) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      !file.contentType
    ) {
      throw new Error(`File is missing immutable integrity metadata: ${file.path}.`);
    }
    byPath.set(file.path, file);
    resourceIds.add(file.resourceId);
    entries.push({ owner: file.resourceId, kind: 'file', path: path.value });
  }
  const tree = validateMaterializedTree(entries);
  if (!tree.ok) throw new Error(`Ambiguous portable file tree: ${tree.error.kind}.`);

  const packages: { root: string; id: string; memberIds: ReadonlyMap<string, string> }[] = [];
  const packageIds = new Set<string>();
  for (const file of snapshot.files) {
    if (file.path.toLowerCase().endsWith('/.forge/notebook.json')) {
      throw new Error(
        'Notebook package reconciliation is not supported by this sequence-package workflow.'
      );
    }
    if (!isSequencePackageAdmissionMarker(file.path)) continue;
    if (file.sizeBytes > SEQUENCE_PACKAGE_ADMISSION_MAX_MARKER_BYTES)
      throw new Error(`Package marker exceeds the bounded authority parser: ${file.path}.`);
    const bytes = await verifiedBytes(snapshot, file, readBytes);
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    const authority = parseSequencePackageAdmissionDescriptor(document, file.path);
    if (!authority.ok)
      throw new Error(authority.errors.map((error) => `${error.path}: ${error.message}`).join(' '));
    const descriptor = authority.descriptor;
    if (packageIds.has(descriptor.packageId))
      throw new Error(
        `Duplicate package identity: ${descriptor.packageId}. Copies require new package and file identities.`
      );
    packageIds.add(descriptor.packageId);
    for (const path of descriptor.requiredPaths)
      if (!byPath.has(path))
        throw new Error(`Incomplete package: missing required member ${path}.`);
    const memberIds = new Map([
      [descriptor.markerPath, 'implicit:sequence-marker'],
      [descriptor.productPath, 'implicit:sequence-product'],
      ...descriptor.members.map((member) => [member.path, `member:${member.memberId}`] as const),
    ]);
    packages.push({ root: descriptor.root, id: `seq:${descriptor.packageId}`, memberIds });
  }
  if (packageRootsOverlap(packages.map((pkg) => pkg.root)))
    throw new Error('Ambiguous overlapping or nested sequence package roots.');

  const result = new Map<string, Resource>();
  for (const pkg of packages) {
    const rootKey = `${pathCollisionKey(portablePath(pkg.root))}/`;
    const files = snapshot.files
      .filter((file) => {
        if (file.path.startsWith(`${pkg.root}/`)) return true;
        if (pathCollisionKey(portablePath(file.path)).startsWith(rootKey))
          throw new Error(`Ambiguous portable package placement: ${file.path}.`);
        return false;
      })
      .sort((a, b) => compare(a.path, b.path));
    const payload = files.map((file) => [
      pkg.memberIds.get(file.path) ?? `path:${file.path.slice(pkg.root.length + 1)}`,
      file.path.slice(pkg.root.length + 1),
      file.resourceId,
      file.contentSha256,
      file.sizeBytes,
      file.contentType,
    ]);
    result.set(
      pkg.id,
      makeResource(pkg.id, 'sequence-package', pkg.root, snapshot, files, payload)
    );
  }
  for (const file of snapshot.files) {
    if (packages.some((pkg) => file.path.startsWith(`${pkg.root}/`))) continue;
    const id = `file:${file.resourceId}`;
    result.set(
      id,
      makeResource(
        id,
        'file',
        file.path,
        snapshot,
        [file],
        [file.resourceId, file.contentSha256, file.sizeBytes, file.contentType]
      )
    );
  }
  return result;
}

function makeResource(
  resourceId: string,
  kind: Resource['kind'],
  path: string,
  snapshot: WorkspaceSessionSnapshot,
  files: readonly WorkspaceSessionFile[],
  payload: unknown
): Resource {
  return {
    resourceId,
    kind,
    path,
    snapshot,
    files,
    payloadFingerprint: fingerprint(payload),
    fileCount: files.length,
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
  };
}

function composeResource(
  base: Resource | null,
  local: Resource | null,
  remote: Resource | null
): { resource: Resource | null } | { reason: WorkspaceSessionReconcileConflict['reason'] } {
  if (!local && !remote) return { resource: null };
  if (!base) {
    if (!local || !remote) return { resource: local ?? remote };
    return sameResource(local, remote) ? { resource: remote } : { reason: 'identity-conflict' };
  }
  if (!local || !remote) {
    const survivor = (local ?? remote)!;
    if (sameResource(survivor, base)) return { resource: null };
    return {
      reason:
        survivor.path !== base.path && survivor.payloadFingerprint === base.payloadFingerprint
          ? 'move-delete'
          : 'delete-edit',
    };
  }
  if (local.kind !== remote.kind || local.kind !== base.kind)
    return { reason: 'identity-conflict' };
  const payload = resolveDimension(
    base.payloadFingerprint,
    local.payloadFingerprint,
    remote.payloadFingerprint
  );
  if (payload.kind === 'conflict') return { reason: 'edit-edit' };
  const selected = payload.value === remote.payloadFingerprint ? remote : local;
  const path = resolveDimension(base.path, local.path, remote.path);
  if (path.kind === 'conflict') return { reason: 'rename-rename' };
  return { resource: relocate(selected, path.value) };
}

function relocate(resource: Resource, path: string): Resource {
  if (resource.path === path) return resource;
  return {
    ...resource,
    path,
    files: resource.files.map((file) => ({
      ...file,
      path:
        resource.kind === 'file' ? path : `${path}/${file.path.slice(resource.path.length + 1)}`,
    })),
  };
}

function sameResource(left: Resource, right: Resource): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    left.payloadFingerprint === right.payloadFingerprint
  );
}

function sameFile(left: WorkspaceSessionFile | undefined, right: WorkspaceSessionFile): boolean {
  return (
    !!left &&
    left.path === right.path &&
    left.resourceId === right.resourceId &&
    left.contentSha256 === right.contentSha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.contentType === right.contentType
  );
}

function makeConflict(
  resourceId: string,
  reason: WorkspaceSessionReconcileConflict['reason'],
  base: Resource | null,
  local: Resource | null,
  remote: Resource | null,
  destination?: string
): WorkspaceSessionReconcileConflict {
  const side = (resource: Resource | null): WorkspaceSessionReconcileSide | null =>
    resource
      ? {
          path: resource.path,
          payloadFingerprint: resource.payloadFingerprint,
          fileCount: resource.fileCount,
          sizeBytes: resource.sizeBytes,
          files: resource.files,
        }
      : null;
  const item = {
    resourceId,
    reason,
    kind: (local ?? remote ?? base)!.kind,
    path: destination ?? (local ?? remote ?? base)!.path,
    base: side(base),
    local: side(local),
    remote: side(remote),
  };
  return { ...item, reviewFingerprint: workspaceSessionReconcileConflictFingerprint(item) };
}

export function workspaceSessionReconcileConflictFingerprint(
  item: Omit<WorkspaceSessionReconcileConflict, 'reviewFingerprint'>
): string {
  const side = (value: WorkspaceSessionReconcileSide | null) =>
    value ? [value.path, value.payloadFingerprint] : null;
  return fingerprint([
    item.resourceId,
    item.kind,
    item.reason,
    item.path,
    side(item.base),
    side(item.local),
    side(item.remote),
  ]);
}

function conflictResult(
  workspaceId: string,
  conflicts: readonly WorkspaceSessionReconcileConflict[]
): WorkspaceSessionReconcileResult {
  return {
    kind: 'conflict',
    conflicts,
    reviewFingerprint: fingerprint([workspaceId, conflicts.map((item) => item.reviewFingerprint)]),
  };
}

function selectedTreeCollisions(resources: Resources): Set<string> {
  const conflicts = new Set<string>();
  const packageRoots = [...resources.values()].filter(
    (resource) => resource.kind === 'sequence-package'
  );
  for (const pkg of packageRoots) {
    const rootKey = `${pathCollisionKey(portablePath(pkg.path))}/`;
    for (const resource of resources.values()) {
      if (resource.resourceId === pkg.resourceId) continue;
      if (
        resource.files.some((file) => pathCollisionKey(portablePath(file.path)).startsWith(rootKey))
      ) {
        conflicts.add(pkg.resourceId);
        conflicts.add(resource.resourceId);
      }
    }
  }
  const check = (entries: readonly MaterializedPathEntry[]) => {
    const tree = validateMaterializedTree(entries);
    if (!tree.ok) {
      const paths =
        tree.error.kind === 'path-collision'
          ? tree.error.paths
          : [tree.error.ancestor, tree.error.descendant];
      for (const entry of entries) if (paths.includes(entry.path)) conflicts.add(entry.owner);
    }
  };
  check(
    packageRoots.map((resource) => ({
      owner: resource.resourceId,
      kind: 'file' as const,
      path: portablePath(resource.path),
    }))
  );
  check(
    [...resources.values()].flatMap((resource) => [
      ...(resource.kind === 'sequence-package'
        ? [
            {
              owner: resource.resourceId,
              kind: 'directory' as const,
              path: portablePath(resource.path),
            },
          ]
        : []),
      ...resource.files.map((file) => ({
        owner: resource.resourceId,
        kind: 'file' as const,
        path: portablePath(file.path),
      })),
    ])
  );
  return conflicts;
}

function packageRootsOverlap(roots: readonly string[]): boolean {
  return !validateMaterializedTree(
    roots.map((root, index) => ({ owner: String(index), kind: 'file', path: portablePath(root) }))
  ).ok;
}

function portablePath(path: string) {
  const parsed = parseWorkspacePath(path);
  if (!parsed.ok || parsed.value !== path)
    throw new Error(`Candidate path is not portable: ${path}.`);
  return parsed.value;
}

async function verifiedBytes(
  snapshot: WorkspaceSessionSnapshot,
  file: WorkspaceSessionFile,
  readBytes: WorkspaceSessionReconcileInput['readBytes']
): Promise<Uint8Array> {
  const bytes = await readBytes(snapshot, file);
  if (
    bytes.byteLength !== file.sizeBytes ||
    defineBlob(bytes).hash !== `sha256:${file.contentSha256}`
  ) {
    throw new Error(`Frozen file integrity differs from its manifest: ${file.path}.`);
  }
  return bytes.slice();
}

function fingerprint(value: unknown): string {
  return defineBlob(new TextEncoder().encode(JSON.stringify(value))).hash;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
