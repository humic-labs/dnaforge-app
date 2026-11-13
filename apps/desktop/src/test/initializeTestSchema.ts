import { initPlatform } from '../platform';

export async function initializeTestSchema(): Promise<void> {
  const sqlite = (await initPlatform()).db;

  await sqlite.execute('PRAGMA foreign_keys = ON');

  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_opened_at INTEGER, repo_uuid TEXT, origin_path TEXT, archived_at INTEGER, trashed_at INTEGER, access_mode TEXT NOT NULL DEFAULT 'writable' CHECK(access_mode IN ('writable', 'reference')))`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS indexed_files (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT NOT NULL, size_bytes INTEGER, modified_at INTEGER, indexed_at INTEGER NOT NULL, metadata TEXT)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS sequences (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT, length INTEGER NOT NULL, sequence_type TEXT, circular INTEGER DEFAULT 0, sequence TEXT)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, date INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS catalog_entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, locator TEXT NOT NULL UNIQUE, storage_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL, metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS catalog_entity_files (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE, workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL, path TEXT NOT NULL UNIQUE, relative_path TEXT, file_kind TEXT NOT NULL, content_hash TEXT, size_bytes INTEGER, modified_at INTEGER, status TEXT NOT NULL DEFAULT 'current', last_seen_at INTEGER, missing_since INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS catalog_entity_links (id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE, relation TEXT NOT NULL, target_entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE, confidence TEXT NOT NULL DEFAULT 'suggested', evidence TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source_entity_id, relation, target_entity_id))`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS catalog_entity_events (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE, event_type TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'user', summary TEXT, payload TEXT, created_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS catalog_provider_bindings (id TEXT PRIMARY KEY, provider TEXT NOT NULL, stable_object_id TEXT NOT NULL, object_class TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE, binding_kind TEXT NOT NULL CHECK(binding_kind IN ('observed', 'reviewed')), provider_account_hint TEXT, canonical_url TEXT, evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(provider, stable_object_id, object_class, entity_id))`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_provider_bindings_identity ON catalog_provider_bindings(provider, stable_object_id, object_class)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_provider_bindings_entity ON catalog_provider_bindings(entity_id)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS catalog_workspace_placements (entity_id TEXT PRIMARY KEY REFERENCES catalog_entities(id) ON DELETE CASCADE, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, parent_relative_path TEXT NOT NULL, display_name TEXT NOT NULL, normalized_sibling_name TEXT NOT NULL, presentation_kind TEXT NOT NULL CHECK(presentation_kind IN ('strain', 'sequence', 'record')), status TEXT NOT NULL CHECK(status IN ('active', 'hidden')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_workspace_placements_active_sibling ON catalog_workspace_placements(workspace_id, parent_relative_path, normalized_sibling_name) WHERE status = 'active'`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_workspace_placements_parent ON catalog_workspace_placements(workspace_id, parent_relative_path, status, normalized_sibling_name, entity_id)`
  );

  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, title_locked INTEGER NOT NULL DEFAULT 0, workspace_path TEXT, pinned INTEGER NOT NULL DEFAULT 0, provider TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, tool_call_id TEXT, created_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL, provider TEXT NOT NULL, authority_profile_id TEXT NOT NULL, authority_class TEXT NOT NULL, release_mode TEXT NOT NULL, permission_mode_label TEXT, status TEXT NOT NULL, cwd TEXT NOT NULL, output_root TEXT, provider_versions_json TEXT NOT NULL, authority_json TEXT NOT NULL, terminal_reason TEXT, telemetry_had_workspace_context INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_had_workspace_context IN (0, 1)), telemetry_continuation INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_continuation IN (0, 1)), started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS agent_trace_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, provider TEXT NOT NULL, event_type TEXT NOT NULL, render_snapshot_json TEXT NOT NULL, terminal TEXT, created_at INTEGER NOT NULL, UNIQUE(session_id, sequence))`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS agent_output_artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, path TEXT NOT NULL, relative_path TEXT, kind TEXT NOT NULL, action TEXT NOT NULL, attribution TEXT NOT NULL, checksum TEXT, provenance_id TEXT, created_at INTEGER NOT NULL)`
  );

  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS entity_references (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, display_label TEXT NOT NULL, locator TEXT NOT NULL, deep_link_params TEXT, data TEXT, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created', workspace_scope TEXT, workspace_root_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS entity_reference_revisions (id TEXT PRIMARY KEY, reference_id TEXT NOT NULL REFERENCES entity_references(id) ON DELETE CASCADE, revision_number INTEGER NOT NULL, changed_by TEXT NOT NULL, change_type TEXT NOT NULL, previous_state TEXT, new_state TEXT, created_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS message_references (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, reference_id TEXT NOT NULL REFERENCES entity_references(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (message_id, reference_id))`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS message_attachments (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, attachment_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind = 'text'), PRIMARY KEY (message_id, attachment_id))`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS agent_structured_outputs (turn_id TEXT PRIMARY KEY, schema_json TEXT NOT NULL, raw_result TEXT NOT NULL, validation_status TEXT NOT NULL CHECK(validation_status IN ('valid', 'invalid')), parsed_json TEXT, validation_error TEXT, artifact_id TEXT NOT NULL, created_at INTEGER NOT NULL)`
  );

  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS primers (id TEXT PRIMARY KEY, catalog_number TEXT UNIQUE, name TEXT NOT NULL, sequence TEXT NOT NULL, length INTEGER NOT NULL, tm REAL, gc_percent REAL, origin TEXT, origin_details TEXT, status TEXT DEFAULT 'designed', vendor TEXT, order_date INTEGER, application TEXT, scale TEXT, purification TEXT, modifications TEXT, stock_location TEXT, concentration REAL, notes TEXT, workspace_id INTEGER REFERENCES workspaces(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS primer_bindings (id TEXT PRIMARY KEY, primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE, sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE, binding_start INTEGER NOT NULL, binding_end INTEGER NOT NULL, strand INTEGER NOT NULL DEFAULT 1 CHECK(strand IN (1, -1)), source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(primer_id, sequence_id, binding_start))`
  );

  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_indexed_files_workspace ON indexed_files(workspace_id)`
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_sequences_file ON sequences(file_id)`);
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_path)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_entity_refs_locator ON entity_references(locator)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_entity_ref_revisions ON entity_reference_revisions(reference_id)`
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_primers_workspace ON primers(workspace_id)`);
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_primer_bindings_primer ON primer_bindings(primer_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_primer_bindings_sequence ON primer_bindings(sequence_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entities_type ON catalog_entities(type)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entities_workspace ON catalog_entities(workspace_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_files_entity ON catalog_entity_files(entity_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_files_workspace ON catalog_entity_files(workspace_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_files_status ON catalog_entity_files(status)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_links_source ON catalog_entity_links(source_entity_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_links_target ON catalog_entity_links(target_entity_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_events_entity ON catalog_entity_events(entity_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_events_type ON catalog_entity_events(event_type)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation ON agent_sessions(conversation_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_agent_trace_events_session ON agent_trace_events(session_id)`
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_agent_output_artifacts_session ON agent_output_artifacts(session_id)`
  );
}
