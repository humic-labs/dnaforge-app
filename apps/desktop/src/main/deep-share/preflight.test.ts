import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../schema';
import { createTestDb } from '../__tests__/test-db';
import { buildDeepSharePreflight, DeepSharePreflightError } from './preflight';

describe('buildDeepSharePreflight', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });

  it('builds an exact selected-artifact and portable-chat manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deep-share-preflight-'));
    await mkdir(join(root, 'Design'), { recursive: true });
    await writeFile(join(root, 'Design', 'design.wpdesign.json'), '{"name":"Design"}\n');
    await writeFile(join(root, 'Design', 'primer.primer.json'), '{"name":"Primer"}\n');
    await writeFile(join(root, 'unrelated.gb'), 'LOCUS unrelated\n');
    seedWorkspace(db, root);
    seedEntity(db, {
      id: 'design-1',
      type: 'design',
      name: 'Design',
      locator: 'design:design-1',
      path: join(root, 'Design', 'design.wpdesign.json'),
      relativePath: 'Design/design.wpdesign.json',
    });
    seedEntity(db, {
      id: 'primer-1',
      type: 'primer',
      name: 'Primer',
      locator: 'primer:primer-1',
      path: join(root, 'Design', 'primer.primer.json'),
      relativePath: 'Design/primer.primer.json',
    });
    seedEntity(db, {
      id: 'unrelated-1',
      type: 'sequence',
      name: 'Unrelated',
      locator: 'sequence:unrelated-1',
      path: join(root, 'unrelated.gb'),
      relativePath: 'unrelated.gb',
    });
    db.prepare(
      `INSERT INTO catalog_entity_links
       (id, source_entity_id, relation, target_entity_id, confidence, evidence, created_at, updated_at)
       VALUES ('link-1', 'primer-1', 'binds_to_sequence', 'design-1', 'confirmed', NULL, 1, 1)`
    ).run();
    seedConversation(db, root);

    const preflight = await buildDeepSharePreflight(db, {
      workspaceUuid: 'workspace-1',
      rootArtifactId: 'design-1',
      selectedConversationIds: ['conversation-1'],
      getCurrentHeadSha: async () => 'a'.repeat(40),
    });

    expect(preflight.manifest.artifacts.map((artifact) => artifact.id)).toEqual([
      'design-1',
      'primer-1',
    ]);
    expect(JSON.stringify(preflight.manifest)).not.toContain('locator');
    expect(preflight.files.map((file) => file.relativePath)).toEqual([
      'Design/design.wpdesign.json',
      'Design/primer.primer.json',
    ]);
    expect(preflight.manifest.chats).toEqual([
      { conversationId: 'conversation-1', title: 'Design discussion' },
    ]);
    expect(preflight.chats[0].messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Review this design.'],
      ['assistant', 'The design is ready.'],
    ]);
    expect(preflight.chats[0].messages[1].references).toEqual([
      { artifactId: 'design-1', artifactType: 'design', label: 'Design' },
    ]);
    expect(JSON.stringify(preflight)).not.toContain('PRIVATE_FIELD_CANARY_7F3A');
    expect(preflight.digest).toMatch(/^[0-9a-f]{64}$/u);

    await writeFile(join(root, 'Design', 'design.wpdesign.json'), '{"name":"Changed"}\n');
    const changed = await buildDeepSharePreflight(db, {
      workspaceUuid: 'workspace-1',
      rootArtifactId: 'design-1',
      selectedConversationIds: ['conversation-1'],
      getCurrentHeadSha: async () => 'b'.repeat(40),
    });
    expect(changed.digest).not.toBe(preflight.digest);
  });

  it('blocks a root artifact that has no portable file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deep-share-empty-root-'));
    seedWorkspace(db, root);
    db.prepare(
      `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
       VALUES ('design-1', 'design', 'Design', 'design:design-1', 'database', 'active', 1, NULL, 1, 1)`
    ).run();

    await expect(
      buildDeepSharePreflight(db, {
        workspaceUuid: 'workspace-1',
        rootArtifactId: 'design-1',
        selectedConversationIds: [],
        getCurrentHeadSha: async () => 'a'.repeat(40),
      })
    ).rejects.toEqual(
      new DeepSharePreflightError(
        'ROOT_HAS_NO_PORTABLE_FILE',
        'The selected artifact has no portable file to share.'
      )
    );
  });

  it('includes package metadata when the live catalog binds a sequence product file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deep-share-sequence-package-'));
    const packageRoot = join(root, 'pUC19');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await writeFile(join(packageRoot, 'pUC19.gb'), 'LOCUS pUC19\n');
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'sequence',
        id: 'sequence-1',
        name: 'pUC19',
        product: { file: 'pUC19.gb', topology: 'circular' },
      })
    );
    seedWorkspace(db, root);
    seedEntity(db, {
      id: 'sequence-1',
      type: 'sequence',
      name: 'pUC19',
      locator: 'sequence:sequence-1',
      path: join(packageRoot, 'pUC19.gb'),
      relativePath: 'pUC19/pUC19.gb',
      fileKind: 'genbank',
    });

    const preflight = await buildDeepSharePreflight(db, {
      workspaceUuid: 'workspace-1',
      rootArtifactId: 'sequence-1',
      selectedConversationIds: [],
      getCurrentHeadSha: async () => 'a'.repeat(40),
    });

    expect(preflight.files.map((file) => [file.relativePath, file.role])).toEqual([
      ['pUC19/.forge/plasmid.json', 'package-metadata'],
      ['pUC19/pUC19.gb', 'primary'],
    ]);
  });
});

