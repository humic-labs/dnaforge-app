import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../main/__tests__/test-db';

const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));

vi.mock('../platform', () => ({
  platform: () => ({
    db: {
      execute: async (sql: string, params: unknown[] = []) => {
        if (!state.sqlite) throw new Error('Test database is closed.');
        const result = state.sqlite.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      },
    },
  }),
}));

import { updateConversation, updateConversationTitleIfUnchanged } from './index';

describe('automatic conversation title persistence', () => {
  beforeEach(() => {
    const sqlite = createTestDb();
    sqlite.exec(
      'CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, title_locked INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)'
    );
    sqlite
      .prepare('INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)')
      .run('chat-1', 'Opening prompt', 1);
    state.sqlite = sqlite;
  });

  afterEach(() => {
    state.sqlite?.close();
    state.sqlite = null;
  });

  it('keeps a manual rename when an earlier title request finishes late', async () => {
    await updateConversation('chat-1', 'My own name');

    expect(
      await updateConversationTitleIfUnchanged('chat-1', 'Opening prompt', 'Generated title')
    ).toBe(false);
    expect(
      state.sqlite?.prepare('SELECT title FROM conversations WHERE id = ?').get('chat-1')
    ).toEqual({ title: 'My own name' });
  });

  it('keeps a manual rename even when the user chooses the temporary title', async () => {
    await updateConversation('chat-1', 'Opening prompt');

    expect(
      await updateConversationTitleIfUnchanged('chat-1', 'Opening prompt', 'Generated title')
    ).toBe(false);
    expect(
      state.sqlite
        ?.prepare('SELECT title, title_locked FROM conversations WHERE id = ?')
        .get('chat-1')
    ).toEqual({ title: 'Opening prompt', title_locked: 1 });
  });

  it('persists a generated title without changing conversation recency', async () => {
    expect(
      await updateConversationTitleIfUnchanged('chat-1', 'Opening prompt', 'Generated title')
    ).toBe(true);
    expect(
      state.sqlite
        ?.prepare('SELECT title, updated_at FROM conversations WHERE id = ?')
        .get('chat-1')
    ).toEqual({ title: 'Generated title', updated_at: 1 });
  });
});
