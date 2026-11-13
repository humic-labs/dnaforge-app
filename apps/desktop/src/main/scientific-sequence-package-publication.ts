import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, dirname, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  defineBlob,
  defineResourceState,
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  parseResourceId,
  parseWorkspacePath,
  type Result,
  type WorkspaceMutation,
  type WorkspacePath,
  type BlobHash,
} from '@waypoint/workspace-revisions';
import { scientificIdentityPath } from '@waypoint/scientific-objects';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
} from '../db/sequence-package';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { ScientificObjectStore } from './scientific-object-store';
import { materializeScientificWorkspace } from './scientific-object-materializer';
import { scientificWorkspaceIdForRoot } from './scientific-workspace-identity';
import { readAcceptedSequencePackage } from './scientific-sequence-package';
import {
  prepareEnrolledNativeSequenceContent,
  saveEnrolledSequenceDocument,
} from './scientific-sequence-save';
import { findCurrentSequenceEditHead } from './sequence-edit-lineage';
import { submitScientificWorkspace } from './scientific-workspace-service';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { assertWorkspaceMutationLease } from './workspace-sync-mutation-lease';
import { withSequencePackagePublicationOwner } from './sequence-package-publication-owner';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';

const must = <T, E>(value: Result<T, E>): T => {
  if (!value.ok)
    throw new Error(`Invalid accepted package publication: ${JSON.stringify(value.error)}`);
  return value.value;
};
type PublicationFile = { path: string; content: Uint8Array };
type Owner = {
  db: Database.Database;
  workspaceId: number;
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  renderer?: { ownerId: number; mutationToken?: string };
  mutationLease?: () => void;
  staged: Map<string, Uint8Array>;
  publicationPaths?: readonly string[];
};
const owners = new AsyncLocalStorage<Owner>();
const readWorkingBytes = (path: string, expectedBytes = HARD_CAP_BYTES) =>
  readFileBoundedFromHandle(path, Math.min(HARD_CAP_BYTES, Math.max(1, expectedBytes)));

export async function withEnrolledSequencePackagePublication<T>(
  input: Omit<Owner, 'workspaceId' | 'staged' | 'publicationPaths'>,
  operation: () => Promise<T>
): Promise<T> {
  if (
    !input.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scientific_revision_refs'")
      .get()
  )
    return operation();
  const workspaceId = scientificWorkspaceIdForRoot(input.db, input.workspaceRoot);
  if (workspaceId === null) return operation();
  const store = new ScientificObjectStore(input.db, workspaceId);
  const id = must(parseResourceId(input.packageId));
  const current = store.read().reader.current(id);
  if (!current) {
    if (store.catalog().entries.some((entry) => entry.resourceId === id))
      throw new Error('Restore the accepted sequence before editing its package.');
    return operation();
  }
  if (input.mutationLease) assertWorkspaceMutationLease(input.mutationLease, input.workspaceRoot);
  else if (!input.renderer)
    throw new Error('An enrolled native package requires its workspace mutation owner.');
  const releaseDatabase = await acquireWorkspaceSyncDatabaseFence(input.db);
  try {
    const delivery = await materializeScientificWorkspace(store);
    if (delivery.kind !== 'complete')
      throw new Error(`Accepted package delivery is pending: ${delivery.error}`);
    const baseline = acceptedPackage({ ...input, workspaceId });
    if (
      new TextDecoder().decode(
        await readWorkingBytes(
          resolve(input.workspaceRoot, baseline.package.path),
          Buffer.byteLength(baseline.package.text)
        )
      ) !== baseline.package.text ||
      new TextDecoder().decode(
        await readWorkingBytes(
          resolve(input.workspaceRoot, baseline.productPath),
          Buffer.byteLength(baseline.productText)
        )
      ) !== baseline.productText
    )
      throw new Error(
        'Save or submit the external package changes before editing accepted package history.'
      );
  } finally {
    releaseDatabase();
  }
  const owner: Owner = { ...input, workspaceId, staged: new Map() };
  return owners.run(owner, () =>
    withSequencePackagePublicationOwner(
      {
        stageFile: stageAcceptedSequencePackageFile,
        readBytes: readAcceptedSequencePackageBytes,
        prepareProduct: prepareAcceptedSequencePackageProduct,
        publish: publishAcceptedSequencePackage,
      },
      async () => {
        const result = await operation();
        return owner.publicationPaths && result && typeof result === 'object'
          ? { ...result, publicationPaths: [...owner.publicationPaths] }
          : result;
      }
    )
  );
}

