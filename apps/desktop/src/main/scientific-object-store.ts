import type Database from 'better-sqlite3';
import { assertScientificWorkspaceLocalOnly } from './scientific-cloud-admission';
import {
  createRevisionGraph,
  defineBlob,
  inspectResourceRevision,
  inspectResourceState,
  inspectWorkspaceVersion,
  listWorkspaceResources,
  parseOperationId,
  parseRefName,
  parseWorkspaceId,
  parseWorkspacePath,
  parseWorkspaceVersionId,
  type ApplyMutationResult,
  type BlobHash,
  type BlobRef,
  type ImmutableRecordWrite,
  type OperationId,
  type ResourceId,
  type RevisionGraph,
  type WorkspaceMutation,
  type WorkspacePath,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  exportCanonicalClosure,
  importCanonicalRecords,
  type OpaqueCanonicalRecord,
} from '@waypoint/workspace-revisions/codec';
import {
  applyScientificBatch,
  createScientificReader,
  exportScientificHistory,
  serializeScientificHistory,
  validateScientificHistory,
  validateScientificCloudHistory,
  type ScientificCloudHistoryV1,
  type ScientificHistoryV1,
} from '@waypoint/scientific-objects';
import { scientificNativeCodecs } from './scientific-native-codecs';
import {
  nativeScientificHistoryReader,
  validateScientificCloudManifest,
} from '@waypoint/scientific-artifacts';
import type { WorkspaceSyncManifestV1 } from '@waypoint/share-bundle';
import {
  pinScientificHistoryWorkspaceIdentity,
  scientificHistoryWorkspaceIdentity,
} from './scientific-history-identity';

const acceptedRef = parseRefName('accepted');
if (!acceptedRef.ok) throw new Error('Invalid scientific accepted ref.');
const refName = acceptedRef.value;

type RecordRow = { kind: string; id: string; canonicalJson: string };
type RefRow = { name: string; head: string | null };
type LoadedGraph = { graph: RevisionGraph; head: WorkspaceVersionId | null };

const loadedGraphs = new WeakMap<
  Database.Database,
  {
    workspaceId: number;
    identity: string;
    records: readonly RecordRow[];
    refs: readonly RefRow[];
    loaded: LoadedGraph;
  }
>();

export interface ScientificStoreSubmission {
  readonly operationId: OperationId;
  readonly expectedHead: WorkspaceVersionId | null;
  readonly mutations: readonly WorkspaceMutation[];
  readonly blobs: readonly Uint8Array[];

  readonly workingFileHashes?: ReadonlyMap<WorkspacePath, BlobHash | null>;
  readonly completeWorkspace?: boolean;
  readonly missingWorkingFiles?: ReadonlySet<WorkspacePath>;
}

export interface ScientificMaterializationFile {
  readonly path: WorkspacePath;
  readonly resourceId: ResourceId;
  readonly expectedHash: BlobHash | null;
  readonly blob: BlobRef | null;
}

export interface ScientificMaterializationManifest {
  readonly formatVersion: 1;
  readonly files: readonly ScientificMaterializationFile[];
  readonly completeWorkspace?: true;
  readonly missingFiles?: readonly WorkspacePath[];
}

export interface ScientificMaterializationJob {
  readonly version_id: string;
  readonly operation_id: string;
  readonly base_version_id: string | null;
  readonly manifest_json: string;
  readonly status: 'pending' | 'blocked' | 'succeeded';
  readonly progress_json: string;
  readonly last_error: string | null;
  readonly delivery_kind?: 'local-acceptance' | 'history-adoption';
}

interface ScientificHistoryInstallationOptions {
  readonly readBlob: (blob: BlobRef) => Uint8Array | null;
  readonly expectedHead: WorkspaceVersionId | null;
  readonly remoteWorkspaceId?: string;

  readonly manifest?: WorkspaceSyncManifestV1;
  readonly blobRefs?: readonly BlobRef[];

  readonly resolution?: 'fast-forward' | 'replace-and-retain' | 'retain-only';

  readonly binding?: {
    readonly ownerAccountId: string;
    readonly remoteWorkspaceId: string;
    readonly baseVersionId: string | null;
  };
}

export type ScientificHistoryInstallation = ScientificHistoryInstallationOptions &
  (
    | { readonly envelope: unknown; readonly archive?: never }
    | {
        readonly archive: {
          readonly descriptor: ScientificCloudHistoryV1;
          readonly bytes: Uint8Array;
        };
        readonly envelope?: never;
      }
  );

export interface PreparedScientificHistoryInstallation {
  readonly prepared: unique symbol;
}
const preparedInstallations = new WeakMap<
  PreparedScientificHistoryInstallation,
  {
    readonly db: Database.Database;
    readonly workspaceId: number;
    readonly incoming: ReturnType<typeof validateScientificHistory>;
    readonly frozen: ReadonlyMap<string, Uint8Array>;
    readonly digest: string;
    readonly input: ScientificHistoryInstallationOptions;
  }
>();

