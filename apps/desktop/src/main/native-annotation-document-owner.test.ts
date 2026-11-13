// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import type { ManagedDocumentSelection } from '@waypoint/domain-services';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { registerDatabaseHandlers } from './ipc/database';
import { NativeAnnotationDocumentOwner } from './native-annotation-document-owner';
import { annotationInputRevision } from '../shared/annotation-input-revision';
import type { TrustedManagedAnnotationAuthority } from '../shared/annotation-managed-operation-contract';
import type { SidecarFetch } from './sidecar-request-auth';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationWaiterCountForTest,
} from './workspace-sync-mutation-lease';
import { sha256Text } from './primer-artifact-files';
import { SEQUENCE_EDIT_TRANSITION_EVENT_TYPE } from '../shared/sequence-edit-lineage';

const databaseIpc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      databaseIpc.handlers.set(channel, handler),
  },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0' },
}));

let database: ReturnType<typeof createFileTestDb>;
let root: string;
let sourcePath: string;
let original: string;
let owner: NativeAnnotationDocumentOwner;
let authority: TrustedManagedAnnotationAuthority;
let selection: ManagedDocumentSelection;
let onPrepare: () => Promise<void>;
let onIntent: () => Promise<void>;
let prepareCalls: number;
let events: string[];
let settlements: unknown[];
const target = { operationId: 'operation-1', targetDocumentId: 'document-1' };
const actionId = 'annotation-action-1';
const requestSha256 = `sha256:${'c'.repeat(64)}`;

function role(value: 'viewer' | 'editor' | 'manager') {
  database.db
    .prepare('UPDATE workspace_sync_bindings SET access_role=? WHERE workspace_id=7')
    .run(value);
}

function receipt(outcome: string, details: Record<string, unknown>) {
  return {
    id: actionId,
    operation_id: target.operationId,
    action: 'apply_to_document',
    outcome,
    details_json: {
      request_sha256: requestSha256,
      target_document_id: target.targetDocumentId,
      ...details,
    },
  };
}

const fetch: SidecarFetch = async (path, options) => {
  const command = String(path).split('/').at(-1);
  if (command === 'authority') return Response.json(authority);
  const body: unknown = JSON.parse(String(options?.body));
  if (!body || typeof body !== 'object') throw new Error('Native request body is missing.');
  if (command === 'intent' && 'intent' in body) {
    events.push('intent');
    await onIntent();
    return Response.json({
      status: 'permitted',
      record: receipt('document_writing', { write_intent: body.intent }),
    });
  }
  if (
    command === 'settlement' &&
    'settlement' in body &&
    body.settlement &&
    typeof body.settlement === 'object' &&
    'status' in body.settlement &&
    typeof body.settlement.status === 'string'
  ) {
    events.push(`settlement:${body.settlement.status}`);
    settlements.push(structuredClone(body.settlement));
    return Response.json({
      status: 'recorded',
      record: receipt(`document_${body.settlement.status.replaceAll('-', '_')}`, {
        settlement: body.settlement,
      }),
    });
  }
  throw new Error('Unexpected native action request.');
};

beforeEach(async () => {
  database = createFileTestDb('annotation-owner-access');
  ensureSchema(database.db, database.dbPath);
  root = await realpath(await mkdtemp(join(tmpdir(), 'annotation-owner-access-')));
  sourcePath = join(root, 'notes.gb');
  original = serializeSequenceForInPlaceSave(
    {
      id: target.targetDocumentId,
      name: 'ordinary-file',
      sequence: 'ATGC',
      length: 4,
      circular: false,
      annotations: [],
    },
    sourcePath
  );
  await writeFile(sourcePath, original);
  for (const args of [
    ['init', '--quiet', '--initial-branch=main'],
    ['add', 'notes.gb'],
    [
      '-c',
      'user.name=DNAForge fixture',
      '-c',
      'user.email=fixture@users.noreply.github.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Initial sequence',
    ],
  ])
    execFileSync('git', ['-C', root, ...args]);
  database.db
    .prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at,last_opened_at) VALUES(7,'Annotation owner',?,'project-7',1,1)"
    )
    .run(root);
  database.db
    .prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'sequence','Sequence',?,'file',7,1,1)"
    )
    .run(target.targetDocumentId, sourcePath);
  database.db
    .prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('sequence-file',?,7,?,'genbank',1,1)"
    )
    .run(target.targetDocumentId, sourcePath);
  database.db
    .prepare(
      "INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,created_at,updated_at) VALUES(7,'project-7','account-a','remote-a',0,'editor',1,1)"
    )
    .run();
  authority = {
    schema: 'dnaforge.managed-annotation-authority.v1',
    operation: {
      id: target.operationId,
      kind: 'annotation',
      state: 'succeeded',
      result_status: 'available',
      version: 3,
      subject: {
        scope_id: 'runtime-1',
        subject_id: target.targetDocumentId,
        input_revision: await annotationInputRevision({ sequence: 'ATGC', linear: true }),
      },
    },
    resultSha256: `sha256:${'a'.repeat(64)}`,
    result: {
      sequence_length: 4,
      features: [
        {
          name: 'Retained candidate',
          type: 'misc_feature',
          start: 1,
          end: 4,
          strand: 1,
          identity: 100,
          coverage: 100,
          fragment: false,
          ref_start: 1,
          ref_end: 4,
          ref_length: 4,
          db_source: 'nucleotide',
        },
      ],
    },
  };
  events = [];
  settlements = [];
  prepareCalls = 0;
  onPrepare = async () => undefined;
  onIntent = async () => undefined;
  owner = new NativeAnnotationDocumentOwner({
    nativeOwnerInstanceId: 'native-owner-1',
    db: () => database.db,
    workspaceRoots: () => [root],
    fetch,
    prepare: async () => {
      prepareCalls += 1;
      await onPrepare();
      return {
        assertCurrent() {
          events.push('barrier-current');
        },
        async finish() {
          events.push('barrier-finished');
          return 'not-required';
        },
        abort(disposition) {
          events.push(`barrier-aborted:${disposition}`);
        },
      };
    },
  });
  const inspection = await owner.inspect(target, authority);
  selection = {
    ...target,
    expectedOperationVersion: inspection.operationVersion,
    expectedResultSha256: inspection.resultSha256,
    expectedTargetDocumentRevision: inspection.targetDocumentRevision,
    selectedCandidateIds: inspection.candidates.map((candidate) => candidate.id),
  };
});