function seedWorkspace(db: Database.Database, path: string): void {
  db.prepare(
    `INSERT INTO workspaces
     (id, name, path, repo_uuid, archived_at, trashed_at, created_at, last_opened_at)
     VALUES (1, 'Project', ?, 'workspace-1', NULL, NULL, 1, 1)`
  ).run(path);
  db.prepare(
    `INSERT INTO workspace_sync_bindings
     (workspace_id, workspace_uuid, owner_account_id, owner_org_id, remote_workspace_id,
      enabled, remote_latest_version_id, remote_latest_version_number,
      remote_latest_content_sha256, last_acked_local_head_sha, created_at, updated_at)
     VALUES (1, 'workspace-1', 'account-1', NULL, 'remote-workspace-1', 1,
             'version-7', 7, ?, ?, 1, 1)`
  ).run('1'.repeat(64), 'a'.repeat(40));
}

function seedEntity(
  db: Database.Database,
  input: {
    id: string;
    type: string;
    name: string;
    locator: string;
    path: string;
    relativePath: string;
    fileKind?: string;
  }
): void {
  db.prepare(
    `INSERT INTO catalog_entities
     (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'file', 'active', 1, NULL, 1, 1)`
  ).run(input.id, input.type, input.name, input.locator);
  db.prepare(
    `INSERT INTO catalog_entity_files
     (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash, size_bytes,
      modified_at, status, last_seen_at, missing_since, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, 1, 'current', 1, NULL, 1, 1)`
  ).run(`file-${input.id}`, input.id, input.path, input.relativePath, input.fileKind ?? 'portable');
}

function seedConversation(db: Database.Database, workspacePath: string): void {
  db.prepare(
    `INSERT INTO conversations
     (id, title, workspace_path, pinned, provider, model, created_at, updated_at)
     VALUES ('conversation-1', 'Design discussion', ?, 0,
             'PRIVATE_FIELD_CANARY_7F3A', 'PRIVATE_FIELD_CANARY_7F3A', 1, 5)`
  ).run(workspacePath);
  const insertMessage = db.prepare(
    `INSERT INTO messages
     (id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at)
     VALUES (?, 'conversation-1', NULL, ?, ?, ?, ?, ?)`
  );
  insertMessage.run('message-user', 'user', 'Review this design.', null, null, 1);
  insertMessage.run(
    'message-tool',
    'tool',
    'PRIVATE_FIELD_CANARY_7F3A',
    'read_workspace',
    'call-1',
    2
  );
  insertMessage.run('message-thinking', 'assistant', 'Intermediate answer.', null, null, 3);
  insertMessage.run('message-final', 'assistant', 'The design is ready.', null, null, 4);
  db.prepare(
    `INSERT INTO entity_references
     (id, entity_type, display_label, locator, deep_link_params, data, source, status,
      workspace_scope, workspace_root_path, created_at, updated_at)
     VALUES ('reference-1', 'design', 'Design', 'design:design-1',
             'PRIVATE_FIELD_CANARY_7F3A', 'PRIVATE_FIELD_CANARY_7F3A', 'test', 'created',
             'workspace-1', ?, 1, 1)`
  ).run(workspacePath);
  db.prepare(
    `INSERT INTO message_references (message_id, reference_id, position)
     VALUES ('message-final', 'reference-1', 0)`
  ).run();
}