export interface ScientificHistoryRestoreOwner {
  readonly workspaceUuid: string;
  readonly repoPath: string;
  readonly ownerAccountId: string;
  readonly remoteWorkspaceId: string;
  readonly remoteVersionId: string;
  readonly lockId: string;
}
interface ScientificRestoreAdmission {
  readonly restore: unique symbol;
}
const restoreAdmissions = new WeakMap<
  ScientificRestoreAdmission,
  {
    db: Database.Database;
    workspaceId: number;
    owner: ScientificHistoryRestoreOwner;
  }
>();

export function assertScientificRestoreOwner(
  db: Database.Database,
  workspaceId: number,
  owner: ScientificHistoryRestoreOwner
): void {
  const owned = db
    .prepare(
      `SELECT 1 FROM workspaces w JOIN workspace_sync_restore_locks r ON r.workspace_id=w.id
    WHERE w.id=? AND w.repo_uuid=? AND w.path=? AND w.archived_at IS NOT NULL AND w.trashed_at IS NULL AND r.lock_id=?
      AND r.owner_account_id=? AND r.remote_workspace_id=? AND r.source_remote_version_id=? AND r.status='restoring'`
    )
    .get(
      workspaceId,
      owner.workspaceUuid,
      owner.repoPath,
      owner.lockId,
      owner.ownerAccountId,
      owner.remoteWorkspaceId,
      owner.remoteVersionId
    );
  if (!owned)
    throw new Error('Scientific restore owner no longer matches its private staging intent.');
}

export function createScientificRestoreObjectStore(
  db: Database.Database,
  workspaceId: number,
  owner: ScientificHistoryRestoreOwner
): ScientificObjectStore {
  assertScientificRestoreOwner(db, workspaceId, owner);
  const admission = Object.freeze({}) as ScientificRestoreAdmission;
  restoreAdmissions.set(admission, { db, workspaceId, owner: Object.freeze({ ...owner }) });
  return new ScientificObjectStore(db, workspaceId, admission);
}

export interface ScientificHistoryInstallationResult {
  readonly kind: 'adopted' | 'unchanged' | 'conflict' | 'retained';
  readonly head: WorkspaceVersionId | null;
  readonly incomingHead: WorkspaceVersionId | null;
  readonly retainedRef: string;
  readonly reason?: 'accepted-head-changed' | 'diverged' | 'local-delivery-pending';
}

export function hasAcceptedScientificWorkspace(
  db: Database.Database,
  workspaceId: number
): boolean {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scientific_revision_refs'")
      .get()
  )
    return false;
  const ref = db
    .prepare('SELECT head FROM scientific_revision_refs WHERE workspace_id=? AND ref_name=?')
    .get(workspaceId, refName) as { head: string | null } | undefined;
  return (
    ref?.head != null ||
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM scientific_materialization_jobs WHERE workspace_id=? AND status != 'succeeded' LIMIT 1"
        )
        .get(workspaceId)
    )
  );
}

export class ScientificObjectStore {
  private readonly restoreOwner?: ScientificHistoryRestoreOwner;
  constructor(
    private readonly db: Database.Database,
    readonly workspaceId: number,
    admission?: ScientificRestoreAdmission
  ) {
    if (admission !== undefined) {
      const owned = restoreAdmissions.get(admission);
      if (!owned || owned.db !== db || owned.workspaceId !== workspaceId)
        throw new Error('Scientific restore was not admitted by its database owner.');
      restoreAdmissions.delete(admission);
      this.restoreOwner = owned.owner;
    }
    this.workspace();
  }

  read() {
    return this.db
      .transaction(() => {
        const { graph, head } = this.load();
        return {
          graph,
          head,
          reader: createScientificReader({
            graph,
            head,
            codecs: scientificNativeCodecs,
            readBlob: (blob) => this.readBlob(blob),
          }),
        };
      })
      .deferred();
  }

  catalog() {
    return this.db
      .transaction(() => {
        const { graph, head } = this.load();
        if (head === null) return { head, entries: [] };
        const entries = listWorkspaceResources(graph, head);
        if (!entries.ok)
          throw new Error(`Scientific catalog is invalid: ${JSON.stringify(entries.error)}`);
        return { head, entries: entries.value };
      })
      .deferred();
  }

  exportHistory(): ScientificHistoryV1 {
    return this.db
      .transaction(() => {
        const { graph } = this.load();
        return exportScientificHistory(
          graph,
          nativeScientificHistoryReader((blob) => this.readBlob(blob))
        );
      })
      .deferred();
  }

  installHistory(
    input: ScientificHistoryInstallation,
    onAcceptedInsideTx?: () => undefined
  ): ScientificHistoryInstallationResult {
    return this.installPreparedHistory(this.prepareHistoryInstallation(input), onAcceptedInsideTx);
  }

  prepareHistoryInstallation(
    input: ScientificHistoryInstallation
  ): PreparedScientificHistoryInstallation {
    if (
      input.remoteWorkspaceId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        input.remoteWorkspaceId
      )
    )
      throw new Error('Scientific history cloud workspace identity is invalid.');

