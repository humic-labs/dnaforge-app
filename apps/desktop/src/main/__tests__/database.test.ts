import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import { buildPrimerArtifact, serializePrimerArtifact } from '../../shared/primers/primer-artifact';
import { primerLegacyProjectionFromArtifact } from '../../shared/primers/primer-artifact-projection';
import { replacePrimerLegacyProjectionInDb } from '../primer-projection';
import type { PrimerLegacyProjectionInput } from '../../shared/primer-projection-ipc';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), exit: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { ensureSchema } from '../schema';
import {
  armRendererTransactionCrashCleanup,
  commitChatTurnTerminalStateInDb,
  createChatTurnWithUserMessageInDb,
  registerDatabaseHandlers,
} from '../ipc/database';
import { createTestDb } from './test-db';
import type {
  CommitChatTurnTerminalStateRequest,
  CreateChatTurnWithUserMessageRequest,
} from '../../shared/chat-turn-ipc';
import { notifyRendererDatabaseStatementSettled } from '../workspace-sync-database-fence';
import type { RendererDatabaseLifecycleSender } from '../workspace-sync-database-fence';

type TestRendererSender = RendererDatabaseLifecycleSender & {
  emit(event: string, ...args: unknown[]): boolean;
};

function createTestRendererSender(id: number): TestRendererSender {
  const emitter = new EventEmitter();
  return {
    id,
    once: (event, listener) => emitter.once(event, listener),
    on: (event, listener) => emitter.on(event, listener),
    removeListener: (event, listener) =>
      emitter.removeListener(event, listener as (...args: unknown[]) => void),
    emit: (event, ...args) => emitter.emit(event, ...args),
  };
}

