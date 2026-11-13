import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), exit: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { createTestDb } from '../__tests__/test-db';
import { deleteConversationInDb } from './database';

function setupConversation() {
  const db = createTestDb();
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE entity_references (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      display_label TEXT NOT NULL,
      locator TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE message_references (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      reference_id TEXT NOT NULL REFERENCES entity_references(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (message_id, reference_id)
    );
  `);
  db.prepare('INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)').run(
    'c',
    'audit',
    1,
    1
  );
  db.prepare(
    'INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)'
  ).run('m', 'c', 'user', 'audit message', 1);
  db.prepare(
    'INSERT INTO entity_references (id,entity_type,display_label,locator,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run('r', 'alignment', 'audit', 'entity://alignment/audit', 'audit', 1, 1);
  db.prepare('INSERT INTO message_references VALUES (?,?,?)').run('m', 'r', 0);
  return db;
}

function snapshot(db: ReturnType<typeof createTestDb>) {
  return {
    conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number },
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number },
    message_references: db.prepare('SELECT COUNT(*) AS n FROM message_references').get() as {
      n: number;
    },
  };
}

describe('deleteConversationInDb', () => {
  it('removes the conversation and dependent rows together', () => {
    const db = setupConversation();
    deleteConversationInDb(db, 'c');
    const after = snapshot(db);
    expect(after.conversations.n).toBe(0);
    expect(after.messages.n).toBe(0);
    expect(after.message_references.n).toBe(0);
  });

  it('rolls back an injected failure so attachment links remain', () => {
    const db = setupConversation();
    db.exec(`
      CREATE TRIGGER fixture_fail_delete BEFORE DELETE ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'injected failure');
      END;
    `);
    expect(() => deleteConversationInDb(db, 'c')).toThrow(/injected failure/);
    const after = snapshot(db);
    expect(after.conversations.n).toBe(1);
    expect(after.messages.n).toBe(1);
    expect(after.message_references.n).toBe(1);
  });
});