function ownerFor(input: { workspaceRoot: string; packageRoot: string }): Owner | undefined {
  const owner = owners.getStore();
  if (
    owner &&
    (resolve(input.workspaceRoot) !== owner.workspaceRoot ||
      resolve(input.packageRoot) !== owner.packageRoot)
  )
    throw new Error('The native package publication left its accepted owner.');
  return owner;
}

export function readAcceptedSequencePackageBytes(path: string): Uint8Array | null {
  const owner = owners.getStore();
  if (!owner) return null;
  const staged = owner.staged.get(resolve(path));
  if (staged) return Uint8Array.from(staged);
  const baseline = acceptedPackage(owner);
  const slot = baseline.slots.find(
    (slot) =>
      slot.path && !slot.tombstone && resolve(owner.workspaceRoot, slot.path) === resolve(path)
  );
  if (!slot) return null;
  const revision = must(inspectResourceRevision(baseline.graph, slot.revisionId));
  if (!revision.stateHash) throw new Error('Accepted package file has no state.');
  const state = must(inspectResourceState(baseline.graph, revision.stateHash));
  if (state.layout !== 'file') throw new Error('Accepted package path is not a file.');
  const bytes = baseline.store.readBlob(state.blob);
  if (!bytes) throw new Error('Accepted package file bytes are unavailable.');
  return Uint8Array.from(bytes);
}