    const frozen = new Map<string, Uint8Array>();
    const validator = nativeScientificHistoryReader((blob) => {
      let bytes = frozen.get(blob.hash);
      if (!bytes) {
        const source = input.readBlob(blob);
        if (!source) return null;
        bytes = new Uint8Array(source);
        frozen.set(blob.hash, bytes);
      }
      return bytes;
    });
    const incoming = input.archive
      ? validateScientificCloudHistory(
          input.archive.descriptor,
          new Uint8Array(input.archive.bytes),
          validator
        )
      : validateScientificHistory(input.envelope, validator);
    if (input.manifest)
      validateScientificCloudManifest(incoming.graph, incoming.head, input.manifest);
    if (
      input.blobRefs !== undefined &&
      JSON.stringify(input.blobRefs) !== JSON.stringify(incoming.envelope.blobs)
    )
      throw new Error('Scientific cloud blob inventory differs from its canonical archive.');
    const digest = defineBlob(serializeScientificHistory(incoming.envelope)).hash.slice(
      'sha256:'.length
    );
    const prepared = Object.freeze({}) as PreparedScientificHistoryInstallation;
    preparedInstallations.set(prepared, {
      db: this.db,
      workspaceId: this.workspaceId,
      incoming,
      frozen,
      digest,
      input: Object.freeze({
        readBlob: () => null,
        expectedHead: input.expectedHead,
        remoteWorkspaceId: input.remoteWorkspaceId,
        resolution: input.resolution,
        binding: input.binding ? Object.freeze({ ...input.binding }) : undefined,
      }),
    });
    return prepared;
  }

  installPreparedHistory(
    prepared: PreparedScientificHistoryInstallation,
    onAcceptedInsideTx?: () => undefined,
    beforeWriteInsideTx?: () => undefined
  ): ScientificHistoryInstallationResult {
    const validated = preparedInstallations.get(prepared);
    if (!validated || validated.db !== this.db || validated.workspaceId !== this.workspaceId)
      throw new Error('Scientific history installation was not validated by its database owner.');
    preparedInstallations.delete(prepared);
    const { incoming, frozen, digest, input } = validated;

    const retainedRef = `incoming/${incoming.head ?? 'empty'}`;
    return this.db
      .transaction((): ScientificHistoryInstallationResult => {
        beforeWriteInsideTx?.();
        const workspace = this.workspace();
        if (workspace.access_mode !== 'writable')
          throw new Error('Scientific workspace is read-only.');
        const binding = this.db
          .prepare(
            'SELECT owner_account_id, remote_workspace_id, remote_latest_version_id, enabled FROM workspace_sync_bindings WHERE workspace_id=?'
          )
          .get(this.workspaceId) as
          | {
              owner_account_id: string;
              remote_workspace_id: string | null;
              remote_latest_version_id: string | null;
              enabled: number;
            }
          | undefined;
        if (binding || input.binding) {
          if (
            !binding ||
            !input.binding ||
            binding.enabled !== 1 ||
            binding.owner_account_id !== input.binding.ownerAccountId ||
            binding.remote_workspace_id !== input.binding.remoteWorkspaceId ||
            input.remoteWorkspaceId !== input.binding.remoteWorkspaceId ||
            binding.remote_latest_version_id !== input.binding.baseVersionId
          )
            throw new Error('Scientific history cloud binding changed before acceptance.');
        }
        const before = this.load();
        const existing = exportCanonicalClosure(before.graph);
        if (existing.records.length && existing.workspaceId !== incoming.envelope.graph.workspaceId)
          throw new Error('Scientific history belongs to another logical project.');
        const logical = parseWorkspaceId(incoming.envelope.graph.workspaceId);
        if (!logical.ok) throw new Error('Scientific history logical identity is invalid.');

        pinScientificHistoryWorkspaceIdentity(
          this.db,
          this.workspaceId,
          logical.value,
          input.remoteWorkspaceId
        );
        const refs = new Map(existing.refs.map((ref) => [ref.name, ref.head]));
        refs.set(retainedRef, incoming.head);
        for (const ref of incoming.envelope.graph.refs) {
          if (ref.name === 'accepted') continue;
          if (!refs.has(ref.name) || refs.get(ref.name) === ref.head) refs.set(ref.name, ref.head);
          else {
            const refDigest = defineBlob(new TextEncoder().encode(ref.name)).hash.slice(
              'sha256:'.length
            );
            const target = ref.head ?? 'empty';
            refs.set(`incoming/${refDigest}/${target}`, ref.head);
          }
        }
        const union = importCanonicalRecords({
          formatVersion: 1,
          workspaceId: logical.value,
          records: [...existing.records, ...incoming.envelope.graph.records],
          refs: [...refs].map(([name, head]) => ({ name, head })),
        });
        if (!union.ok) throw new Error(`Scientific history union is invalid: ${union.error.kind}`);
        this.persistReferencedBlobs(
          incoming.envelope.graph.records,
          (blob) => frozen.get(blob.hash) ?? null
        );
        this.persistRecords(incoming.envelope.graph.records);
        const writeRef = this.db.prepare(
          'INSERT INTO scientific_revision_refs (workspace_id, ref_name, head) VALUES (?, ?, ?) ON CONFLICT(workspace_id, ref_name) DO UPDATE SET head=excluded.head'
        );
        for (const [name, head] of refs) writeRef.run(this.workspaceId, name, head);
        if (input.resolution === 'retain-only') {
          if (before.head !== input.expectedHead)
            return {
              kind: 'conflict',
              head: before.head,
              incomingHead: incoming.head,
              retainedRef,
              reason: 'accepted-head-changed',
            };
          return { kind: 'retained', head: before.head, incomingHead: incoming.head, retainedRef };
        }
        if (before.head === incoming.head) {
          onAcceptedInsideTx?.();
          return { kind: 'unchanged', head: before.head, incomingHead: incoming.head, retainedRef };
        }
        const reason =
          before.head !== input.expectedHead
            ? ('accepted-head-changed' as const)
            : this.pendingMaterializations().length
              ? ('local-delivery-pending' as const)
              : (incoming.head === null && before.head !== null) ||
                  (input.resolution !== 'replace-and-retain' &&
                    !isScientificHistoryAncestor(union.value, before.head, incoming.head))
                ? ('diverged' as const)
                : null;
        if (reason)
          return {
            kind: 'conflict',
            head: before.head,
            incomingHead: incoming.head,
            retainedRef,
            reason,
          };

        if (before.head !== null)
          writeRef.run(this.workspaceId, `preserved/${before.head}`, before.head);
        writeRef.run(this.workspaceId, refName, incoming.head);
        if (incoming.head !== null) {
          const operation = parseOperationId(`history-adopt-${digest}-${before.head ?? 'root'}`);
          if (!operation.ok) throw new Error('Scientific history adoption operation is invalid.');
          const manifest = this.materializationManifest(
            before.graph,
            before.head,
            union.value,
            incoming.head
          );
          const now = Date.now();
          this.db
            .prepare(
              `INSERT INTO scientific_materialization_jobs
          (workspace_id, version_id, operation_id, base_version_id, payload_version, delivery_kind, manifest_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, 'history-adoption', ?, 'pending', ?, ?)
          ON CONFLICT(workspace_id, version_id) DO UPDATE SET
            operation_id=excluded.operation_id, base_version_id=excluded.base_version_id,
            delivery_kind=excluded.delivery_kind, manifest_json=excluded.manifest_json,
            status='pending', progress_json='[]', last_error=NULL, updated_at=excluded.updated_at`
            )
            .run(
              this.workspaceId,
              incoming.head,
              operation.value,
              before.head,
              JSON.stringify(manifest),
              now,
              now
            );
        }
        onAcceptedInsideTx?.();
        return { kind: 'adopted', head: incoming.head, incomingHead: incoming.head, retainedRef };
      })
      .immediate();
  }

  submit(
    input: ScientificStoreSubmission,
    onAcceptedInsideTx?: () => undefined
  ): ApplyMutationResult {
    if (this.restoreOwner)
      throw new Error('A scientific restore owner may only adopt verified history.');

    const submitted = new Map<BlobHash, Uint8Array>();
    for (const bytes of input.blobs) {
      const snapshot = new Uint8Array(bytes);
      submitted.set(defineBlob(snapshot).hash, snapshot);
    }
    return this.db
      .transaction(() => {
        assertScientificWorkspaceLocalOnly(this.db, this.workspaceId);
        const workspace = this.workspace();
        if (workspace.access_mode !== 'writable')
          throw new Error('Scientific workspace is read-only.');
        pinScientificHistoryWorkspaceIdentity(
          this.db,
          this.workspaceId,
          scientificHistoryWorkspaceIdentity(this.db, this.workspaceId)
        );
        this.db
          .prepare(
            'INSERT OR IGNORE INTO scientific_revision_refs (workspace_id, ref_name, head) VALUES (?, ?, NULL)'
          )
          .run(this.workspaceId, refName);
        const { graph, head } = this.load();
        const readBlob = (blob: BlobRef) => submitted.get(blob.hash) ?? this.readBlob(blob);
        const result = applyScientificBatch({
          graph,
          refName,
          expectedHead: input.expectedHead,
          operationId: input.operationId,
          mutations: input.mutations,
          readBlob,
          codecs: scientificNativeCodecs,
        });
        if (result.kind === 'replay') {
          if (result.original.outcome === 'changed' || result.original.outcome === 'no-op')
            this.queueMissingWorkingFiles(graph, head, input.missingWorkingFiles);
          return result;
        }
        if (result.kind !== 'changed') {
          this.persistRecords(result.recordWrites);
          this.rememberPersistedGraph(graph, result.graph, head, result.recordWrites);
          if (result.kind === 'no-op') {
            if (input.completeWorkspace && head)
              this.queueMaterialization(
                input.operationId,
                head,
                head,
                this.materializationManifest(
                  graph,
                  head,
                  result.graph,
                  head,
                  input.workingFileHashes,
                  true,
                  input.missingWorkingFiles
                )
              );
            else this.queueMissingWorkingFiles(result.graph, head, input.missingWorkingFiles);
            onAcceptedInsideTx?.();
          }
          return result;
        }
        const plan = result.publication;
        if (plan.refAdvance.expected !== head)
          throw new Error('Scientific publication base mismatch.');
        this.persistReferencedBlobs(plan.recordWrites, readBlob);
        this.persistRecords(plan.recordWrites);
        this.db
          .prepare(
            'INSERT OR IGNORE INTO scientific_revision_refs (workspace_id, ref_name, head) VALUES (?, ?, NULL)'
          )
          .run(this.workspaceId, refName);
        const advanced = this.db
          .prepare(
            'UPDATE scientific_revision_refs SET head = ? WHERE workspace_id = ? AND ref_name = ? AND head IS ?'
          )
          .run(plan.refAdvance.next, this.workspaceId, refName, head);
        if (advanced.changes !== 1)
          throw new Error('Scientific publication lost its accepted ref.');
        const manifest = this.materializationManifest(
          graph,
          head,
          result.graph,
          result.version.id,
          input.workingFileHashes,
          input.completeWorkspace,
          input.missingWorkingFiles
        );
        this.queueMaterialization(input.operationId, head, result.version.id, manifest);

        this.rememberPersistedGraph(graph, result.graph, result.version.id, plan.recordWrites);
        onAcceptedInsideTx?.();
        return result;
      })
      .immediate();
  }

  acceptedWorkingPaths(): readonly WorkspacePath[] {
    const { graph, head } = this.load();
    return [...filesAt(graph, head).keys()];
  }

  private queueMissingWorkingFiles(
    graph: RevisionGraph,
    head: WorkspaceVersionId | null,
    missing: ReadonlySet<WorkspacePath> | undefined
  ): void {
    if (!head || !missing?.size) return;
    const job = this.db
      .prepare(
        `SELECT version_id, operation_id, base_version_id, manifest_json, status, progress_json, last_error, delivery_kind
       FROM scientific_materialization_jobs WHERE workspace_id=? AND version_id=?`
      )
      .get(this.workspaceId, head) as ScientificMaterializationJob | undefined;
    if (!job) throw new Error('Accepted working-file repair has no durable delivery owner.');
    const previous = JSON.parse(job.manifest_json) as ScientificMaterializationManifest;
    this.validateMaterialization(job, previous);
    const paths = new Set([
      ...(job.status === 'succeeded' ? [] : (previous.missingFiles ?? [])),
      ...missing,
    ]);
    const base = job.base_version_id === null ? null : parseWorkspaceVersionId(job.base_version_id);
    if (base !== null && !base.ok) throw new Error('Accepted working-file repair base is invalid.');
    const planned = this.materializationManifest(
      graph,
      base === null ? null : base.value,
      graph,
      head,
      undefined,
      previous.completeWorkspace,
      paths
    );
    const priorFiles = new Map(previous.files.map((file) => [file.path, file]));
    const manifest = {
      ...planned,
      files: planned.files.map((file) =>
        paths.has(file.path) ? file : (priorFiles.get(file.path) ?? file)
      ),
    };
    const completed =
      job.status === 'succeeded'
        ? manifest.files.map((file) => file.path)
        : (JSON.parse(job.progress_json) as WorkspacePath[]);
    this.db
      .prepare(
        `UPDATE scientific_materialization_jobs SET manifest_json=?, progress_json=?, status='pending', last_error=NULL, updated_at=?
       WHERE workspace_id=? AND version_id=?`
      )
      .run(
        JSON.stringify(manifest),
        JSON.stringify(completed.filter((path) => !paths.has(path))),
        Date.now(),
        this.workspaceId,
        head
      );
  }

  pendingMaterializations(): readonly ScientificMaterializationJob[] {
    return this.db
      .prepare(
        `SELECT version_id, operation_id, base_version_id, manifest_json, status, progress_json, last_error, delivery_kind
      FROM scientific_materialization_jobs WHERE workspace_id = ? AND status != 'succeeded' ORDER BY created_at, rowid`
      )
      .all(this.workspaceId) as ScientificMaterializationJob[];
  }

  validateMaterialization(
    job: ScientificMaterializationJob,
    manifest: ScientificMaterializationManifest
  ): void {
    this.db
      .transaction(() => {
        const { graph } = this.load();
        const next = parseWorkspaceVersionId(job.version_id);
        const base =
          job.base_version_id === null ? null : parseWorkspaceVersionId(job.base_version_id);
        if (!next.ok || (base !== null && !base.ok))
          throw new Error('Scientific file delivery version is invalid.');
        const baseId = base === null ? null : base.value;
        const version = inspectWorkspaceVersion(graph, next.value);
        if (manifest.completeWorkspace !== undefined && manifest.completeWorkspace !== true)
          throw new Error('Scientific file delivery mode is invalid.');
        const unchangedRestoration = manifest.completeWorkspace === true && baseId === next.value;
        if (
          !version.ok ||
          (!unchangedRestoration &&
            (job.delivery_kind === 'history-adoption'
              ? baseId !== null && !inspectWorkspaceVersion(graph, baseId).ok
              : version.value.parentIds.length !== (baseId === null ? 0 : 1) ||
                (baseId !== null && version.value.parentIds[0] !== baseId)))
        )
          throw new Error('Scientific file delivery ancestry is invalid.');
        const missing = new Set(manifest.missingFiles ?? []);
        const live = filesAt(graph, next.value);
        if (
          missing.size !== (manifest.missingFiles?.length ?? 0) ||
          [...missing].some((path) => !live.has(path))
        )
          throw new Error('Scientific working-file repair differs from accepted ownership.');
        const accepted = this.materializationManifest(
          graph,
          baseId,
          graph,
          next.value,
          undefined,
          manifest.completeWorkspace,
          missing
        );
        if (accepted.files.length !== manifest.files.length)
          throw new Error('Scientific file delivery differs from its accepted version.');
        for (let index = 0; index < accepted.files.length; index++) {
          const expected = accepted.files[index],
            actual = manifest.files[index];
          if (
            !expected ||
            !actual ||
            expected.path !== actual.path ||
            expected.resourceId !== actual.resourceId ||
            expected.blob?.hash !== actual.blob?.hash ||
            expected.blob?.byteLength !== actual.blob?.byteLength
          )
            throw new Error('Scientific file delivery differs from its accepted version.');
        }
      })
      .deferred();
  }

  workspaceRoot(): string {
    if (this.restoreOwner) this.workspace();
    const row = this.db
      .prepare(
        'SELECT path, access_mode FROM workspaces WHERE id = ? AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .get(this.workspaceId) as { path: string; access_mode: string } | undefined;
    if (!row && this.restoreOwner) {
      const owned = this.workspace();
      if (owned.access_mode !== 'writable')
        throw new Error('Scientific restore workspace is read-only.');
      return this.restoreOwner.repoPath;
    }
    if (!row || row.access_mode !== 'writable')
      throw new Error('Scientific workspace is read-only or missing.');
    return row.path;
  }

  acknowledgeReplayedMetadataWorkingFiles(
    operationId: OperationId,
    observed: ReadonlyMap<WorkspacePath, BlobHash | null>
  ): void {
    this.db
      .transaction(() => {
        this.workspaceRoot();
        const head = this.load().head;
        for (const job of this.pendingMaterializations().filter(
          (job) => job.operation_id === operationId
        )) {
          if (job.version_id !== head)
            throw new Error('Metadata delivery no longer owns the accepted head.');
          const manifest = JSON.parse(job.manifest_json) as ScientificMaterializationManifest;
          this.validateMaterialization(job, manifest);
          for (const path of observed.keys()) {
            if (!manifest.files.some((file) => file.path === path && file.blob !== null))
              throw new Error('Submitted working metadata does not belong to this delivery.');
          }
          const files = manifest.files.map((file) =>
            observed.has(file.path) ? { ...file, expectedHash: observed.get(file.path)! } : file
          );
          const progress = JSON.parse(job.progress_json) as WorkspacePath[];
          const changed = this.db
            .prepare(
              `UPDATE scientific_materialization_jobs
          SET manifest_json=?, progress_json=?, status='pending', last_error=NULL, updated_at=?
          WHERE workspace_id=? AND version_id=? AND operation_id=? AND status!='succeeded'`
            )
            .run(
              JSON.stringify({ ...manifest, files }),
              JSON.stringify(progress.filter((path) => !observed.has(path))),
              Date.now(),
              this.workspaceId,
              job.version_id,
              operationId
            );
          if (changed.changes !== 1)
            throw new Error(
              'Metadata delivery changed before its working bytes were acknowledged.'
            );
        }
      })
      .immediate();
  }

  recordMaterialization(
    versionId: string,
    status: ScientificMaterializationJob['status'],
    progress: readonly WorkspacePath[],
    error: string | null
  ): void {
    const result = this.db
      .prepare(
        `UPDATE scientific_materialization_jobs SET status = ?, progress_json = ?, last_error = ?, updated_at = ?
      WHERE workspace_id = ? AND version_id = ? AND status != 'succeeded'`
      )
      .run(status, JSON.stringify(progress), error, Date.now(), this.workspaceId, versionId);
    if (result.changes !== 1) throw new Error('Scientific file delivery is no longer pending.');
  }

  readBlob(blob: BlobRef): Uint8Array | null {
    const row = this.db
      .prepare(
        'SELECT byte_length, bytes FROM scientific_revision_blobs WHERE workspace_id = ? AND blob_hash = ?'
      )
      .get(this.workspaceId, blob.hash) as { byte_length: number; bytes: Buffer } | undefined;
    if (!row) return null;
    if (row.byte_length !== blob.byteLength || defineBlob(row.bytes).hash !== blob.hash)
      throw new Error(`Scientific blob integrity failure: ${blob.hash}`);
    return row.bytes;
  }

  private workspace() {
    if (this.restoreOwner)
      assertScientificRestoreOwner(this.db, this.workspaceId, this.restoreOwner);
    const row = this.db
      .prepare(
        'SELECT id, repo_uuid, access_mode FROM workspaces WHERE id = ? AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .get(this.workspaceId) as
      | { id: number; repo_uuid: string | null; access_mode: string }
      | undefined;
    if (!row && this.restoreOwner) {
      assertScientificRestoreOwner(this.db, this.workspaceId, this.restoreOwner);
      const staged = this.db
        .prepare(
          'SELECT id,repo_uuid,access_mode FROM workspaces WHERE id=? AND archived_at IS NOT NULL AND trashed_at IS NULL'
        )
        .get(this.workspaceId) as
        | { id: number; repo_uuid: string | null; access_mode: string }
        | undefined;
      if (staged) return staged;
    }
    if (!row) throw new Error('Scientific workspace is not registered.');
    return row;
  }

  private load(): LoadedGraph {
    this.workspace();
    const identity = scientificHistoryWorkspaceIdentity(this.db, this.workspaceId);
    const records = this.db
      .prepare(
        'SELECT record_kind AS kind, record_id AS id, canonical_json AS canonicalJson FROM scientific_revision_records WHERE workspace_id = ? ORDER BY record_id'
      )
      .all(this.workspaceId) as RecordRow[];
    const refs = this.db
      .prepare(
        'SELECT ref_name AS name, head FROM scientific_revision_refs WHERE workspace_id = ? ORDER BY ref_name'
      )
      .all(this.workspaceId) as RefRow[];
    const cached = loadedGraphs.get(this.db);
    if (
      cached?.workspaceId === this.workspaceId &&
      cached.identity === identity &&
      records.length === cached.records.length &&
      refs.length === cached.refs.length &&
      records.every((record, index) => {
        const prior = cached.records[index];
        return (
          prior?.id === record.id &&
          prior.kind === record.kind &&
          prior.canonicalJson === record.canonicalJson
        );
      }) &&
      refs.every((ref, index) => {
        const prior = cached.refs[index];
        return prior?.name === ref.name && prior.head === ref.head;
      })
    )
      return cached.loaded;
    const remember = (loaded: LoadedGraph): LoadedGraph => {
      loadedGraphs.set(this.db, {
        workspaceId: this.workspaceId,
        identity,
        records: records.map((record) => Object.freeze({ ...record })),
        refs: refs.map((ref) => Object.freeze({ ...ref })),
        loaded,
      });
      return loaded;
    };
    if (refs.length === 0 && records.length === 0)
      return remember({
        graph: createRevisionGraph({ workspaceId: identity, acceptedRef: refName }),
        head: null,
      });
    if (!refs.some((ref) => ref.name === refName))
      throw new Error('Scientific accepted history is missing its ref.');
    const graph = importCanonicalRecords({
      formatVersion: 1,
      workspaceId: identity,
      records,
      refs,
    });
    if (!graph.ok) throw new Error(`Scientific accepted history is invalid: ${graph.error.kind}`);
    const rawHead = refs.find((ref) => ref.name === refName)?.head ?? null;
    if (rawHead === null) return remember({ graph: graph.value, head: null });
    const head = parseWorkspaceVersionId(rawHead);
    if (!head.ok) throw new Error('Scientific accepted history has an invalid ref.');
    return remember({ graph: graph.value, head: head.value });
  }

  private persistRecords(writes: readonly OpaqueCanonicalRecord[]): void {
    const select = this.db.prepare(
      'SELECT record_kind, canonical_json FROM scientific_revision_records WHERE workspace_id = ? AND record_id = ?'
    );
    const insert = this.db.prepare(
      'INSERT INTO scientific_revision_records (workspace_id, record_id, record_kind, canonical_json) VALUES (?, ?, ?, ?)'
    );
    for (const write of writes) {
      const previous = select.get(this.workspaceId, write.id) as
        | { record_kind: string; canonical_json: string }
        | undefined;
      if (previous) {
        if (previous.record_kind !== write.kind || previous.canonical_json !== write.canonicalJson)
          throw new Error(`Scientific immutable record collision: ${write.id}`);
      } else insert.run(this.workspaceId, write.id, write.kind, write.canonicalJson);
    }
  }

  private rememberPersistedGraph(
    before: RevisionGraph,
    after: RevisionGraph,
    head: WorkspaceVersionId | null,
    writes: readonly ImmutableRecordWrite[]
  ): void {
    const cached = loadedGraphs.get(this.db);
    if (cached?.workspaceId !== this.workspaceId || cached.loaded.graph !== before) return;
    const records = new Map(cached.records.map((record) => [record.id, record]));
    for (const write of writes) records.set(write.id, Object.freeze({ ...write }));

    loadedGraphs.set(this.db, {
      ...cached,
      records: [...records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      refs: cached.refs.map((ref) =>
        ref.name === refName ? Object.freeze({ ...ref, head }) : ref
      ),
      loaded: { graph: after, head },
    });
  }

  private persistReferencedBlobs(
    writes: readonly OpaqueCanonicalRecord[],
    read: (blob: BlobRef) => Uint8Array | null
  ): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO scientific_revision_blobs (workspace_id, blob_hash, byte_length, bytes) VALUES (?, ?, ?, ?)'
    );
    for (const write of writes) {
      if (write.kind !== 'resource-state') continue;
      const state = JSON.parse(write.canonicalJson) as
        | { layout: 'file'; blob: BlobRef }
        | { layout: 'directory'; members: readonly { blob: BlobRef }[] };
      for (const blob of state.layout === 'file'
        ? [state.blob]
        : state.members.map((member) => member.blob)) {
        const bytes = read(blob);
        if (!bytes || defineBlob(bytes).hash !== blob.hash || bytes.byteLength !== blob.byteLength)
          throw new Error(`Scientific blob unavailable or corrupt: ${blob.hash}`);

        this.readBlob(blob);
        insert.run(this.workspaceId, blob.hash, blob.byteLength, Buffer.from(bytes));
      }
    }
  }

  private queueMaterialization(
    operationId: OperationId,
    base: WorkspaceVersionId | null,
    next: WorkspaceVersionId,
    manifest: ScientificMaterializationManifest
  ): void {
    const now = Date.now();
    const queued = this.db
      .prepare(
        `INSERT INTO scientific_materialization_jobs
        (workspace_id, version_id, operation_id, base_version_id, payload_version, manifest_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, 'pending', ?, ?)
        ON CONFLICT(workspace_id, version_id) DO UPDATE SET
          operation_id=excluded.operation_id, base_version_id=excluded.base_version_id,
          delivery_kind='local-acceptance',
          manifest_json=excluded.manifest_json, status='pending', progress_json='[]',
          last_error=NULL, created_at=excluded.created_at, updated_at=excluded.updated_at
        WHERE scientific_materialization_jobs.status='succeeded'`
      )
      .run(this.workspaceId, next, operationId, base, JSON.stringify(manifest), now, now);
    if (queued.changes !== 1)
      throw new Error('Scientific file delivery is already pending for this accepted version.');
  }

  private materializationManifest(
    before: RevisionGraph,
    base: WorkspaceVersionId | null,
    after: RevisionGraph,
    next: WorkspaceVersionId,
    working?: ReadonlyMap<WorkspacePath, BlobHash | null>,
    completeWorkspace = false,
    missing?: ReadonlySet<WorkspacePath>
  ): ScientificMaterializationManifest {
    const oldFiles = filesAt(before, base),
      nextFiles = filesAt(after, next);
    const files: ScientificMaterializationFile[] = [];
    for (const path of [...new Set([...oldFiles.keys(), ...nextFiles.keys()])].sort()) {
      const old = oldFiles.get(path),
        desired = nextFiles.get(path);
      const repair = desired !== undefined && missing?.has(path);
      if (old?.blob.hash === desired?.blob.hash && !completeWorkspace && !repair) continue;
      const resourceId = desired?.resourceId ?? old?.resourceId;
      if (!resourceId) throw new Error('Scientific file identity missing.');
      files.push({
        path,
        resourceId,
        expectedHash: repair
          ? null
          : working?.has(path)
            ? (working.get(path) ?? null)
            : (old?.blob.hash ?? null),
        blob: desired?.blob ?? null,
      });
    }
    const missingFiles = [...(missing ?? [])].filter((path) => nextFiles.has(path)).sort();
    return {
      formatVersion: 1,
      files,
      ...(completeWorkspace ? { completeWorkspace: true } : {}),
      ...(missingFiles.length ? { missingFiles } : {}),
    };
  }
}