afterEach(async () => {
  await owner.close();
  database.cleanup();
  databaseIpc.handlers.clear();
  await rm(root, { recursive: true, force: true });
});

function apply() {
  return owner.apply({ actionId, requestSha256, selection });
}

function head() {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

describe('native annotation owner project authority over real SQLite, files and checkpoint', () => {
  it('keeps viewer inspection readable and refuses Apply before barrier or intent', async () => {
    role('viewer');
    const inspection = await owner.inspect(target, authority);
    expect(inspection.candidates).toHaveLength(1);
    expect(inspection.applicable).toBe(true);
    const before = head();
    const outcome = await apply();
    expect({
      outcome,
      unchangedSource: (await readFile(sourcePath, 'utf8')) === original,
      prepareCalls,
      intents: events.filter((event) => event === 'intent').length,
    }).toMatchObject({
      outcome: { status: 'blocked', reason: expect.stringContaining('view only') },
      unchangedSource: true,
      prepareCalls: 0,
      intents: 0,
    });
    expect(head()).toBe(before);
    expect(
      database.db
        .prepare('SELECT * FROM catalog_entity_events WHERE entity_id=? AND event_type=?')
        .all(target.targetDocumentId, SEQUENCE_EDIT_TRANSITION_EVENT_TYPE)
    ).toEqual([]);
  });

  it('writes and checkpoints the same retained candidate for a current editor', async () => {
    const before = head();
    const outcome = await apply();
    expect(outcome).toMatchObject({
      status: 'saved',
      checkpoint: { status: 'committed' },
      lineage: 'recorded',
    });
    expect(head()).not.toBe(before);
    const reopened = parseSequenceFileAsDocument(
      await readFile(sourcePath, 'utf8'),
      sourcePath
    ).sequence;
    expect(reopened.sequence).toBe('ATGC');
    expect(reopened.annotations).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Retained candidate' })])
    );
    expect(events).toContain('barrier-finished');
  });

  it('refuses a foreign renderer transaction before using its uncommitted project authority', async () => {
    role('viewer');
    registerDatabaseHandlers(() => database.db);
    const execute = databaseIpc.handlers.get('db:execute');
    if (!execute) throw new Error('Production database execute IPC is unavailable.');
    const sender = Object.assign(new EventEmitter(), { id: 785 });
    await execute({ sender }, 'BEGIN');
    await execute(
      { sender },
      "UPDATE workspace_sync_bindings SET access_role='editor' WHERE workspace_id=7"
    );
    let settled = false;
    const pending = apply().finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(async () =>
        expect(settled || (await readFile(sourcePath, 'utf8')) !== original).toBe(true)
      );
    } finally {
      await execute({ sender }, 'ROLLBACK');
    }
    const outcome = await pending;
    expect({
      outcome,
      unchangedSource: (await readFile(sourcePath, 'utf8')) === original,
      prepareCalls,
      intents: events.filter((event) => event === 'intent').length,
    }).toMatchObject({
      outcome: {
        status: 'blocked',
        reason: expect.stringContaining('DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER'),
      },
      unchangedSource: true,
      prepareCalls: 0,
      intents: 0,
    });
  });

  it('checks the current role when an editor Apply was queued behind another workspace lease', async () => {
    const before = head();
    const release = await acquireWorkspaceMutationShared(root);
    const pending = apply();
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBe(1));
      role('viewer');
    } finally {
      release();
    }
    expect(await pending).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('view only'),
    });
    expect(prepareCalls).toBe(0);
    expect(events).not.toContain('intent');
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    expect(head()).toBe(before);
  });

  it('aborts the original barrier unchanged when access is demoted during prepare', async () => {
    onPrepare = async () => role('viewer');
    expect(await apply()).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('view only'),
    });
    expect(prepareCalls).toBe(1);
    expect(events).toContain('barrier-aborted:unchanged');
    expect(events).not.toContain('intent');
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
  });

  it('refuses demotion during the intent acknowledgement at the unchanged atomic beforePublish boundary', async () => {
    const before = head();
    onIntent = async () => role('viewer');
    expect(await apply()).toMatchObject({
      status: 'save-failed',
      reason: expect.stringContaining('view only'),
    });
    expect(settlements).toEqual([
      expect.objectContaining({
        status: 'save-failed',
        write_disposition: 'not-published',
        observed_sha256: `sha256:${await sha256Text(original)}`,
      }),
    ]);
    expect(events).toContain('intent');
    expect(events).toContain('barrier-aborted:unchanged');
    expect(events).not.toContain('barrier-finished');
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    expect((await readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(head()).toBe(before);
    expect(
      database.db
        .prepare('SELECT * FROM catalog_entity_events WHERE event_type=?')
        .all(SEQUENCE_EDIT_TRANSITION_EVENT_TYPE)
    ).toEqual([]);
  });

  it.each(['file', 'file-binding-id', 'project', 'remote-account'] as const)(
    'refuses %s ownership changes during intent without publishing or checkpointing',
    async (change) => {
      const replacement = join(root, 'replacement.gb');
      await writeFile(replacement, original);
      const before = head();
      onIntent = async () => {
        if (change === 'file')
          database.db
            .prepare("UPDATE catalog_entity_files SET path=? WHERE id='sequence-file'")
            .run(replacement);
        if (change === 'file-binding-id')
          database.db
            .prepare(
              "UPDATE catalog_entity_files SET id='replacement-binding' WHERE id='sequence-file'"
            )
            .run();
        if (change === 'project')
          database.db
            .prepare("UPDATE workspaces SET repo_uuid='replacement-owner' WHERE id=7")
            .run();
        if (change === 'remote-account')
          database.db
            .prepare(
              "UPDATE workspace_sync_bindings SET owner_account_id='replacement-account' WHERE workspace_id=7"
            )
            .run();
      };
      expect(await apply()).toMatchObject({
        status: 'save-failed',
        reason: expect.stringContaining('owner changed'),
      });
      expect(settlements).toEqual([
        expect.objectContaining({ status: 'save-failed', write_disposition: 'not-published' }),
      ]);
      expect(await readFile(sourcePath, 'utf8')).toBe(original);
      expect(await readFile(replacement, 'utf8')).toBe(original);
      expect(head()).toBe(before);
      expect(events).not.toContain('barrier-finished');
    }
  );

  it('allows editor-to-manager promotion and routine sync/index progress without freezing old authority metadata', async () => {
    onIntent = async () => {
      role('manager');
      database.db
        .prepare('UPDATE workspaces SET name=?,last_opened_at=42 WHERE id=7')
        .run('Updated display name');
      database.db
        .prepare(
          'UPDATE workspace_sync_bindings SET enabled=1,updated_at=42,remote_latest_version_number=2,last_downloaded_at=42 WHERE workspace_id=7'
        )
        .run();
      database.db
        .prepare("UPDATE catalog_entity_files SET last_seen_at=42 WHERE id='sequence-file'")
        .run();
    };
    expect(await apply()).toMatchObject({
      status: 'saved',
      checkpoint: { status: 'committed' },
      lineage: 'recorded',
    });
    expect(events).toContain('barrier-finished');
  });

  it('keeps a reference project readable and refuses content Apply before preparation', async () => {
    database.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    expect((await owner.inspect(target, authority)).candidates).toHaveLength(1);
    expect(await apply()).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('writable owning project'),
    });
    expect(prepareCalls).toBe(0);
    expect(events).not.toContain('intent');
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
  });

  it('uses the stored owner path for the viewer role check when a workspace has a physical alias', async () => {
    const alias = join(database.tmpDir, 'workspace-alias');
    await symlink(root, alias, 'dir');
    database.db.prepare('UPDATE workspaces SET path=? WHERE id=7').run(alias);
    role('viewer');
    expect((await owner.inspect(target, authority)).candidates).toHaveLength(1);
    expect(await apply()).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('view only'),
    });
    expect(prepareCalls).toBe(0);
    expect(events).not.toContain('intent');
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
  });
});