describe('database IPC helpers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('conv-1', 'Concurrent chat', 1, 1, 'openai', 'gpt-4o-mini');
  });

  async function retainedPrimerProjection() {
    const id = randomUUID();
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'retained-primer-home-')));
    const path = join(workspaceRoot, 'retained.primer.json');
    db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES(7,'Primer home',?,1)").run(
      workspaceRoot
    );
    const artifact = await buildPrimerArtifact({
      id,
      catalogNumber: 'P001',
      name: 'Retained primer',
      sequence: 'ACGTACGTACGT',
      workspaceRoot,
      artifactPath: path,
      source: 'manual',
      now: 1,
    });
    writeFileSync(path, `${JSON.stringify(artifact, null, 4)}\n`);
    db.prepare(
      `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
      VALUES(?,'primer',?,?,'file','active',7,1,1)`
    ).run(id, artifact.name, `file://${path}`);
    bindCatalogEntityFileInDb(db, {
      entityId: id,
      path,
      workspaceRoot,
      fileKind: 'primer-artifact',
      contentHash: `sha256:${createHash('sha256').update(serializePrimerArtifact(artifact)).digest('hex')}`,
    });
    const input: PrimerLegacyProjectionInput = primerLegacyProjectionFromArtifact(artifact, 7, []);
    replacePrimerLegacyProjectionInDb(db, input);
    db.prepare(
      `INSERT INTO org_registry_local_records
      (org_id,account_id,entity_id,client_id,workspace_id,workspace_uuid,home_workspace_id,
      kind,local_schema_revision_id,authority_kind,schema_id,schema_revision_id,
      claim_mutation_id,claim_source_revision,claim_local_event_seq,created_at,updated_at)
      VALUES(?,?,?,?,7,?,?,'oligo',?,'primer_artifact',?,?,?,?,1,1,1)`
    ).run(
      randomUUID(),
      randomUUID(),
      id,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      'a'.repeat(64)
    );
    return { input, workspaceRoot, path };
  }

  it('refuses raw retirement SQL for both registered and unregistered primers', async () => {
    const { input } = await retainedPrimerProjection();
    registerDatabaseHandlers(() => db);
    const execute = new Map(vi.mocked(ipcMain.handle).mock.calls).get('db:execute');
    if (!execute) throw new Error('Missing actual database execute handler');
    const event = { sender: createTestRendererSender(305) };
    const sql = 'DELETE FROM primers WHERE id = ? AND workspace_id = ?';
    const before = db.prepare('SELECT * FROM primers ORDER BY id').all();
    await expect(async () =>
      Reflect.apply(execute, undefined, [event, sql, [input.id, 7]])
    ).rejects.toThrow(/registered with an organization/);
    expect(db.prepare('SELECT * FROM primers ORDER BY id').all()).toEqual(before);
    const other = {
      ...(db.prepare('SELECT * FROM primers WHERE id = ?').get(input.id) as Record<
        string,
        unknown
      >),
      id: randomUUID(),
      catalog_number: 'P002',
      origin_details: '{}',
    };
    const columns = Object.keys(other);
    db.prepare(
      `INSERT INTO primers (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    ).run(...columns.map((column) => other[column as keyof typeof other]));
    await expect(async () =>
      Reflect.apply(execute, undefined, [event, sql, [other.id, 7]])
    ).rejects.toThrow('PRIMER_DELETION_REQUIRES_NATIVE_COMMAND');
    expect(db.prepare('SELECT * FROM primers WHERE id = ?').get(other.id)).toEqual(other);
    expect(db.prepare('SELECT * FROM primers WHERE id = ?').get(input.id)).toEqual(before[0]);
  });

  it('refuses renderer projection replacement for a registered primer before changing any legacy state', async () => {
    const { input } = await retainedPrimerProjection();
    registerDatabaseHandlers(() => db);
    const replace = new Map(vi.mocked(ipcMain.handle).mock.calls).get('db:replacePrimerProjection');
    if (!replace) throw new Error('Missing actual primer projection handler');
    const before = db.prepare('SELECT * FROM primers ORDER BY id').all();
    await expect(
      Reflect.apply(replace, undefined, [
        { sender: createTestRendererSender(306) },
        { ...input, name: 'Unversioned overwrite' },
      ])
    ).rejects.toThrow(/registered with an organization/);
    expect(db.prepare('SELECT * FROM primers ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM primer_bindings').all()).toEqual([]);
  });

  it.each(['registered identity', 'occupied registered path'] as const)(
    'refuses renderer catalog rebinding of a %s under its owning lease',
    async (mode) => {
      const { input, workspaceRoot, path } = await retainedPrimerProjection();
      const incomingId = mode === 'registered identity' ? input.id : randomUUID();
      if (incomingId !== input.id)
        db.prepare(
          `INSERT INTO catalog_entities
        (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
        VALUES(?,'primer','Other primer',?,'file','active',7,1,1)`
        ).run(incomingId, `file://${workspaceRoot}/other.primer.json`);
      registerDatabaseHandlers(() => db);
      const bind = new Map(vi.mocked(ipcMain.handle).mock.calls).get('db:bindCatalogEntityFile');
      if (!bind) throw new Error('Missing actual catalog binding handler');
      const before = db.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all();
      const events = db.prepare('SELECT * FROM catalog_entity_events ORDER BY id').all();
      await expect(
        Reflect.apply(bind, undefined, [
          { sender: createTestRendererSender(307) },
          {
            entityId: incomingId,
            workspaceRoot,
            path: mode === 'registered identity' ? `${workspaceRoot}/moved.primer.json` : path,
            fileKind: 'primer-artifact',
          },
        ])
      ).rejects.toThrow(/registered with an organization/);
      expect(db.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all()).toEqual(before);
      expect(db.prepare('SELECT * FROM catalog_entity_events ORDER BY id').all()).toEqual(events);
    }
  );

  it('creates the chat turn and first user message in one main-process transaction', () => {
    insertReference('ref-1');
    const input = request();
    input.reference_ids = ['ref-1'];
    const sha256 = 'a'.repeat(64);
    input.attachment_manifests = [
      {
        id: `attachment-${sha256}`,
        sha256,
        name: 'sequence.fasta',
        kind: 'text',
        mediaType: 'text/x-fasta',
        size: 17,
      },
    ];
    createChatTurnWithUserMessageInDb(db, input, () => 99);

    expect(db.prepare('SELECT id, status FROM chat_turns WHERE id = ?').get('turn-1')).toEqual({
      id: 'turn-1',
      status: 'running',
    });
    expect(
      db.prepare('SELECT id, turn_id, content FROM messages WHERE id = ?').get('msg-1')
    ).toEqual({
      id: 'msg-1',
      turn_id: 'turn-1',
      content: 'Start a long chat',
    });
    expect(db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('conv-1')).toEqual({
      updated_at: 99,
    });
    expect(
      db.prepare('SELECT reference_id FROM message_references WHERE message_id = ?').all('msg-1')
    ).toEqual([{ reference_id: 'ref-1' }]);
    expect(
      db
        .prepare(
          `SELECT attachment_id, name, media_type, size, sha256, kind
           FROM message_attachments WHERE message_id = ?`
        )
        .all('msg-1')
    ).toEqual([
      {
        attachment_id: `attachment-${sha256}`,
        name: 'sequence.fasta',
        media_type: 'text/x-fasta',
        size: 17,
        sha256,
        kind: 'text',
      },
    ]);
  });

  it('rolls back the whole chat turn insert if the initial message cannot be inserted', () => {
    const bad = request();
    bad.message.id = 'msg-1';
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('msg-1', 'conv-1', 'user', 'existing', 2);

    expect(() => createChatTurnWithUserMessageInDb(db, bad, () => 99)).toThrow();

    expect(db.prepare('SELECT id FROM chat_turns WHERE id = ?').get('turn-1')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get('msg-1')).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('conv-1')).toEqual({
      updated_at: 1,
    });
  });

  it('re-arms abandoned transaction cleanup after two renderer crashes on the same sender', () => {
    const sender = createTestRendererSender(41);
    db.exec('CREATE TABLE crash_probe (id INTEGER PRIMARY KEY)');

    for (const id of [1, 2]) {
      const wasInTransaction = db.inTransaction;
      db.exec('BEGIN');
      notifyRendererDatabaseStatementSettled(db, { senderId: sender.id, wasInTransaction });
      db.prepare('INSERT INTO crash_probe (id) VALUES (?)').run(id);
      armRendererTransactionCrashCleanup(db, sender);
      sender.emit('render-process-gone');
      expect(db.inTransaction).toBe(false);
    }

    expect(db.prepare('SELECT COUNT(*) AS count FROM crash_probe').get()).toEqual({ count: 0 });
  });

  it('blocks generic renderer SQL from bypassing unresolved LIMS safety quarantine', async () => {
    db.prepare(
      `INSERT INTO workspaces (name, path, repo_uuid, created_at, last_opened_at)
       VALUES ('Legacy workspace', '/tmp/legacy-workspace', 'legacy-workspace', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO lims_safety_legacy_scan_candidates (workspace_id)
       SELECT id FROM workspaces WHERE repo_uuid = 'legacy-workspace'`
    ).run();

    vi.mocked(ipcMain.handle).mockClear();
    registerDatabaseHandlers(() => db);
    const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls);
    const select = handlers.get('db:select');
    const execute = handlers.get('db:execute');
    const event = { sender: createTestRendererSender(52) };

    if (!select || !execute) throw new Error('Expected database IPC handlers to be registered.');

    await expect(async () =>
      Reflect.apply(select, undefined, [event, 'SELECT id FROM lims_audit'])
    ).rejects.toThrow('LIMS reads and writes are blocked');
    await expect(async () =>
      Reflect.apply(execute, undefined, [event, 'DELETE FROM lims_safety_legacy_scan_candidates'])
    ).rejects.toThrow('Renderer SQL cannot access DNAForge LIMS safety records');
    await expect(async () =>
      Reflect.apply(execute, undefined, [
        event,
        `UPDATE lims_safety_quarantine SET status = 'resolved' WHERE id = 1`,
      ])
    ).rejects.toThrow('Renderer SQL cannot access DNAForge LIMS safety records');
    await expect(async () =>
      Reflect.apply(select, undefined, [event, 'SELECT status FROM lims_safety_legacy_scan_state'])
    ).rejects.toThrow('Renderer SQL cannot access DNAForge LIMS safety records');
    await expect(async () =>
      Reflect.apply(execute, undefined, [
        event,
        'DELETE FROM lims_safety_legacy_scan_state WHERE id = 1',
      ])
    ).rejects.toThrow('Renderer SQL cannot access DNAForge LIMS safety records');
    expect(
      await Reflect.apply(select, undefined, [
        event,
        'SELECT id FROM conversations WHERE id = ?',
        ['conv-1'],
      ])
    ).toEqual([{ id: 'conv-1' }]);
  });

  it('keeps scientific authority tables behind the semantic service', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    registerDatabaseHandlers(() => db);
    const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls);
    const event = { sender: createTestRendererSender(53) };
    for (const channel of ['db:select', 'db:execute']) {
      const handler = handlers.get(channel)!;
      for (const table of [
        'scientific_revision_records',
        'scientific_revision_refs',
        'scientific_revision_blobs',
        'scientific_materialization_jobs',
      ]) {
        const sql = channel === 'db:select' ? `SELECT * FROM "${table}"` : `DELETE FROM "${table}"`;
        await expect(async () => Reflect.apply(handler, undefined, [event, sql])).rejects.toThrow(
          /scientific.*service/i
        );
      }
    }
  });

  it('rejects mutating RETURNING statements through the read channel before changing any rows', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    registerDatabaseHandlers(() => db);
    const select = new Map(vi.mocked(ipcMain.handle).mock.calls).get('db:select')!;
    await expect(async () =>
      Reflect.apply(select, undefined, [
        { sender: createTestRendererSender(54) },
        "UPDATE conversations SET title = 'bypassed' WHERE id = 'conv-1' RETURNING title",
      ])
    ).rejects.toThrow(/read-only/i);
    expect(db.prepare('SELECT title FROM conversations WHERE id = ?').get('conv-1')).toEqual({
      title: 'Concurrent chat',
    });
  });

  it('atomically commits terminal status, messages, references, and conversation timestamp', () => {
    createChatTurnWithUserMessageInDb(db, request(), () => 20);
    insertReference('ref-1');

    const result = commitChatTurnTerminalStateInDb(db, terminalRequest(), () => 99);

    expect(result).toEqual({ committed: true });
    expect(
      db
        .prepare('SELECT status, terminal_reason, completed_at FROM chat_turns WHERE id = ?')
        .get('turn-1')
    ).toEqual({ status: 'completed', terminal_reason: 'completed', completed_at: 90 });
    expect(db.prepare('SELECT role, content FROM messages WHERE id = ?').get('msg-2')).toEqual({
      role: 'assistant',
      content: 'Finished',
    });
    expect(
      db
        .prepare('SELECT reference_id, position FROM message_references WHERE message_id = ?')
        .all('msg-2')
    ).toEqual([{ reference_id: 'ref-1', position: 0 }]);
    expect(db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('conv-1')).toEqual({
      updated_at: 99,
    });
  });

  it('atomically inserts proposed entity rows with their terminal message join', () => {
    createChatTurnWithUserMessageInDb(db, request(), () => 20);
    const input = terminalRequest();
    input.proposed_entity_references = [proposedReference('ref-1')];

    expect(commitChatTurnTerminalStateInDb(db, input, () => 99)).toEqual({ committed: true });
    expect(
      db
        .prepare(
          'SELECT id, entity_type, display_label, locator, source, status, workspace_root_path FROM entity_references WHERE id = ?'
        )
        .get('ref-1')
    ).toEqual({
      id: 'ref-1',
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://Research Workspace/constructs/pUC19.gb',
      source: 'ai',
      status: 'created',
      workspace_root_path: '/workspace',
    });
    expect(
      db
        .prepare('SELECT reference_id, position FROM message_references WHERE message_id = ?')
        .all('msg-2')
    ).toEqual([{ reference_id: 'ref-1', position: 0 }]);
  });

  it('rolls back a proposed entity row when a later terminal message insert fails', () => {
    createChatTurnWithUserMessageInDb(db, request(), () => 20);
    const input = terminalRequest();
    input.proposed_entity_references = [proposedReference('ref-1')];
    input.messages.push({
      message: { ...input.messages[0].message, id: 'msg-1', content: 'collides' },
      reference_ids: [],
    });

    expect(() => commitChatTurnTerminalStateInDb(db, input, () => 99)).toThrow();
    expect(
      db.prepare('SELECT id FROM entity_references WHERE id = ?').get('ref-1')
    ).toBeUndefined();
    expect(db.prepare('SELECT status FROM chat_turns WHERE id = ?').get('turn-1')).toEqual({
      status: 'running',
    });
  });

  it('rejects unused or duplicate proposed entity rows before mutation', () => {
    createChatTurnWithUserMessageInDb(db, request(), () => 20);
    const unused = terminalRequest();
    unused.messages[0].reference_ids = [];
    unused.proposed_entity_references = [proposedReference('ref-1')];
    expect(() => commitChatTurnTerminalStateInDb(db, unused, () => 99)).toThrow(
      /must be referenced/i
    );

    const duplicate = terminalRequest();
    duplicate.proposed_entity_references = [proposedReference('ref-1'), proposedReference('ref-1')];
    expect(() => commitChatTurnTerminalStateInDb(db, duplicate, () => 99)).toThrow(
      /duplicate proposed/i
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM entity_references').get()).toEqual({
      count: 0,
    });
  });

  it('rejects duplicate reference joins in one terminal message before mutation', () => {
    createChatTurnWithUserMessageInDb(db, request(), () => 20);
    const input = terminalRequest();
    input.messages[0].reference_ids = ['ref-1', 'ref-1'];
    input.proposed_entity_references = [proposedReference('ref-1')];

    expect(() => commitChatTurnTerminalStateInDb(db, input, () => 99)).toThrow(
      /duplicate reference/i
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM entity_references').get()).toEqual({
      count: 0,
    });
  });

  it('rolls back terminal status and every terminal message when one insert fails', () => {
    createChatTurnWithUserMessageInDb(db, request(), () => 20);
    const input = terminalRequest();
    input.messages.push({
      message: { ...input.messages[0].message, id: 'msg-1', content: 'collides' },
      reference_ids: [],
    });

    expect(() => commitChatTurnTerminalStateInDb(db, input, () => 99)).toThrow();

    expect(db.prepare('SELECT status FROM chat_turns WHERE id = ?').get('turn-1')).toEqual({
      status: 'running',
    });
    expect(db.prepare('SELECT id FROM messages WHERE id = ?').get('msg-2')).toBeUndefined();
    expect(db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('conv-1')).toEqual({
      updated_at: 20,
    });
  });

  it('makes a repeated terminal commit an idempotent no-op', () => {
    createChatTurnWithUserMessageInDb(db, request(), () => 20);
    insertReference('ref-1');
    const input = terminalRequest();

    expect(commitChatTurnTerminalStateInDb(db, input, () => 99)).toEqual({ committed: true });
    expect(commitChatTurnTerminalStateInDb(db, input, () => 110)).toEqual({ committed: false });
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get('msg-2')).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('conv-1')).toEqual({
      updated_at: 99,
    });
  });

  function insertReference(id: string): void {
    db.prepare(
      `INSERT INTO entity_references (
        id, entity_type, display_label, locator, source, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, 'structure_selection', 'Selection', '{}', 'ai', 'created', 1, 1);
  }
});

function request(): CreateChatTurnWithUserMessageRequest {
  return {
    turn: {
      id: 'turn-1',
      conversation_id: 'conv-1',
      route_kind: 'cli',
      host_id: 'codex-cli',
      provider: null,
      model: null,
      transport: 'codex-sdk',
      authority_profile_id: 'codex-sdk:native-cli',
      permission_mode: 'native-cli',
      route_snapshot_json: '{"kind":"cli","transport":"codex-sdk"}',
      status: 'running',
      terminal_reason: null,
      error: null,
      started_at: 10,
      completed_at: null,
    },
    message: {
      id: 'msg-1',
      conversation_id: 'conv-1',
      role: 'user',
      content: 'Start a long chat',
      tool_name: null,
      tool_call_id: null,
      created_at: 11,
    },
  };
}

function terminalRequest(): CommitChatTurnTerminalStateRequest {
  return {
    turn_id: 'turn-1',
    conversation_id: 'conv-1',
    status: 'completed',
    terminal_reason: 'completed',
    error: null,
    completed_at: 90,
    messages: [
      {
        message: {
          id: 'msg-2',
          conversation_id: 'conv-1',
          turn_id: 'turn-1',
          role: 'assistant',
          content: 'Finished',
          tool_name: null,
          tool_call_id: null,
          created_at: 80,
        },
        reference_ids: ['ref-1'],
      },
    ],
  };
}

function proposedReference(id: string) {
  return {
    id,
    entity_type: 'sequence',
    display_label: 'pUC19.gb',
    locator: 'git://Research Workspace/constructs/pUC19.gb',
    deep_link_params: null,
    data: null,
    source: 'ai',
    status: 'created',
    workspace_scope: 'file:/workspace',
    workspace_root_path: '/workspace',
    created_at: 70,
    updated_at: 70,
  };
}
