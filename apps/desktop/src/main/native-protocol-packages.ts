import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import {
  canonicalProtocolJson,
  parseProtocolPackage,
  parseProtocolPackageForDisplay,
  protocolExecutionDefinition,
  parseWorkspaceIdentity,
  parseScientificDocumentIdentity,
} from '@waypoint/domain-services';
import {
  protocolCreateSchema,
  protocolStartRunSchema,
  protocolCreationInspectSchema,
  protocolPackageReadSchema,
  protocolPackageListSchema,
  protocolPackageSaveSchema,
  type NativeProtocolCreationResult,
  type NativeProtocolPackageSnapshot,
  type ProtocolRunSavedSource,
  type NativeProtocolPackageChanged,
} from '../shared/protocol-packages';
import { scopedProjectionId, stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { scientificPackageMetaPath } from '../shared/scientific-package';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import {
  withKnownWorkspacePathMutation,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import type { RegisteredProjectAuthority, RegisteredProject } from './registered-project-authority';
import type { NativeDocumentWorkspaces } from './native-document-workspaces';
import { readWorkspaceSyncAccessBinding } from './workspace-sync-access-record';
import { assertAcceptingSharedProjectContentWritable } from './shared-project-write-access';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import {
  recordCatalogEventInDb,
  updateCatalogEntityPresentationInDb,
} from './catalog-association-commands';
import { syncDirectory } from './fs-durability';
import { readScientificDocumentInMain } from './scientific-document-reader';

const MAX_BYTES = 16 * 1024 * 1024;
const hash = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const jsonHash = (value: unknown) => hash(canonicalProtocolJson(value));
type RecordValue = Record<string, unknown>;
interface Receipt {
  version: 1;
  requestId: string;
  intentSha256: string;
  operation: 'create' | 'save';
  phase: 'prepared' | 'published' | 'ready';
  projectId: string;
  root: string;
  entityId: string;
  portableId: string;
  fileObjectUuid: string;
  path: string;
  kind: 'protocol' | 'protocol-run';
  text: string;
  at: number;
  actor: string;
  expectedFileSha256: string | null;
  protocolSource: NativeProtocolPackageSnapshot | null;
}
interface Binding {
  id: string;
  type: string;
  name: string;
  status: string;
  workspace_id: number;
  file_id: string;
  path: string;
  file_kind: string;
  file_status: string;
  object_uuid: string;
}
export interface ProtocolSavedSourceCapture {
  source: ProtocolRunSavedSource;
  sourceSha256: `sha256:${string}`;
  assertCurrent(): void;
}
export interface NativeProtocolInvocation {
  actor?: string;
  beforeCommit?(): Promise<void>;
  assertCurrent?(): void;
}
export function createNativeProtocolPackages(options: {
  db(): Database.Database;
  projectAuthority: RegisteredProjectAuthority;
  workspaces: NativeDocumentWorkspaces;
  profileDirectory(): string;
  actor(): string;
  onCommitted?(change: NativeProtocolPackageChanged): void;
  afterFilePublished?(receipt: Readonly<Receipt>): void;
  beforeCatalogCommit?(receipt: Readonly<Receipt>): void;
}) {
  const inFlight = new Map<
    string,
    { intent: string; promise: Promise<NativeProtocolCreationResult> }
  >();
  const directory = () => join(options.profileDirectory(), 'protocol-package-operations');
  const notifyCommitted = (receipt: Receipt) => {
    try {
      options.onCommitted?.({
        projectId: receipt.projectId,
        entityId: receipt.entityId,
        workspaceRoot: receipt.root,
        path: receipt.path,
        operation: receipt.operation,
      });
    } catch (error) {
      console.warn('[ProtocolPackages] Committed package notification failed:', error);
    }
  };
  const receiptPath = (project: string, requestId: string) =>
    join(directory(), hash(`${project}\0${requestId}`).slice(7) + '.json');
  const writeReceipt = async (receipt: Receipt) => {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const target = receiptPath(receipt.projectId, receipt.requestId),
      temporary = target + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(receipt));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
      await syncDirectory(directory());
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  const loadReceipt = async (project: string, requestId: string): Promise<Receipt | null> => {
    try {
      const value = JSON.parse(await readFile(receiptPath(project, requestId), 'utf8')) as Receipt;
      if (
        value.version !== 1 ||
        value.projectId !== project ||
        value.requestId !== requestId ||
        !['create', 'save'].includes(value.operation) ||
        !['prepared', 'published', 'ready'].includes(value.phase)
      )
        throw new Error('PROTOCOL_RECOVERY_INVALID');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const admit = (reference: string, mutating: boolean) => {
    const project = options.projectAuthority.resolve(reference);
    if (!project || (mutating && project.pinned))
      throw new Error('PROJECT_ACCESS_DENIED: Protocol project unavailable.');
    const roots = mutating ? options.workspaces.roots() : options.workspaces.readableRoots();
    if (!roots.some((root) => workspaceMutationRootIdentity(root) === project.path))
      throw new Error('PROJECT_ACCESS_DENIED: Protocol project unavailable.');
    const assertAuthority = mutating
      ? options.workspaces.capture(project.path)
      : options.workspaces.captureReadable(project.path);
    const db = options.db();
    const projectRow = () =>
      db
        .prepare(
          'SELECT id,path,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE id=?'
        )
        .get(project.id) as RecordValue | undefined;
    const row = projectRow();
    const access = () =>
      row?.repo_uuid ? readWorkspaceSyncAccessBinding(db, String(row.repo_uuid)) : null;
    const authoritySha = jsonHash({ row, access: access() });
    const assertCaptured = () => {
      if (
        jsonHash({ row: projectRow(), access: access() }) !== authoritySha ||
        workspaceMutationRootIdentity(project.path) !== project.path ||
        lstatSync(project.path).isSymbolicLink()
      )
        throw new Error('PROJECT_ACCESS_CHANGED: Protocol project authority changed.');
      if (mutating && db.inTransaction)
        assertAcceptingSharedProjectContentWritable(db, project.path);
    };
    assertAuthority();
    assertCaptured();
    return { project, assertAuthority, assertCaptured };
  };
  const refs = (project: RegisteredProject) => {
    const db = options.db();
    return db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scientific_revision_refs'")
      .get()
      ? db
          .prepare(
            'SELECT ref_name,head FROM scientific_revision_refs WHERE workspace_id=? ORDER BY ref_name'
          )
          .all(project.id)
      : [];
  };
  const binding = (entityId: string): Binding => {
    const rows = options
      .db()
      .prepare(
        "SELECT e.id,e.type,e.name,e.status,e.workspace_id,f.id AS file_id,f.path,f.file_kind,f.status AS file_status,f.object_uuid FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id WHERE e.id=? AND f.status='current' ORDER BY f.id"
      )
      .all(entityId) as Binding[];
    if (rows.length !== 1)
      throw new Error('PROTOCOL_BINDING_UNAVAILABLE: Expected one current saved package binding.');
    return rows[0];
  };
  const guardFile = (root: string, path: string, bytes: Buffer) => {
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_BYTES ||
      realpathSync(path) !== path ||
      !relative(root, path) ||
      relative(root, path).startsWith('..')
    )
      throw new Error('PROTOCOL_SOURCE_INVALID: Saved source is not an owned regular file.');
    if (!readFileSync(path).equals(bytes))
      throw new Error('PROTOCOL_SOURCE_CHANGED: Saved source bytes changed.');
  };
  const sourcePacket = (
    snapshot: Omit<
      NativeProtocolPackageSnapshot,
      'sourceSha256' | 'definitionSha256' | 'creationRequestId'
    >
  ) =>
    snapshot.kind === 'protocol-run'
      ? {
          schema: 'dnaforge.protocol-run-saved-source.v1' as const,
          projectId: snapshot.projectId,
          workspaceScope: snapshot.workspaceScope,
          runId: snapshot.entityId,
          fileObjectUuid: snapshot.fileObjectUuid,
          title: snapshot.title,
          originalText: snapshot.originalText,
        }
      : {
          schema: 'dnaforge.protocol-saved-source.v1' as const,
          projectId: snapshot.projectId,
          workspaceScope: snapshot.workspaceScope,
          protocolId: snapshot.entityId,
          fileObjectUuid: snapshot.fileObjectUuid,
          title: snapshot.title,
          originalText: snapshot.originalText,
        };
  const capture = async (reference: string, entityId: string, allowDisplayFallback = false) => {
    const scope = admit(reference, false),
      before = binding(entityId),
      beforeSha = jsonHash(before),
      beforeRefs = jsonHash(refs(scope.project));
    if (
      before.status !== 'active' ||
      before.workspace_id !== scope.project.id ||
      !before.object_uuid ||
      !['protocol', 'protocol_run'].includes(before.type) ||
      before.file_kind !==
        (before.type === 'protocol' ? 'waypoint-protocol' : 'waypoint-protocol-run')
    )
      throw new Error('PROTOCOL_BINDING_UNAVAILABLE: Saved package owner changed.');
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: scope.project.path,
      path: before.path,
      artifactNoun: 'protocol package',
    });
    if (canonical.candidate !== before.path)
      throw new Error('PROTOCOL_BINDING_UNAVAILABLE: Saved package path is not canonical.');
    if (lstatSync(before.path).size > MAX_BYTES) throw new Error('PROTOCOL_SOURCE_TOO_LARGE');
    const bytes = readFileSync(before.path);
    guardFile(scope.project.path, before.path, bytes);
    const originalText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let readOnly = false,
      document;
    try {
      document = parseProtocolPackage(originalText);
    } catch (error) {
      if (!allowDisplayFallback) throw error;
      document = parseProtocolPackageForDisplay(originalText);
      readOnly = true;
    }
    const portableId = stripWorkspaceScope(document.id);
    if (
      scopedProjectionId(scope.project.projectId, portableId) !== entityId ||
      (document.kind === 'protocol') !== (before.type === 'protocol')
    )
      throw new Error(
        'PROTOCOL_IDENTITY_MISMATCH: Saved package identity differs from its catalog binding.'
      );
    const read = await readScientificDocumentInMain(
      {
        operationId: randomUUID(),
        workspaceRoot: scope.project.path,
        workspace: parseWorkspaceIdentity(scope.project.projectId),
        document: parseScientificDocumentIdentity(
          relative(scope.project.path, before.path).replace(/\\/g, '/')
        ),
      },
      { database: options.db() }
    );
    if (!read.ok || read.document.revision.kind !== 'local-file')
      throw new Error(
        'PROTOCOL_ACCEPTED_SOURCE_UNSUPPORTED: Use the existing accepted source authority for this package.'
      );
    const frozen = document.raw.frozenProtocol as RecordValue | undefined;
    if (frozen) {
      const source = frozen.source as RecordValue;
      const definition = protocolExecutionDefinition(String(source.originalText));
      if (
        frozen.definitionSha256 !== definition.definitionSha256 ||
        source.fileSha256 !== hash(String(source.originalText)) ||
        frozen.schema !== 'dnaforge.protocol-execution-snapshot.v1'
      )
        throw new Error('PROTOCOL_FROZEN_SOURCE_INVALID');
    }
    const creation = document.raw.creation as RecordValue | undefined;
    if (creation) {
      if (creation.portableId !== portableId)
        throw new Error('PROTOCOL_CREATION_IDENTITY_MISMATCH');
      const retained = await loadReceipt(scope.project.projectId, String(creation.requestId));
      if (
        retained &&
        (retained.fileObjectUuid !== before.object_uuid ||
          retained.entityId !== entityId ||
          canonicalProtocolJson(parseProtocolPackage(retained.text).raw.creation) !==
            canonicalProtocolJson(creation) ||
          canonicalProtocolJson(parseProtocolPackage(retained.text).raw.frozenProtocol ?? null) !==
            canonicalProtocolJson(frozen ?? null))
      )
        throw new Error('PROTOCOL_CREATION_ANCHOR_CHANGED');
    }
    const base = {
      readOnly,
      projectId: scope.project.projectId,
      workspaceScope: scope.project.projectId,
      entityId,
      portableId,
      fileObjectUuid: before.object_uuid,
      kind: before.type === 'protocol' ? ('protocol' as const) : ('protocol-run' as const),
      title: document.title,
      path: before.path,
      originalText,
      fileSha256: hash(bytes),
    };
    const packet = sourcePacket(base),
      snapshot: NativeProtocolPackageSnapshot = {
        ...base,
        sourceSha256: jsonHash(packet),
        creationRequestId: creation ? String(creation.requestId) : null,
        definitionSha256:
          !readOnly &&
          document.kind === 'protocol' &&
          !(
            document.raw.paperProtocol &&
            (document.raw.paperProtocol as RecordValue).draft &&
            ((document.raw.paperProtocol as RecordValue).draft as RecordValue).state !== 'finalized'
          )
            ? protocolExecutionDefinition(originalText).definitionSha256
            : null,
      };
    const assertCurrent = () => {
      scope.assertCaptured();
      if (jsonHash(binding(entityId)) !== beforeSha || jsonHash(refs(scope.project)) !== beforeRefs)
        throw new Error(
          'PROTOCOL_SOURCE_CHANGED: Saved source binding or accepted authority changed.'
        );
      guardFile(scope.project.path, before.path, bytes);
    };
    scope.assertAuthority();
    assertCurrent();
    return { snapshot, packet, assertCurrent };
  };
  const packagePath = async (
    project: RegisteredProject,
    parentPath: string | undefined,
    title: string,
    portableId: string,
    kind: Receipt['kind']
  ) => {
    const parent = parentPath ?? project.path;
    const canonical =
      parent === project.path
        ? { candidate: parent }
        : await canonicalWorkspacePath({
            workspaceRoot: project.path,
            path: parent,
            artifactNoun: 'protocol destination',
          });
    if (
      !lstatSync(canonical.candidate).isDirectory() ||
      relative(project.path, canonical.candidate)
        .split(/[\\/]/)
        .some((part) => ['..', '.git', '.forge', '.waypoint', '.dnaforge'].includes(part))
    )
      throw new Error('PROTOCOL_DESTINATION_INVALID');
    const stem =
      title
        .replace(/[/:\\?%*"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 80)
        .replace(/^\.+/, '') || 'Protocol';
    return join(
      project.path,
      scientificPackageMetaPath(
        relative(project.path, join(canonical.candidate, stem + '-' + portableId.slice(-8))),
        kind
      )
    );
  };
  const runReceipt = async (
    receipt: Receipt,
    invocation: NativeProtocolInvocation = {}
  ): Promise<NativeProtocolCreationResult> => {
    const scope = admit(receipt.projectId, false);
    if (
      scope.project.path !== receipt.root ||
      scopedProjectionId(receipt.projectId, receipt.portableId) !== receipt.entityId
    )
      throw new Error('PROTOCOL_RECOVERY_OWNER_CHANGED');
    const ready = async (): Promise<NativeProtocolCreationResult> => {
      const document = parseProtocolPackage(receipt.text),
        creation = document.raw.creation as RecordValue | undefined;
      const base = {
        readOnly: false,
        projectId: receipt.projectId,
        workspaceScope: receipt.projectId,
        entityId: receipt.entityId,
        portableId: receipt.portableId,
        fileObjectUuid: receipt.fileObjectUuid,
        kind: receipt.kind,
        title: document.title,
        path: receipt.path,
        originalText: receipt.text,
        fileSha256: hash(receipt.text),
      };
      const snapshot: NativeProtocolPackageSnapshot = {
        ...base,
        sourceSha256: jsonHash(sourcePacket(base)),
        creationRequestId: creation ? String(creation.requestId) : null,
        definitionSha256:
          document.kind === 'protocol' &&
          !(
            document.raw.paperProtocol &&
            ((document.raw.paperProtocol as RecordValue).draft as RecordValue).state !== 'finalized'
          )
            ? protocolExecutionDefinition(receipt.text).definitionSha256
            : null,
      };
      let currentAvailability: NonNullable<
        Extract<NativeProtocolCreationResult, { kind: 'ready' }>['currentAvailability']
      >;
      try {
        const current = (await capture(receipt.projectId, receipt.entityId)).snapshot;
        currentAvailability =
          current.fileObjectUuid === receipt.fileObjectUuid
            ? { kind: 'available', path: current.path, sourceSha256: current.sourceSha256 }
            : { kind: 'unavailable', message: 'The original package binding is unavailable.' };
      } catch (error) {
        currentAvailability = {
          kind: 'unavailable',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      scope.assertAuthority();
      return {
        kind: 'ready',
        requestId: receipt.requestId,
        package: snapshot,
        currentAvailability,
      };
    };
    if (receipt.phase === 'ready') return ready();
    const accepted = options
      .db()
      .prepare(
        'SELECT entity_id,event_type,actor,payload,created_at FROM catalog_entity_events WHERE id=?'
      )
      .get(hash(`${receipt.projectId}\0${receipt.requestId}`).slice(7)) as
      | {
          entity_id: string;
          event_type: string;
          actor: string;
          payload: string;
          created_at: number;
        }
      | undefined;
    if (accepted) {
      if (
        accepted.entity_id !== receipt.entityId ||
        accepted.event_type !== (receipt.operation === 'create' ? 'created' : 'edited') ||
        accepted.actor !== receipt.actor ||
        accepted.created_at !== receipt.at ||
        canonicalProtocolJson(JSON.parse(accepted.payload)) !==
          canonicalProtocolJson({
            requestId: receipt.requestId,
            intentSha256: receipt.intentSha256,
          })
      )
        throw new Error('PROTOCOL_RECOVERY_EVENT_CONFLICT');
      const saved = await ready();
      receipt.phase = 'ready';
      await writeReceipt(receipt);
      notifyCommitted(receipt);
      return saved;
    }
    const writable = admit(receipt.projectId, true);
    return withKnownWorkspacePathMutation(options.db(), [receipt.root], async () => {
      let published = receipt.phase === 'published';
      let assertProtocol = () => {};
      try {
        writable.assertAuthority();
        invocation.assertCurrent?.();
        await invocation.beforeCommit?.();
        let current: Buffer | null = null;
        try {
          current = readFileSync(receipt.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (current?.equals(Buffer.from(receipt.text))) published = true;
        if (!published) {
          if (receipt.operation === 'create' && current)
            throw new Error('PROTOCOL_DESTINATION_EXISTS');
          if (
            receipt.operation === 'save' &&
            (!current || hash(current) !== receipt.expectedFileSha256)
          )
            throw new Error('PROTOCOL_SAVE_SOURCE_CHANGED');
          if (receipt.protocolSource) {
            const source = await capture(receipt.projectId, receipt.protocolSource.entityId);
            if (source.snapshot.sourceSha256 !== receipt.protocolSource.sourceSha256)
              throw new Error('PROTOCOL_SOURCE_CHANGED');
            source.assertCurrent();
            assertProtocol = source.assertCurrent;
          }
          writable.assertAuthority();
          invocation.assertCurrent?.();
          await writeWorkspaceTextFileAtomicInMain(
            {
              workspaceRoot: receipt.root,
              path: receipt.path,
              content: receipt.text,
              mode: receipt.operation === 'create' ? 'create' : 'replace',
              ...(receipt.expectedFileSha256
                ? { expectedContentHash: receipt.expectedFileSha256.slice(7) }
                : {}),
              artifactNoun: 'protocol package',
            },
            {
              durable: true,
              beforePublish: () => {
                writable.assertAuthority();
                invocation.assertCurrent?.();
                assertProtocol();
              },
            }
          );
          published = true;
          receipt.phase = 'published';
          await writeReceipt(receipt);
          options.afterFilePublished?.(receipt);
        }
        guardFile(receipt.root, receipt.path, Buffer.from(receipt.text));
        writable.assertAuthority();
        invocation.assertCurrent?.();
        await invocation.beforeCommit?.();
        const db = options.db();
        db.transaction(() => {
          const guard = () => {
            writable.assertCaptured();
            invocation.assertCurrent?.();
            assertProtocol();
            guardFile(receipt.root, receipt.path, Buffer.from(receipt.text));
          };
          guard();
          options.beforeCatalogCommit?.(receipt);
          guard();
          const existing = db
            .prepare(
              'SELECT id,type,workspace_id,locator FROM catalog_entities WHERE id=? OR locator=?'
            )
            .all(receipt.entityId, `file://${receipt.path}`) as Array<{
            id: string;
            type: string;
            workspace_id: number;
            locator: string;
          }>;
          if (
            existing.some(
              (row) =>
                row.id !== receipt.entityId ||
                row.workspace_id !== scope.project.id ||
                row.type !== (receipt.kind === 'protocol' ? 'protocol' : 'protocol_run') ||
                row.locator !== `file://${receipt.path}`
            )
          )
            throw new Error('PROTOCOL_CATALOG_IDENTITY_CONFLICT');
          const files = db
            .prepare(
              'SELECT entity_id,object_uuid,path FROM catalog_entity_files WHERE entity_id=? OR path=?'
            )
            .all(receipt.entityId, receipt.path) as Array<{
            entity_id: string;
            object_uuid: string;
            path: string;
          }>;
          if (
            files.some(
              (row) =>
                row.entity_id !== receipt.entityId ||
                row.object_uuid !== receipt.fileObjectUuid ||
                row.path !== receipt.path
            )
          )
            throw new Error('PROTOCOL_CATALOG_BINDING_CONFLICT');
          const document = parseProtocolPackage(receipt.text);
          if (receipt.operation === 'create' && !existing.length)
            registerCatalogEntityInDb(db, {
              id: receipt.entityId,
              type: receipt.kind === 'protocol' ? 'protocol' : 'protocol_run',
              name: document.title,
              locator: `file://${receipt.path}`,
              storageType: 'file',
              workspaceRoot: receipt.root,
              metadata: {
                portableId: receipt.portableId,
                nativePackage: receipt.kind,
                relativePath: relative(receipt.root, receipt.path),
              },
            });
          if (receipt.operation === 'save')
            updateCatalogEntityPresentationInDb(db, {
              entityId: receipt.entityId,
              name: document.title,
            });
          bindCatalogEntityFileInDb(db, {
            entityId: receipt.entityId,
            path: receipt.path,
            workspaceRoot: receipt.root,
            fileKind: receipt.kind === 'protocol' ? 'waypoint-protocol' : 'waypoint-protocol-run',
            objectUuid: receipt.fileObjectUuid,
            contentHash: hash(receipt.text),
            sizeBytes: Buffer.byteLength(receipt.text),
            status: 'current',
          });
          recordCatalogEventInDb(db, {
            id: hash(`${receipt.projectId}\0${receipt.requestId}`).slice(7),
            entityId: receipt.entityId,
            eventType: receipt.operation === 'create' ? 'created' : 'edited',
            actor: receipt.actor,
            createdAt: receipt.at,
            summary:
              receipt.operation === 'create' ? `Created ${receipt.kind}` : `Edited ${receipt.kind}`,
            payload: { requestId: receipt.requestId, intentSha256: receipt.intentSha256 },
          });
          guard();
          const bound = binding(receipt.entityId);
          if (
            bound.workspace_id !== scope.project.id ||
            bound.object_uuid !== receipt.fileObjectUuid ||
            bound.path !== receipt.path ||
            bound.status !== 'active' ||
            bound.type !== (receipt.kind === 'protocol' ? 'protocol' : 'protocol_run')
          )
            throw new Error('PROTOCOL_CATALOG_BINDING_CONFLICT');
        })();
        notifyCommitted(receipt);
        receipt.phase = 'ready';
        await writeReceipt(receipt);
        return ready();
      } catch (error) {
        if (!published) {
          try {
            guardFile(receipt.root, receipt.path, Buffer.from(receipt.text));
            published = true;
          } catch {}
        }
        if (published) {
          receipt.phase = 'published';
          await writeReceipt(receipt);
        }
        return {
          kind: published ? 'pending' : 'refused',
          requestId: receipt.requestId,
          entityId: receipt.entityId,
          path: receipt.path,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
  };
  const once = (
    projectId: string,
    requestId: string,
    intent: string,
    action: () => Promise<NativeProtocolCreationResult>
  ) => {
    const key = `${projectId}\0${requestId}`,
      existing = inFlight.get(key);
    if (existing) {
      if (existing.intent !== intent) throw new Error('PROTOCOL_REQUEST_CONFLICT');
      return existing.promise;
    }
    const promise = action();
    inFlight.set(key, { intent, promise });
    void promise
      .finally(() => {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      })
      .catch(() => {});
    return promise;
  };
  const create = async (
    input: unknown,
    kind: Receipt['kind'],
    invocation: NativeProtocolInvocation = {}
  ): Promise<NativeProtocolCreationResult> => {
    const request =
        kind === 'protocol'
          ? protocolCreateSchema.parse(input)
          : protocolStartRunSchema.parse(input),
      scope = admit(request.project, false);
    const intentRequest = { ...request, project: scope.project.projectId };
    if ('initialProtocolText' in intentRequest && intentRequest.initialProtocolText)
      intentRequest.initialProtocolText = canonicalProtocolJson(
        paperCreationIntent(parseProtocolPackage(intentRequest.initialProtocolText).raw)
      );
    const intentSha256 = jsonHash({ kind, ...intentRequest });
    return once(scope.project.projectId, request.requestId, intentSha256, async () => {
      const existing = await loadReceipt(scope.project.projectId, request.requestId);
      if (existing) {
        if (existing.intentSha256 !== intentSha256) throw new Error('PROTOCOL_REQUEST_CONFLICT');
        return runReceipt(existing, invocation);
      }
      admit(scope.project.projectId, true);
      const initial =
        'initialProtocolText' in request && request.initialProtocolText
          ? parseProtocolPackage(request.initialProtocolText)
          : null;
      if (
        initial &&
        (initial.kind !== 'protocol' ||
          initial.title !== request.title ||
          initial.raw.creation ||
          initial.raw.frozenProtocol)
      )
        throw new Error('PROTOCOL_INITIAL_SOURCE_INVALID');
      const portableId = initial ? stripWorkspaceScope(initial.id) : `${kind}-${randomUUID()}`,
        entityId = scopedProjectionId(scope.project.projectId, portableId),
        fileObjectUuid = randomUUID(),
        at = Date.now(),
        actor = invocation.actor ?? options.actor();
      const path = await packagePath(
        scope.project,
        request.parentPath,
        request.title,
        portableId,
        kind
      );
      if (options.db().prepare('SELECT 1 FROM catalog_entities WHERE id=?').get(entityId)) {
        if (initial?.raw.paperProtocol) {
          const current = (await capture(scope.project.projectId, entityId)).snapshot;
          if (
            canonicalProtocolJson(
              paperCreationIntent(parseProtocolPackage(current.originalText).raw)
            ) === canonicalProtocolJson(paperCreationIntent(initial.raw))
          )
            return { kind: 'ready', requestId: request.requestId, package: current };
        }
        throw new Error('PROTOCOL_IDENTITY_EXISTS');
      }
      let protocolSource: NativeProtocolPackageSnapshot | null = null,
        raw: RecordValue;
      if (kind === 'protocol') {
        const body = {
          title: request.title,
          overview: { type: 'doc', content: [{ type: 'paragraph' }] },
          steps: [
            {
              id: `${portableId}-step-1`,
              sourceStepId: 'local-step-1',
              ordinal: 1,
              title: 'Step 1',
              content: { type: 'doc', content: [{ type: 'paragraph' }] },
            },
          ],
          inputs: [],
          outputs: [],
          links: [],
        };
        raw = initial
          ? { ...initial.raw }
          : {
              schema: 'dnaforge.protocol.v1',
              kind: 'protocol',
              id: portableId,
              ...body,
              editable: true,
              version: {
                sourceVersionId: 'local-v1',
                pinnedVersionHash: jsonHash(body),
                immutable: true,
                importedAt: new Date(at).toISOString(),
              },
              provenance: {
                immutableSource: false,
                provider: 'dnaforge',
                capturedAt: new Date(at).toISOString(),
              },
            };
      } else {
        if (!('protocolId' in request)) throw new Error('PROTOCOL_SOURCE_REQUIRED');
        const source = await capture(scope.project.projectId, request.protocolId);
        if (
          source.snapshot.kind !== 'protocol' ||
          source.snapshot.sourceSha256 !== request.expectedSourceSha256
        )
          throw new Error('PROTOCOL_SOURCE_CHANGED');
        source.assertCurrent();
        protocolSource = source.snapshot;
        const definition = protocolExecutionDefinition(protocolSource.originalText);
        const frozenProtocol = {
          schema: 'dnaforge.protocol-execution-snapshot.v1',
          source: {
            kind: 'native-observed-saved-source',
            projectId: protocolSource.projectId,
            workspaceScope: protocolSource.workspaceScope,
            protocolId: protocolSource.entityId,
            fileObjectUuid: protocolSource.fileObjectUuid,
            sourceSha256: protocolSource.sourceSha256,
            fileSha256: protocolSource.fileSha256,
            originalText: protocolSource.originalText,
          },
          definitionSha256: definition.definitionSha256,
          declaredVersion: definition.declaredVersion,
          paperAcceptedVersion: definition.paperAcceptedVersion,
        };
        raw = {
          schema: 'dnaforge.protocol-run.v1',
          kind: 'protocol_run',
          id: portableId,
          title: request.title,
          status: 'in_progress',
          immutable: false,
          protocol: {
            sourceId: protocolSource.portableId,
            destinationId: protocolSource.entityId,
            name: protocolSource.title,
            pinnedVersionId: `saved-${definition.definitionSha256.slice(7)}`,
            pinnedVersionHash: definition.definitionSha256,
          },
          inputs: [],
          outputs: [],
          measurements: [],
          tables: [],
          links: [],
          startedAt: new Date(at).toISOString(),
          completedAt: null,
          amendments: [],
          provenance: {
            immutableSource: false,
            provider: 'dnaforge',
            capturedAt: new Date(at).toISOString(),
          },
          frozenProtocol,
        };
      }
      raw.creation = {
        schema:
          kind === 'protocol'
            ? 'dnaforge.protocol-creation.v1'
            : 'dnaforge.protocol-run-creation.v1',
        requestId: request.requestId,
        intentSha256,
        portableId,
        fileObjectUuid,
        createdAt: new Date(at).toISOString(),
        actor,
        ...(raw.frozenProtocol ? { frozenProtocolSha256: jsonHash(raw.frozenProtocol) } : {}),
      };
      const text = canonicalProtocolJson(raw) + '\n';
      parseProtocolPackage(text);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('PROTOCOL_SOURCE_TOO_LARGE');
      const receipt: Receipt = {
        version: 1,
        requestId: request.requestId,
        intentSha256,
        operation: 'create',
        phase: 'prepared',
        projectId: scope.project.projectId,
        root: scope.project.path,
        entityId,
        portableId,
        fileObjectUuid,
        path,
        kind,
        text,
        at,
        actor,
        expectedFileSha256: null,
        protocolSource,
      };
      scope.assertAuthority();
      await writeReceipt(receipt);
      return runReceipt(receipt, invocation);
    });
  };
  const owner = {
    createProtocol: (input: unknown, invocation?: NativeProtocolInvocation) =>
      create(input, 'protocol', invocation),
    startRun: (input: unknown, invocation?: NativeProtocolInvocation) =>
      create(input, 'protocol-run', invocation),
    async readPackage(input: unknown) {
      const request = protocolPackageReadSchema.parse(input);
      return (await capture(request.project, request.entityId, true)).snapshot;
    },
    async readSavedProtocol(input: unknown) {
      const value = await owner.readPackage(input);
      if (value.kind !== 'protocol' || value.readOnly) throw new Error('PROTOCOL_SOURCE_REQUIRED');
      return value;
    },
    async listPackages(input: unknown) {
      const request = protocolPackageListSchema.parse(input),
        scope = admit(request.project, false);
      const rows = options
        .db()
        .prepare(
          "SELECT id FROM catalog_entities WHERE workspace_id=? AND status='active' AND type=? ORDER BY name,id"
        )
        .all(scope.project.id, request.kind === 'protocol' ? 'protocol' : 'protocol_run') as Array<{
        id: string;
      }>;
      const result: NativeProtocolPackageSnapshot[] = [];
      for (const row of rows) {
        try {
          const saved = (await capture(scope.project.projectId, row.id)).snapshot;
          if (!request.query || saved.title.toLowerCase().includes(request.query.toLowerCase()))
            result.push(saved);
        } catch {}
        if (result.length >= (request.limit ?? 20)) break;
      }
      scope.assertAuthority();
      return result;
    },
    async inspectCreation(input: unknown): Promise<NativeProtocolCreationResult> {
      const request = protocolCreationInspectSchema.parse(input),
        scope = admit(request.project, false),
        receipt = await loadReceipt(scope.project.projectId, request.requestId);
      if (!receipt) return { kind: 'missing', requestId: request.requestId };
      if (receipt.phase === 'ready') return runReceipt(receipt);
      return {
        kind: 'pending',
        requestId: receipt.requestId,
        entityId: receipt.entityId,
        path: receipt.path,
        message:
          receipt.phase === 'prepared'
            ? 'Creation is prepared; recover the same request.'
            : 'Saved file is retained; catalog recovery is pending.',
      };
    },
    async recoverCreation(
      input: unknown,
      invocation?: NativeProtocolInvocation
    ): Promise<NativeProtocolCreationResult> {
      const request = protocolCreationInspectSchema.parse(input),
        scope = admit(request.project, true),
        receipt = await loadReceipt(scope.project.projectId, request.requestId);
      return receipt
        ? runReceipt(receipt, invocation)
        : { kind: 'missing', requestId: request.requestId };
    },
    async savePackage(
      input: unknown,
      invocation: NativeProtocolInvocation = {}
    ): Promise<NativeProtocolCreationResult> {
      const request = protocolPackageSaveSchema.parse(input),
        scope = admit(request.project, true),
        intentSha256 = jsonHash({ ...request, project: scope.project.projectId });
      return once(scope.project.projectId, request.requestId, intentSha256, async () => {
        const retained = await loadReceipt(scope.project.projectId, request.requestId);
        if (retained) {
          if (retained.intentSha256 !== intentSha256) throw new Error('PROTOCOL_REQUEST_CONFLICT');
          return runReceipt(retained, invocation);
        }
        const before = (await capture(scope.project.projectId, request.entityId)).snapshot;
        if (before.sourceSha256 !== request.expectedSourceSha256)
          throw new Error('PROTOCOL_SAVE_SOURCE_CHANGED');
        const old = parseProtocolPackage(before.originalText),
          next = parseProtocolPackage(request.originalText);
        if (next.id !== old.id || next.kind !== old.kind)
          throw new Error('PROTOCOL_SAVE_IDENTITY_CHANGED');
        const immutable =
          old.kind === 'protocol_run'
            ? [
                'creation',
                'frozenProtocol',
                'protocol',
                'provenance',
                'startedAt',
                'status',
                'immutable',
                'completedAt',
              ]
            : ['creation', 'provenance', 'id'];
        if (old.kind === 'protocol_run' && old.raw.immutable === true)
          throw new Error('PROTOCOL_RUN_COMPLETED');
        for (const key of immutable)
          if (
            canonicalProtocolJson(old.raw[key] ?? null) !==
            canonicalProtocolJson(next.raw[key] ?? null)
          )
            throw new Error('PROTOCOL_IMMUTABLE_FIELD_CHANGED: ' + key);
        const receipt: Receipt = {
          version: 1,
          requestId: request.requestId,
          intentSha256,
          operation: 'save',
          phase: 'prepared',
          projectId: scope.project.projectId,
          root: scope.project.path,
          entityId: before.entityId,
          portableId: before.portableId,
          fileObjectUuid: before.fileObjectUuid,
          path: before.path,
          kind: before.kind,
          text: request.originalText,
          at: Date.now(),
          actor: invocation.actor ?? options.actor(),
          expectedFileSha256: before.fileSha256,
          protocolSource: null,
        };
        await writeReceipt(receipt);
        return runReceipt(receipt, invocation);
      });
    },
    async withSavedRunSource<T>(
      project: string,
      runId: string,
      action: (capture: ProtocolSavedSourceCapture) => T | Promise<T>
    ): Promise<T> {
      const current = await capture(project, runId);
      if (current.packet.schema !== 'dnaforge.protocol-run-saved-source.v1')
        throw new Error('PROTOCOL_RUN_REQUIRED');
      return action({
        source: current.packet,
        sourceSha256: current.snapshot.sourceSha256,
        assertCurrent: current.assertCurrent,
      });
    },
  };
  return owner;
}
export type NativeProtocolPackages = ReturnType<typeof createNativeProtocolPackages>;

function paperCreationIntent(value: RecordValue): RecordValue {
  const raw = JSON.parse(JSON.stringify(value)) as RecordValue;
  delete raw.creation;
  if (raw.paperProtocol) {
    if (raw.version) delete (raw.version as RecordValue).importedAt;
    if (raw.provenance) delete (raw.provenance as RecordValue).capturedAt;
    const sources = (raw.paperProtocol as RecordValue).sources;
    if (Array.isArray(sources))
      for (const source of sources)
        if (source && typeof source === 'object') delete (source as RecordValue).capturedAt;
  }
  return raw;
}
