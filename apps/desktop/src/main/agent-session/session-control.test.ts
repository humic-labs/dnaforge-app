import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { forkConversation } from './session-control';

describe('conversation fork controls', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });

  it('forks the canonical transcript and references without changing its parent', () => {
    db.prepare(
      `INSERT INTO conversations (id, title, workspace_path, provider, model, created_at, updated_at)
       VALUES ('parent', 'Primer work', '/workspace', 'codex-sdk', 'gpt', 1, 2)`
    ).run();
    db.prepare(
      `INSERT INTO chat_turns (
         id, conversation_id, route_kind, host_id, provider, model, transport,
         authority_profile_id, permission_mode, route_snapshot_json, status,
         terminal_reason, error, started_at, completed_at
       ) VALUES (
         'turn-parent', 'parent', 'cli', 'codex-cli', 'codex-sdk', 'gpt', 'codex-sdk',
         'codex-sdk:app-supervised', 'app-supervised', '{}', 'completed',
         'completed', NULL, 1, 2
       )`
    ).run();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, turn_id, created_at)
       VALUES ('message-parent', 'parent', 'assistant', 'Design primers', 'turn-parent', 2)`
    ).run();
    db.prepare(
      `INSERT INTO entity_references (
         id, entity_type, display_label, locator, source, status, created_at, updated_at
       ) VALUES ('reference-1', 'sequence', 'pUC19', '{}', 'user', 'created', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO message_references (message_id, reference_id, position)
       VALUES ('message-parent', 'reference-1', 0)`
    ).run();
    const sha256 = 'd'.repeat(64);
    db.prepare(
      `INSERT INTO message_attachments (
         message_id, attachment_id, position, name, media_type, size, sha256, kind
       ) VALUES (?, ?, 0, 'sequence.fasta', 'text/x-fasta', 12, ?, 'text')`
    ).run('message-parent', `attachment-${sha256}`, sha256);
    db.prepare(
      `INSERT INTO agent_structured_outputs (
         turn_id, schema_json, raw_result, validation_status, parsed_json,
         validation_error, artifact_id, created_at
       ) VALUES (
         'turn-parent', '{"type":"object"}', '{"answer":42}', 'valid',
         '{"answer":42}', NULL, 'structured-sha256-fixture', 2
       )`
    ).run();
    const ids = ['forked', 'turn-forked', 'message-forked'];

    expect(
      forkConversation(db, {
        conversationId: 'parent',
        idGenerator: () => ids.shift() ?? 'unexpected',
        now: () => 10,
      })
    ).toEqual({ conversationId: 'forked', parentConversationId: 'parent' });
    expect(db.prepare(`SELECT title FROM conversations WHERE id = 'parent'`).get()).toEqual({
      title: 'Primer work',
    });
    expect(
      db.prepare(`SELECT content, turn_id FROM messages WHERE conversation_id = 'forked'`).get()
    ).toEqual({ content: 'Design primers', turn_id: 'turn-forked' });
    expect(
      db
        .prepare(`SELECT reference_id FROM message_references WHERE message_id = 'message-forked'`)
        .get()
    ).toEqual({ reference_id: 'reference-1' });
    expect(
      db
        .prepare(
          `SELECT attachment_id, sha256 FROM message_attachments
           WHERE message_id = 'message-forked'`
        )
        .get()
    ).toEqual({ attachment_id: `attachment-${sha256}`, sha256 });
    expect(
      db.prepare(`SELECT parent_conversation_id, relation FROM conversation_lineage`).get()
    ).toEqual({ parent_conversation_id: 'parent', relation: 'fork' });
    expect(
      db
        .prepare(
          `SELECT turn.conversation_id, output.raw_result, output.validation_status,
                  output.artifact_id
             FROM agent_structured_outputs output
             JOIN chat_turns turn ON turn.id = output.turn_id
            WHERE output.turn_id = 'turn-forked'`
        )
        .get()
    ).toEqual({
      conversation_id: 'forked',
      raw_result: '{"answer":42}',
      validation_status: 'valid',
      artifact_id: 'structured-sha256-fixture',
    });
  });

  it('refuses to fork a transcript while its turn is still changing', () => {
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES ('parent-running', 'Still running', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO chat_turns (
         id, conversation_id, route_kind, host_id, permission_mode,
         route_snapshot_json, status, started_at
       ) VALUES ('turn-running', 'parent-running', 'provider', 'direct-api',
         'provider-key', '{}', 'running', 1)`
    ).run();

    expect(() =>
      forkConversation(db, {
        conversationId: 'parent-running',
        idGenerator: () => 'must-not-be-used',
      })
    ).toThrow('Pause the active turn');
  });
});
