import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { ensureSchema, CURRENT_SCHEMA_VERSION } from '../schema';
import { SchemaVersionTooNewError } from '../native-module-error';
import { createTestDb } from './test-db';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

function getTableNames(database: Database.Database): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function getIndexNames(database: Database.Database): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function getColumnNames(database: Database.Database, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('ensureSchema', () => {
  it('leaves new chat titles eligible for automatic naming', () => {
    ensureSchema(db, ':memory:');
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('new-chat', 'New conversation', 1, 1);

    expect(
      db.prepare('SELECT title_locked FROM conversations WHERE id = ?').get('new-chat')
    ).toEqual({ title_locked: 0 });
  });

  it('locks existing chat titles when repairing a current-version database', () => {
    ensureSchema(db, ':memory:');
    db.exec('ALTER TABLE conversations DROP COLUMN title_locked');
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('existing-chat', 'Opening prompt', 1, 1);

    ensureSchema(db, ':memory:');

    expect(
      db.prepare('SELECT title, title_locked FROM conversations WHERE id = ?').get('existing-chat')
    ).toEqual({ title: 'Opening prompt', title_locked: 1 });
  });

  it('creates all core tables on a fresh database', () => {
    ensureSchema(db, ':memory:');
    const tables = getTableNames(db);

    expect(tables).toContain('settings');
    expect(tables).toContain('workspaces');
    expect(tables).toContain('indexed_files');
    expect(tables).toContain('sequences');
    expect(tables).toContain('pages');
    expect(tables).toContain('conversations');
    expect(tables).toContain('messages');
    expect(tables).toContain('entity_references');
    expect(tables).toContain('entity_reference_revisions');
    expect(tables).toContain('message_references');
    expect(tables).toContain('primers');
    expect(tables).toContain('primer_bindings');
    expect(tables).toContain('catalog_entities');
    expect(tables).toContain('catalog_entity_files');
    expect(tables).toContain('catalog_entity_links');
    expect(tables).toContain('catalog_entity_events');
    expect(tables).toContain('catalog_provider_bindings');
    expect(tables).toContain('catalog_workspace_placements');
    expect(tables).toContain('agent_sessions');
    expect(tables).toContain('agent_trace_events');
    expect(tables).toContain('agent_output_artifacts');
    expect(tables).toContain('chat_turns');
    expect(tables).toContain('workspace_sync_device');
    expect(tables).toContain('workspace_sync_bindings');
    expect(tables).toContain('workspace_sync_queue');
    expect(tables).toContain('workspace_sync_versions');
    expect(tables).toContain('workspace_sync_restore_locks');
    expect(getColumnNames(db, 'messages')).toContain('turn_id');
    expect(getColumnNames(db, 'entity_references')).toContain('workspace_scope');
    expect(getColumnNames(db, 'entity_references')).toContain('workspace_root_path');
    expect(getIndexNames(db)).toContain('idx_entity_refs_workspace_scope');
    expect(getColumnNames(db, 'catalog_entity_files')).toEqual(
      expect.arrayContaining(['status', 'last_seen_at', 'missing_since'])
    );
    expect(getColumnNames(db, 'chat_turns')).toEqual(
      expect.arrayContaining([
        'conversation_id',
        'route_kind',
        'host_id',
        'provider',
        'model',
        'transport',
        'authority_profile_id',
        'permission_mode',
        'route_snapshot_json',
        'status',
        'terminal_reason',
        'error',
        'started_at',
        'completed_at',
      ])
    );
    expect(getColumnNames(db, 'agent_sessions')).toEqual(
      expect.arrayContaining([
        'conversation_id',
        'turn_id',
        'provider',
        'authority_profile_id',
        'authority_class',
        'release_mode',
        'status',
        'cwd',
        'provider_conversation_id',
        'provider_versions_json',
        'authority_json',
        'terminal_reason',
      ])
    );
    expect(getColumnNames(db, 'agent_trace_events')).toEqual(
      expect.arrayContaining([
        'session_id',
        'sequence',
        'provider',
        'event_type',
        'render_snapshot_json',
        'terminal',
      ])
    );
    expect(getColumnNames(db, 'agent_output_artifacts')).toEqual(
      expect.arrayContaining([
        'session_id',
        'path',
        'relative_path',
        'kind',
        'action',
        'attribution',
        'provenance_id',
      ])
    );

    expect(tables).not.toContain('primer_pairs');

    expect(tables).not.toContain('features');
  });

  it('enforces active virtual sibling identity within one exact parent', () => {
    ensureSchema(db, ':memory:');
    db.exec(`
      INSERT INTO workspaces (id, name, path, created_at)
      VALUES (1, 'Project', '/project', 1);
      INSERT INTO catalog_entities
        (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
      VALUES
        ('strain-1', 'sample', 'CAFÉ', 'entity://lims/strain-1', 'database', 'active', 1, 1, 1),
        ('strain-2', 'sample', 'Cafe 2', 'entity://lims/strain-2', 'database', 'active', 1, 1, 1),
        ('strain-3', 'sample', 'Cafe 3', 'entity://lims/strain-3', 'database', 'active', 1, 1, 1);
      INSERT INTO catalog_workspace_placements
        (entity_id, workspace_id, parent_relative_path, display_name,
         normalized_sibling_name, presentation_kind, status, created_at, updated_at)
      VALUES
        ('strain-1', 1, 'Collections/Strains', 'CAFÉ', 'café', 'strain', 'active', 1, 1);
    `);

    expect(() =>
      db
        .prepare(
          `INSERT INTO catalog_workspace_placements
           (entity_id, workspace_id, parent_relative_path, display_name,
            normalized_sibling_name, presentation_kind, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('strain-2', 1, 'Collections/Strains', 'cafe\u0301', 'café', 'strain', 'active', 1, 1)
    ).toThrow(/unique/i);

    expect(() =>
      db
        .prepare(
          `INSERT INTO catalog_workspace_placements
           (entity_id, workspace_id, parent_relative_path, display_name,
            normalized_sibling_name, presentation_kind, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('strain-2', 1, 'Collections/Other', 'cafe\u0301', 'café', 'strain', 'active', 1, 1)
    ).not.toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO catalog_workspace_placements
           (entity_id, workspace_id, parent_relative_path, display_name,
            normalized_sibling_name, presentation_kind, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('strain-3', 1, 'Collections/Strains', 'cafe\u0301', 'café', 'strain', 'hidden', 1, 1)
    ).not.toThrow();
  });

  it('creates all indexes', () => {
    ensureSchema(db, ':memory:');
    const indexes = getIndexNames(db);

    expect(indexes).toContain('idx_indexed_files_workspace');
    expect(indexes).toContain('idx_sequences_file');
    expect(indexes).toContain('idx_messages_conversation');
    expect(indexes).toContain('idx_conversations_workspace');
    expect(indexes).toContain('idx_entity_refs_locator');
    expect(indexes).toContain('idx_entity_ref_revisions');
    expect(indexes).toContain('idx_primers_workspace');
    expect(indexes).toContain('idx_primer_bindings_primer');
    expect(indexes).toContain('idx_primer_bindings_sequence');
    expect(indexes).toContain('idx_catalog_entities_type');
    expect(indexes).toContain('idx_catalog_entities_workspace');
    expect(indexes).toContain('idx_catalog_entity_files_entity');
    expect(indexes).toContain('idx_catalog_entity_files_workspace');
    expect(indexes).toContain('idx_catalog_entity_files_status');
    expect(indexes).toContain('idx_catalog_entity_links_source');
    expect(indexes).toContain('idx_catalog_entity_links_target');
    expect(indexes).toContain('idx_catalog_entity_events_entity');
    expect(indexes).toContain('idx_catalog_provider_bindings_identity');
    expect(indexes).toContain('idx_catalog_provider_bindings_entity');
    expect(indexes).toContain('idx_catalog_workspace_placements_active_sibling');
    expect(indexes).toContain('idx_catalog_workspace_placements_parent');
    expect(indexes).toContain('idx_catalog_entity_events_type');
    expect(indexes).toContain('idx_agent_sessions_conversation');
    expect(indexes).toContain('idx_agent_sessions_status');
    expect(indexes).toContain('idx_chat_turns_conversation_started');
    expect(indexes).toContain('idx_messages_turn');
    expect(indexes).toContain('idx_agent_sessions_turn');
    expect(indexes).toContain('idx_agent_trace_events_session');
    expect(indexes).toContain('idx_agent_output_artifacts_session');
    expect(indexes).toContain('idx_workspace_sync_bindings_owner');
    expect(indexes).toContain('idx_workspace_sync_bindings_remote_workspace');
    expect(indexes).toContain('idx_workspace_sync_queue_workspace_status');
    expect(indexes).toContain('idx_workspace_sync_queue_next_attempt');
    expect(indexes).toContain('idx_workspace_sync_versions_workspace_number');
    expect(indexes).toContain('idx_workspace_sync_versions_latest');
    expect(indexes).not.toContain('idx_features_sequence');
    expect(indexes).not.toContain('idx_features_type');
  });

  it('adds fail-closed workspace ownership to a legacy entity_references table', () => {
    db.exec(`
      CREATE TABLE entity_references (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        display_label TEXT NOT NULL,
        locator TEXT NOT NULL,
        deep_link_params TEXT,
        data TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO entity_references (
        id, entity_type, display_label, locator, source, created_at, updated_at
      ) VALUES ('legacy-ref', 'structure', 'Legacy', 'structure:legacy', 'user', 1, 1);
    `);

    ensureSchema(db, ':memory:');

    expect(getColumnNames(db, 'entity_references')).toContain('workspace_scope');
    expect(getColumnNames(db, 'entity_references')).toContain('workspace_root_path');
    expect(
      db
        .prepare(
          `SELECT workspace_scope, workspace_root_path FROM entity_references WHERE id = 'legacy-ref'`
        )
        .get()
    ).toEqual({ workspace_scope: null, workspace_root_path: null });
    expect(getIndexNames(db)).toContain('idx_entity_refs_workspace_scope');
  });

  it('migrates an already-current v18 database to workspace-scoped entity references', () => {
    db.exec(`
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        repo_uuid TEXT, origin_path TEXT, archived_at INTEGER, trashed_at INTEGER,
        created_at INTEGER NOT NULL, last_opened_at INTEGER
      );
      CREATE TABLE entity_references (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        display_label TEXT NOT NULL,
        locator TEXT NOT NULL,
        deep_link_params TEXT,
        data TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO entity_references (
        id, entity_type, display_label, locator, source, created_at, updated_at
      ) VALUES ('v18-ref', 'structure', 'V18', 'structure:v18', 'user', 1, 1);
      PRAGMA user_version = 18;
    `);

    ensureSchema(db, ':memory:');

    expect(
      db
        .prepare('SELECT reason FROM notebook_saved_reference_retention WHERE reference_id=?')
        .get('v18-ref')
    ).toEqual({ reason: 'legacy-unknown' });
    expect(() => db.prepare('DELETE FROM entity_references WHERE id=?').run('v18-ref')).toThrow(
      /must be retained/
    );
    expect(getColumnNames(db, 'entity_references')).toContain('workspace_scope');
    expect(getColumnNames(db, 'entity_references')).toContain('workspace_root_path');
    expect(
      db
        .prepare(
          `SELECT workspace_scope, workspace_root_path FROM entity_references WHERE id = 'v18-ref'`
        )
        .get()
    ).toEqual({ workspace_scope: null, workspace_root_path: null });
    expect(getIndexNames(db)).toContain('idx_entity_refs_workspace_scope');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('links messages and agent sessions to a chat turn while preserving legacy null turn ids', () => {
    ensureSchema(db, ':memory:');

    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('conv-turns', 'Turned chat', 1, 1, 'openai', 'gpt-4o-mini');
    db.prepare(
      `INSERT INTO chat_turns (
        id, conversation_id, route_kind, host_id, provider, model, transport,
        authority_profile_id, permission_mode, route_snapshot_json, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-1',
      'conv-turns',
      'provider',
      'direct-api',
      'openai',
      'gpt-4o-mini',
      null,
      null,
      null,
      '{"kind":"provider","provider":"openai","model":"gpt-4o-mini"}',
      'running',
      10
    );
    db.prepare(
      `INSERT INTO messages (id, conversation_id, turn_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('msg-linked', 'conv-turns', 'turn-1', 'user', 'hello', 11);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('msg-legacy', 'conv-turns', 'user', 'legacy', 12);
    db.prepare(
      `
        INSERT INTO agent_sessions (
          id, conversation_id, turn_id, provider, authority_profile_id, authority_class,
          release_mode, permission_mode_label, status, cwd, provider_versions_json,
          authority_json, started_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      'session-linked',
      'conv-turns',
      'turn-1',
      'codex-sdk',
      'codex-sdk:app-supervised',
      'app-supervised',
      'read_only',
      'app-supervised',
      'running',
      '/workspace',
      '{}',
      '{}',
      13,
      13
    );

    expect(db.prepare('SELECT turn_id FROM messages WHERE id = ?').get('msg-linked')).toEqual({
      turn_id: 'turn-1',
    });
    expect(db.prepare('SELECT turn_id FROM messages WHERE id = ?').get('msg-legacy')).toEqual({
      turn_id: null,
    });
    expect(
      db.prepare('SELECT turn_id FROM agent_sessions WHERE id = ?').get('session-linked')
    ).toEqual({ turn_id: 'turn-1' });
  });

  it('sets user_version to CURRENT_SCHEMA_VERSION', () => {
    ensureSchema(db, ':memory:');
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is idempotent — running twice does not error', () => {
    ensureSchema(db, ':memory:');
    expect(() => ensureSchema(db, ':memory:')).not.toThrow();

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    expect(getTableNames(db)).toContain('settings');
  });

  it('repairs the provider conversation handle onto an already-current database', () => {
    ensureSchema(db, ':memory:');
    db.exec('ALTER TABLE agent_sessions DROP COLUMN provider_conversation_id');
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    ensureSchema(db, ':memory:');

    expect(getColumnNames(db, 'agent_sessions')).toContain('provider_conversation_id');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('repairs the capsule table after the v22 branch collision on an already-current database', () => {
    ensureSchema(db, ':memory:');
    db.exec('DROP TABLE agent_state_capsules');
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    ensureSchema(db, ':memory:');

    expect(getTableNames(db)).toContain('agent_state_capsules');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('repairs the placement table on an already-current database', () => {
    ensureSchema(db, ':memory:');
    db.exec('DROP TABLE catalog_workspace_placements');
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    ensureSchema(db, ':memory:');

    expect(getTableNames(db)).toContain('catalog_workspace_placements');
    expect(getIndexNames(db)).toContain('idx_catalog_workspace_placements_active_sibling');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('repairs the SSH endpoint table on an already-current organization-v38 database', () => {
    ensureSchema(db, ':memory:');
    db.exec('DROP TABLE remote_endpoint_profiles');
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    ensureSchema(db, ':memory:');

    expect(getTableNames(db)).toContain('remote_endpoint_profiles');
    expect(getIndexNames(db)).toContain('idx_remote_endpoint_profiles_recent');
    expect(getTableNames(db)).toContain('org_registry_sync_state');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('repairs the organization tables on an already-current SSH-v38 database', () => {
    ensureSchema(db, ':memory:');
    db.exec(`
      DROP TABLE org_registry_conflicts;
      DROP TABLE org_registry_outbox;
      DROP TABLE org_registry_cache;
      DROP TABLE org_registry_sync_state;
    `);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    ensureSchema(db, ':memory:');

    expect(getTableNames(db)).toEqual(
      expect.arrayContaining([
        'remote_endpoint_profiles',
        'org_registry_sync_state',
        'org_registry_cache',
        'org_registry_outbox',
        'org_registry_conflicts',
      ])
    );
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('fresh database starts at user_version 0 and migrates to current', () => {
    const initialVersion = db.pragma('user_version', { simple: true }) as number;
    expect(initialVersion).toBe(0);

    ensureSchema(db, ':memory:');

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    expect(getTableNames(db)).toContain('settings');
  });

  it('settings table has key, value, updated_at columns', () => {
    ensureSchema(db, ':memory:');
    const columns = getColumnNames(db, 'settings');
    expect(columns).toContain('key');
    expect(columns).toContain('value');
    expect(columns).toContain('updated_at');
  });

  it('conversations table has pinned, provider, model columns', () => {
    ensureSchema(db, ':memory:');
    const columns = getColumnNames(db, 'conversations');
    expect(columns).toContain('pinned');
    expect(columns).toContain('provider');
    expect(columns).toContain('model');
  });

  it('backfills null provider to anthropic on re-migration', () => {
    ensureSchema(db, ':memory:');

    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('test-conv', 'Test', Date.now(), Date.now());
    db.prepare('UPDATE conversations SET provider = NULL WHERE id = ?').run('test-conv');

    db.pragma('user_version = 0');
    ensureSchema(db, ':memory:');

    const row = db.prepare('SELECT provider FROM conversations WHERE id = ?').get('test-conv') as {
      provider: string;
    };
    expect(row.provider).toBe('anthropic');
  });

  it('drops old primer tables when primer_bindings has computed_at column', () => {
    db.exec(
      'CREATE TABLE primers (id INTEGER PRIMARY KEY);' +
        'CREATE TABLE primer_pairs (id INTEGER PRIMARY KEY);' +
        'CREATE TABLE primer_bindings (id INTEGER PRIMARY KEY, computed_at INTEGER)'
    );

    ensureSchema(db, ':memory:');

    const columns = getColumnNames(db, 'primer_bindings');
    expect(columns).not.toContain('computed_at');
  });

  it('drops old primer tables when primers has target_sequence_id column', () => {
    db.exec(
      'CREATE TABLE primers (id INTEGER PRIMARY KEY, target_sequence_id TEXT);' +
        'CREATE TABLE primer_pairs (id INTEGER PRIMARY KEY);' +
        'CREATE TABLE primer_bindings (id INTEGER PRIMARY KEY)'
    );

    ensureSchema(db, ':memory:');

    const columns = getColumnNames(db, 'primers');
    expect(columns).not.toContain('target_sequence_id');
  });

  it('does not drop primer tables when schema is already current', () => {
    ensureSchema(db, ':memory:');

    db.prepare(
      'INSERT INTO primers (id, name, sequence, length, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('p1', 'Primer1', 'ATCG', 4, Date.now(), Date.now());

    db.pragma('user_version = 0');
    ensureSchema(db, ':memory:');

    const row = db.prepare('SELECT id FROM primers WHERE id = ?').get('p1') as { id: string };
    expect(row?.id).toBe('p1');
  });
});

function buildV1PrimerSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_opened_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS indexed_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      extension TEXT NOT NULL,
      size_bytes INTEGER,
      modified_at INTEGER,
      indexed_at INTEGER NOT NULL,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      length INTEGER NOT NULL,
      sequence_type TEXT,
      circular INTEGER DEFAULT 0,
      sequence TEXT
    );
    CREATE TABLE primers (
      id TEXT PRIMARY KEY,
      catalog_number TEXT UNIQUE,
      name TEXT NOT NULL,
      sequence TEXT NOT NULL,
      direction TEXT,
      length INTEGER NOT NULL,
      tm REAL,
      gc_percent REAL,
      origin TEXT,
      origin_details TEXT,
      status TEXT DEFAULT 'designed',
      vendor TEXT,
      order_date INTEGER,
      application TEXT,
      scale TEXT,
      purification TEXT,
      modifications TEXT,
      stock_location TEXT,
      concentration REAL,
      notes TEXT,
      workspace_id INTEGER REFERENCES workspaces(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE primer_pairs (
      id TEXT PRIMARY KEY,
      forward_primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE,
      reverse_primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE,
      expected_product_size INTEGER,
      application TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE primer_bindings (
      id TEXT PRIMARY KEY,
      primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE,
      sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
      binding_start INTEGER NOT NULL,
      binding_end INTEGER NOT NULL,
      strand INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(primer_id, sequence_id, binding_start)
    );
  `);
}

describe('migrateToV2 ', () => {
  function seedV1WithLegacyData(database: Database.Database): {
    forwardPrimerId: string;
    reversePrimerId: string;
    nullDirPrimerId: string;
    fwdBindingId: string;
    revBindingId: string;
    nullStrandFwdBindingId: string;
    nullStrandRevBindingId: string;
    nullStrandNullDirBindingId: string;
    sequenceId: number;
  } {
    buildV1PrimerSchema(database);

    const now = Date.now();
    database
      .prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)')
      .run('ws', '/tmp/ws', now);
    database
      .prepare(
        'INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(1, '/tmp/ws/seq.gb', 'seq.gb', 'gb', now);
    database
      .prepare('INSERT INTO sequences (file_id, name, length) VALUES (?, ?, ?)')
      .run(1, 'seq', 1000);

    const insertPrimer = database.prepare(
      'INSERT INTO primers (id, catalog_number, name, sequence, direction, length, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertPrimer.run('p-fwd', 'P001', 'fwd', 'ATCGATCGATCG', 'forward', 12, now, now);
    insertPrimer.run('p-rev', 'P002', 'rev', 'TTTTAAAACCCC', 'reverse', 12, now, now);
    insertPrimer.run('p-null', 'P003', 'null', 'GGGGCCCCAAAA', null, 12, now, now);

    const insertBinding = database.prepare(
      'INSERT INTO primer_bindings (id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertBinding.run('b-fwd', 'p-fwd', 1, 100, 112, 1, 'manual', now, now);
    insertBinding.run('b-rev', 'p-rev', 1, 200, 212, -1, 'manual', now, now);
    insertBinding.run('b-null-fwd', 'p-fwd', 1, 300, 312, null, 'manual', now, now);
    insertBinding.run('b-null-rev', 'p-rev', 1, 400, 412, null, 'manual', now, now);
    insertBinding.run('b-null-null', 'p-null', 1, 500, 512, null, 'manual', now, now);

    database.pragma('user_version = 1');

    return {
      forwardPrimerId: 'p-fwd',
      reversePrimerId: 'p-rev',
      nullDirPrimerId: 'p-null',
      fwdBindingId: 'b-fwd',
      revBindingId: 'b-rev',
      nullStrandFwdBindingId: 'b-null-fwd',
      nullStrandRevBindingId: 'b-null-rev',
      nullStrandNullDirBindingId: 'b-null-null',
      sequenceId: 1,
    };
  }

  it('drops primers.direction column', () => {
    seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');
    expect(getColumnNames(db, 'primers')).not.toContain('direction');
  });

  it('drops the primer_pairs table', () => {
    seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');
    expect(getTableNames(db)).not.toContain('primer_pairs');
  });

  it('makes primer_bindings.strand NOT NULL with default 1', () => {
    seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');

    const cols = db.prepare(`PRAGMA table_info(primer_bindings)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const strand = cols.find((c) => c.name === 'strand');
    expect(strand).toBeDefined();
    expect(strand!.notnull).toBe(1);
    expect(strand!.dflt_value).toBe('1');
  });

  it('preserves rows with explicit strand values across rebuild', () => {
    const seed = seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');

    const fwdBinding = db
      .prepare('SELECT strand FROM primer_bindings WHERE id = ?')
      .get(seed.fwdBindingId) as { strand: number };
    const revBinding = db
      .prepare('SELECT strand FROM primer_bindings WHERE id = ?')
      .get(seed.revBindingId) as { strand: number };

    expect(fwdBinding.strand).toBe(1);
    expect(revBinding.strand).toBe(-1);
  });

  it('backfills null strand from primer.direction before dropping the column', () => {
    const seed = seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');

    const fwd = db
      .prepare('SELECT strand FROM primer_bindings WHERE id = ?')
      .get(seed.nullStrandFwdBindingId) as { strand: number };
    const rev = db
      .prepare('SELECT strand FROM primer_bindings WHERE id = ?')
      .get(seed.nullStrandRevBindingId) as { strand: number };
    const nullDir = db
      .prepare('SELECT strand FROM primer_bindings WHERE id = ?')
      .get(seed.nullStrandNullDirBindingId) as { strand: number };

    expect(fwd.strand).toBe(1);
    expect(rev.strand).toBe(-1);
    expect(nullDir.strand).toBe(1);
  });

  it('lands at current user_version after running on a v1 DB', () => {
    seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is idempotent — running the chain twice is a no-op the second time', () => {
    seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');

    db.exec(`
      DELETE FROM lims_safety_legacy_scan_candidates;
      UPDATE lims_safety_legacy_scan_state
      SET status = 'completed', completed_at = 1
      WHERE id = 1
    `);

    db.pragma('user_version = 1');
    expect(() => ensureSchema(db, ':memory:')).not.toThrow();

    expect(getColumnNames(db, 'primers')).not.toContain('direction');
    expect(getTableNames(db)).not.toContain('primer_pairs');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('migrates an empty v1 DB (zero primers, zero bindings) cleanly', () => {
    buildV1PrimerSchema(db);
    db.pragma('user_version = 1');
    ensureSchema(db, ':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(getColumnNames(db, 'primers')).not.toContain('direction');
    expect(getTableNames(db)).not.toContain('primer_pairs');
  });

  it('aborts via foreign_key_check when an orphan primer_binding exists', () => {
    buildV1PrimerSchema(db);
    const now = Date.now();
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'ws',
      '/tmp/ws',
      now
    );
    db.prepare(
      'INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(1, '/tmp/ws/seq.gb', 'seq.gb', 'gb', now);
    db.prepare('INSERT INTO sequences (file_id, name, length) VALUES (?, ?, ?)').run(1, 'seq', 100);

    db.pragma('foreign_keys = OFF');
    db.prepare(
      'INSERT INTO primer_bindings (id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('orphan', 'ghost-primer', 1, 0, 10, 1, 'manual', now, now);
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 1');

    expect(() => ensureSchema(db, ':memory:')).toThrow(/foreign_key_check/);

    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('recreates indexes after the rebuild on a v1 DB', () => {
    seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');
    const indexes = getIndexNames(db);
    expect(indexes).toContain('idx_primers_workspace');
    expect(indexes).toContain('idx_primer_bindings_primer');
    expect(indexes).toContain('idx_primer_bindings_sequence');
  });

  it('resumes from a partial state — direction already gone, primer_pairs still present', () => {
    db.exec(`
      CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_opened_at INTEGER);
      CREATE TABLE indexed_files (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT NOT NULL, indexed_at INTEGER NOT NULL);
      CREATE TABLE sequences (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL REFERENCES indexed_files(id), name TEXT NOT NULL, length INTEGER NOT NULL);
      CREATE TABLE primers (id TEXT PRIMARY KEY, catalog_number TEXT UNIQUE, name TEXT NOT NULL, sequence TEXT NOT NULL, length INTEGER NOT NULL, tm REAL, gc_percent REAL, origin TEXT, origin_details TEXT, status TEXT, vendor TEXT, order_date INTEGER, application TEXT, scale TEXT, purification TEXT, modifications TEXT, stock_location TEXT, concentration REAL, notes TEXT, workspace_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE primer_pairs (id TEXT PRIMARY KEY, forward_primer_id TEXT NOT NULL REFERENCES primers(id), reverse_primer_id TEXT NOT NULL REFERENCES primers(id), expected_product_size INTEGER, application TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE primer_bindings (id TEXT PRIMARY KEY, primer_id TEXT NOT NULL REFERENCES primers(id), sequence_id INTEGER NOT NULL REFERENCES sequences(id), binding_start INTEGER NOT NULL, binding_end INTEGER NOT NULL, strand INTEGER, source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(primer_id, sequence_id, binding_start));
    `);
    db.pragma('user_version = 1');

    ensureSchema(db, ':memory:');

    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(getColumnNames(db, 'primers')).not.toContain('direction');
    expect(getTableNames(db)).not.toContain('primer_pairs');
    const strand = db
      .prepare(`SELECT [notnull] FROM pragma_table_info('primer_bindings') WHERE name = 'strand'`)
      .get() as { notnull: number };
    expect(strand.notnull).toBe(1);
  });

  it('CHECK(strand IN (1, -1)) constraint is enforced on the rebuilt table', () => {
    seedV1WithLegacyData(db);
    ensureSchema(db, ':memory:');

    expect(() =>
      db
        .prepare(
          'INSERT INTO primer_bindings (id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run('bad-strand', 'p-fwd', 1, 600, 612, 0, 'manual', Date.now(), Date.now())
    ).toThrow(/CHECK constraint/);
  });

  it('backfills variant direction spellings (Reverse, REV, -1) case-insensitively', () => {
    buildV1PrimerSchema(db);
    const now = Date.now();
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'ws',
      '/tmp/ws',
      now
    );
    db.prepare(
      'INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(1, '/tmp/ws/seq.gb', 'seq.gb', 'gb', now);
    db.prepare('INSERT INTO sequences (file_id, name, length) VALUES (?, ?, ?)').run(
      1,
      'seq',
      1000
    );
    const insertPrimer = db.prepare(
      'INSERT INTO primers (id, catalog_number, name, sequence, direction, length, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertPrimer.run('p-uppercase', 'P010', 'pU', 'AAAATTTTGGGG', 'Reverse', 12, now, now);
    insertPrimer.run('p-abbrev', 'P011', 'pA', 'CCCCAAAATTTT', 'REV', 12, now, now);
    insertPrimer.run('p-numeric', 'P012', 'pN', 'GGGGAAAATTTT', '-1', 12, now, now);
    insertPrimer.run('p-whitespace', 'P013', 'pW', 'TTTTAAAACCCC', '  reverse  ', 12, now, now);

    const insertBinding = db.prepare(
      'INSERT INTO primer_bindings (id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertBinding.run('b-uc', 'p-uppercase', 1, 100, 112, null, 'manual', now, now);
    insertBinding.run('b-ab', 'p-abbrev', 1, 200, 212, null, 'manual', now, now);
    insertBinding.run('b-nu', 'p-numeric', 1, 300, 312, null, 'manual', now, now);
    insertBinding.run('b-ws', 'p-whitespace', 1, 400, 412, null, 'manual', now, now);
    db.pragma('user_version = 1');

    ensureSchema(db, ':memory:');

    const get = (id: string) =>
      db.prepare('SELECT strand FROM primer_bindings WHERE id = ?').get(id) as {
        strand: number;
      };
    expect(get('b-uc').strand).toBe(-1);
    expect(get('b-ab').strand).toBe(-1);
    expect(get('b-nu').strand).toBe(-1);
    expect(get('b-ws').strand).toBe(-1);
  });
});

describe('migrateToV8 ', () => {
  it('drops the writer-less features table and indexes from a v7 database', () => {
    db.exec(`
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER
      );
      CREATE TABLE indexed_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        extension TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE sequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        length INTEGER NOT NULL,
        sequence TEXT
      );
      CREATE TABLE features (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        strand INTEGER,
        qualifiers TEXT
      );
      CREATE INDEX idx_features_sequence ON features(sequence_id);
      CREATE INDEX idx_features_type ON features(type);
    `);
    db.pragma('user_version = 7');

    ensureSchema(db, ':memory:');

    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(getTableNames(db)).not.toContain('features');
    expect(getIndexNames(db)).not.toContain('idx_features_sequence');
    expect(getIndexNames(db)).not.toContain('idx_features_type');
  });
});

describe('ensureSchema downgrade refusal', () => {
  it('throws a structured refusal when user_version is newer than CURRENT_SCHEMA_VERSION', () => {
    ensureSchema(db, ':memory:');
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    try {
      ensureSchema(db, ':memory:');
      expect.fail('ensureSchema should refuse a database from a newer build');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaVersionTooNewError);
      expect(error).toMatchObject({
        code: 'SCHEMA_VERSION_TOO_NEW',
        dbVersion: CURRENT_SCHEMA_VERSION + 1,
        supportedVersion: CURRENT_SCHEMA_VERSION,
        appVersion: '1.0.0',
      });
    }
  });
});

describe('fresh install preserves v2 primer constraints (regression)', () => {
  it('primer_bindings table has the CHECK(strand IN (1, -1)) constraint after fresh install', () => {
    ensureSchema(db, ':memory:');
    const ddl = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='primer_bindings'`)
      .get() as { sql: string };
    expect(ddl.sql).toMatch(/CHECK\s*\(\s*strand\s+IN\s*\(\s*1\s*,\s*-1\s*\)\s*\)/i);
  });

  it('rejects strand=0 inserts on a fresh-install schema', () => {
    ensureSchema(db, ':memory:');

    const now = Date.now();
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'ws',
      '/tmp/ws',
      now
    );
    db.prepare(
      'INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(1, '/tmp/ws/seq.gb', 'seq.gb', 'gb', now);
    db.prepare('INSERT INTO sequences (file_id, name, length) VALUES (?, ?, ?)').run(1, 'seq', 100);
    db.prepare(
      'INSERT INTO primers (id, catalog_number, name, sequence, length, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('p1', 'P001', 'p', 'ATCGATCGATCG', 12, now, now);

    expect(() =>
      db
        .prepare(
          'INSERT INTO primer_bindings (id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run('b-zero', 'p1', 1, 0, 12, 0, 'manual', now, now)
    ).toThrow(/CHECK constraint/);
  });
});