export async function stageAcceptedSequencePackageFile(input: {
  workspaceRoot: string;
  packageRoot: string;
  path: string;
  content: Uint8Array;
}): Promise<boolean> {
  const owner = ownerFor(input);
  if (!owner) return false;
  const safe = await canonicalWorkspacePath({
    workspaceRoot: owner.packageRoot,
    path: input.path,
    allowMissing: true,
    artifactNoun: 'accepted package member',
  });
  const bytes = Uint8Array.from(input.content);
  try {
    const existing = await readWorkingBytes(safe.candidate, bytes.byteLength);
    if (defineBlob(existing).hash !== defineBlob(bytes).hash)
      throw new Error('Immutable accepted package member has conflicting working bytes.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const previous = owner.staged.get(safe.candidate);
  if (previous && defineBlob(previous).hash !== defineBlob(bytes).hash)
    throw new Error('One package proposal contains conflicting member bytes.');
  owner.staged.set(safe.candidate, bytes);
  return true;
}

export function prepareAcceptedSequencePackageProduct(input: {
  workspaceRoot: string;
  packageRoot: string;
  operationId: string;
  content: string;
}): string {
  const owner = ownerFor(input);
  if (!owner) return input.content;
  const baseline = acceptedPackage(owner);
  return prepareEnrolledNativeSequenceContent({
    db: owner.db,
    document: {
      documentId: owner.packageId,
      workspaceRoot: owner.workspaceRoot,
      sourcePath: resolve(owner.workspaceRoot, baseline.productPath),
    },
    content: input.content,
    operationId: input.operationId,
  });
}

export async function publishAcceptedSequencePackage(input: {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  operationId: string;
  beforeMarkerContent: string;
  productContent: string;
  markerContent: string;
  files?: readonly PublicationFile[];
  beforePublish?(): void;
}): Promise<{ publicationPaths: readonly string[] } | null> {
  const owner = ownerFor(input);
  if (!owner) return null;
  const assertPublicationCurrent = () => {
    if (owner.mutationLease) assertWorkspaceMutationLease(owner.mutationLease, owner.workspaceRoot);
    input.beforePublish?.();
  };
  assertPublicationCurrent();
  if (input.packageId !== owner.packageId) throw new Error('Accepted package identity changed.');
  const readOwner = () => ({
    workspace: owner.db
      .prepare(
        'SELECT id,path,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE id=?'
      )
      .get(owner.workspaceId),
    sharing: owner.db
      .prepare(
        'SELECT workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,access_role FROM workspace_sync_bindings WHERE workspace_id=?'
      )
      .get(owner.workspaceId),
    binding: owner.db
      .prepare(
        'SELECT workspace_id,entity_id,path,status FROM catalog_entity_files WHERE entity_id=? ORDER BY id'
      )
      .all(owner.packageId),
  });
  const capturedOwner = readOwner();
  const assertAcceptedOwnerCurrent = () => {
    if (owner.mutationLease) assertWorkspaceMutationLease(owner.mutationLease, owner.workspaceRoot);
    if (!isDeepStrictEqual(readOwner(), capturedOwner))
      throw new Error('The accepted package owner or write access changed before publication.');
  };
  const baseline = acceptedPackage(owner);
  if (input.beforeMarkerContent !== baseline.package.text)
    throw new Error('The package publication is based on another accepted revision.');
  const next = parseSequencePackageDocument(input.markerContent);
  if (
    next.id !== owner.packageId ||
    next.product.file !== basename(baseline.productPath) ||
    next.product.genBankChecksum !== defineBlob(new TextEncoder().encode(input.productContent)).hash
  )
    throw new Error('The prepared accepted marker does not match its exact native product.');
  const files = new Map(owner.staged);
  for (const file of input.files ?? []) {
    const safe = await canonicalWorkspacePath({
      workspaceRoot: owner.packageRoot,
      path: file.path,
      allowMissing: true,
      artifactNoun: 'accepted package member',
    });
    const previous = files.get(safe.candidate);
    if (previous && defineBlob(previous).hash !== defineBlob(file.content).hash)
      throw new Error('The prepared package has conflicting member bytes.');
    files.set(safe.candidate, Uint8Array.from(file.content));
  }
  for (const member of next.members) {
    if (
      member.replaceable ||
      files.has(fromPackageRelative(member.path, owner.packageRoot)) ||
      baseline.slots.some(
        (slot) =>
          !slot.tombstone &&
          slot.path &&
          resolve(owner.workspaceRoot, slot.path) ===
            fromPackageRelative(member.path, owner.packageRoot)
      )
    )
      continue;
    const path = fromPackageRelative(member.path, owner.packageRoot);
    const safe = await canonicalWorkspacePath({
      workspaceRoot: owner.packageRoot,
      path,
      artifactNoun: 'accepted package member',
    });
    files.set(safe.candidate, await readWorkingBytes(safe.candidate));
  }
  const mutations: WorkspaceMutation[] = [];
  const blobs: Uint8Array[] = [];
  const workingFileHashes = new Map<WorkspacePath, BlobHash | null>();
  const publicationPaths = new Set<string>([scientificIdentityPath, baseline.productPath]);
  const add = async (path: string, content: Uint8Array, kind: string, identity?: string) => {
    assertPublicationCurrent();
    const workspacePath = must(
      parseWorkspacePath(relative(owner.workspaceRoot, path).replace(/\\/gu, '/'))
    );
    publicationPaths.add(workspacePath);
    const existing = baseline.slots.find((slot) => slot.path === workspacePath && !slot.tombstone);
    let acceptedHash: BlobHash | null = null;
    let acceptedByteLength = 0;
    const state = must(
      defineResourceState({
        layout: 'file',
        resourceKind: kind,
        mediaType: 'application/octet-stream',
        blob: defineBlob(content),
      })
    );
    if (existing) {
      const revision = must(inspectResourceRevision(baseline.graph, existing.revisionId));
      if (!revision.stateHash) throw new Error('Accepted package member has no state.');
      const old = must(inspectResourceState(baseline.graph, revision.stateHash));
      if (old.layout !== 'file') throw new Error('Accepted package member is not a native file.');
      acceptedHash = old.blob.hash;
      acceptedByteLength = old.blob.byteLength;
      if (old.blob.hash === defineBlob(content).hash) return;
      if (
        workspacePath !== baseline.package.path &&
        resolve(path) !== sequencePackagePaths(owner.packageRoot).revisionJournalPath
      )
        throw new Error('Immutable accepted package member cannot be rewritten.');
      mutations.push({
        kind: 'edit-resource',
        resourceId: existing.resourceId,
        expectedRevision: existing.revisionId,
        state,
      });
    } else {
      const resourceId = must(
        parseResourceId(
          identity ??
            `sequence-member:${defineBlob(new TextEncoder().encode(`${owner.packageId}:${workspacePath}`)).hash.slice('sha256:'.length)}`
        )
      );
      mutations.push({
        kind: 'create-resource',
        resourceId,
        path: workspacePath,
        state,
        origin: { kind: 'created' },
      });
    }
    blobs.push(content);
    try {
      const observed = await readWorkingBytes(
        path,
        Math.max(content.byteLength, acceptedByteLength)
      );
      if (existing && defineBlob(observed).hash !== acceptedHash)
        throw new Error(`Unsubmitted working change at ${workspacePath}`);
      if (!existing && defineBlob(observed).hash !== defineBlob(content).hash)
        throw new Error('A working file occupies the new accepted package member path.');
      workingFileHashes.set(workspacePath, defineBlob(observed).hash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      workingFileHashes.set(workspacePath, null);
    }
  };
  await add(
    resolve(owner.workspaceRoot, baseline.package.path),
    new TextEncoder().encode(input.markerContent),
    `dnaforge.sequence-package.v${next.formatVersion}`,
    baseline.package.resourceId
  );
  for (const [path, content] of files)
    await add(
      path,
      content,
      next.members.some(
        (m) =>
          m.role === 'sequence-snapshot' && fromPackageRelative(m.path, owner.packageRoot) === path
      )
        ? 'dnaforge.sequence-product-snapshot.v1'
        : 'dnaforge.sequence-package-member.v1'
    );
  const publication = {
    mutations,
    blobs,
    snapshotPaths: [...publicationPaths]
      .filter(
        (path) =>
          path !== baseline.productPath &&
          path !== scientificIdentityPath &&
          path !== baseline.package.path
      )
      .map((path) => must(parseWorkspacePath(path))),
    workingFileHashes,
  };
  if (input.productContent !== baseline.productText) {
    const before = parseSequenceFileAsDocument(
      baseline.productText,
      resolve(owner.workspaceRoot, baseline.productPath)
    ).sequence;
    const after = parseSequenceFileAsDocument(
      input.productContent,
      resolve(owner.workspaceRoot, baseline.productPath)
    ).sequence;
    before.id = after.id = owner.packageId;
    const basesChanged = before.sequence !== after.sequence;
    const result = await saveEnrolledSequenceDocument({
      db: owner.db,
      document: {
        documentId: owner.packageId,
        workspaceRoot: owner.workspaceRoot,
        sourcePath: resolve(owner.workspaceRoot, baseline.productPath),
      },
      renderer: owner.renderer,
      mutationLease: owner.mutationLease,
      beforeAccept: assertAcceptedOwnerCurrent,
      nativeContent: input.productContent,
      packagePublication: publication,
      request: {
        documentId: owner.packageId,
        sourcePath: resolve(owner.workspaceRoot, baseline.productPath),
        capture: {
          sequence: after,
          draftBaseline: {
            sequence: before.sequence,
            length: before.length,
            circular: !!before.circular,
          },
          draftSequence: basesChanged ? before.sequence + after.sequence : after.sequence,
          insertedRanges:
            basesChanged && after.length
              ? [{ start: before.length, end: before.length + after.length }]
              : [],
          deletedRanges: basesChanged && before.length ? [{ start: 0, end: before.length }] : [],
          substitutedRanges: [],
          draftLineageId: input.operationId,
        },
        accepted: {
          operationId: input.operationId,
          expectedHead: baseline.head,
          expectedRevisionId: baseline.productRevision,
          parentEventId:
            findCurrentSequenceEditHead(
              owner.db,
              baseline.resourceId,
              defineBlob(new TextEncoder().encode(baseline.productText)).hash
            )?.id ?? null,
          createdAt:
            next.versionHistory.revisions.find((r) => r.id === next.versionHistory.headId)
              ?.createdAt ?? new Date().toISOString(),
        },
      },
    });
    if (!result || result.status !== 'saved')
      throw new Error(
        `Package revision accepted; delivery remains pending: ${result?.status === 'accepted-pending' ? result.reason : 'native binding unavailable'}`
      );
    owner.publicationPaths = [
      ...new Set([...publicationPaths, ...(result.publicationPaths ?? [])]),
    ];
  } else {
    const entries = baseline.slots.flatMap((slot) => {
      if (!slot.path || slot.tombstone) return [];
      const snapshot = baseline.reader.current(slot.resourceId);
      return snapshot
        ? [
            {
              resourceId: slot.resourceId,
              path: slot.path,
              ...(snapshot.representation
                ? { representation: snapshot.representation }
                : { document: snapshot.document }),
            },
          ]
        : [];
    });
    const result = await submitScientificWorkspace({
      db: owner.db,
      workspaceId: owner.workspaceId,
      renderer: owner.renderer,
      mutationLease: owner.mutationLease,
      beforeAccept: assertAcceptedOwnerCurrent,
      request: {
        operationId: input.operationId,
        expectedHead: baseline.head,
        source: { kind: 'documents', entries },
      },
      publication: { ...publication, onAcceptedInsideTx: () => undefined },
    });
    if (
      result.acceptance.kind !== 'changed' &&
      result.acceptance.kind !== 'no-op' &&
      result.acceptance.kind !== 'replay'
    )
      throw new Error(`Package revision was not accepted: ${result.acceptance.kind}`);
    if (result.delivery?.kind !== 'complete')
      throw new Error(
        `Package revision accepted; delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'unavailable'}`
      );
    owner.publicationPaths = [...publicationPaths];
  }
  return { publicationPaths: owner.publicationPaths };
}

function acceptedPackage(input: Omit<Owner, 'staged'>) {
  const store = new ScientificObjectStore(input.db, input.workspaceId);
  const { graph, head, reader } = store.read();
  const resourceId = must(parseResourceId(input.packageId));
  const product = reader.current(resourceId);
  if (
    !head ||
    !product ||
    product.document.kind !== 'sequence' ||
    product.representation?.format !== 'genbank-v1'
  )
    throw new Error('Accepted native package product is unavailable.');
  const slots = must(listWorkspaceResources(graph, head));
  const slot = slots.find((s) => s.resourceId === resourceId && !s.tombstone);
  if (!slot?.path || resolve(input.workspaceRoot, dirname(slot.path)) !== input.packageRoot)
    throw new Error('Accepted package root no longer matches its product.');
  const metadata = readAcceptedSequencePackage({
    store,
    graph,
    head,
    sequenceId: resourceId,
    productPath: slot.path,
    productText: product.representation.text,
  });
  if (!metadata) throw new Error('The accepted managed sequence has no package metadata.');
  return {
    store,
    graph,
    head,
    reader,
    slots,
    resourceId,
    productPath: slot.path,
    productText: product.representation.text,
    productRevision: product.revisionId,
    package: metadata,
  };
}