function isScientificHistoryAncestor(
  graph: RevisionGraph,
  base: WorkspaceVersionId | null,
  next: WorkspaceVersionId | null
): boolean {
  if (base === null || base === next) return true;
  if (next === null) return false;
  const pending = [next];
  const seen = new Set<WorkspaceVersionId>();
  while (pending.length) {
    const head = pending.pop();
    if (!head || seen.has(head)) continue;
    if (head === base) return true;
    seen.add(head);
    const version = inspectWorkspaceVersion(graph, head);
    if (!version.ok) throw new Error('Scientific history ancestry is incomplete.');
    pending.push(...version.value.parentIds);
  }
  return false;
}

function filesAt(
  graph: RevisionGraph,
  head: WorkspaceVersionId | null
): Map<WorkspacePath, { resourceId: ResourceId; blob: BlobRef }> {
  const files = new Map<WorkspacePath, { resourceId: ResourceId; blob: BlobRef }>();
  if (head === null) return files;
  const slots = listWorkspaceResources(graph, head);
  if (!slots.ok) throw new Error('Scientific workspace version is missing.');
  for (const slot of slots.value) {
    if (slot.tombstone || !slot.path) continue;
    const revision = inspectResourceRevision(graph, slot.revisionId);
    if (!revision.ok || !revision.value.stateHash)
      throw new Error('Scientific resource revision is missing.');
    const state = inspectResourceState(graph, revision.value.stateHash);
    if (!state.ok) throw new Error('Scientific resource state is missing.');
    if (state.value.layout === 'file')
      files.set(slot.path, { resourceId: slot.resourceId, blob: state.value.blob });
    else
      for (const member of state.value.members) {
        const path = parseWorkspacePath(`${slot.path}/${member.relativePath}`);
        if (!path.ok) throw new Error('Scientific member path is invalid.');
        files.set(path.value, { resourceId: slot.resourceId, blob: member.blob });
      }
  }
  return files;
}
