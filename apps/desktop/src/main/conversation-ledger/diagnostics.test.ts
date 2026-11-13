import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  listConversationIdsForLedgerParity,
  runConversationLedgerParityDiagnostics,
} from './diagnostics';
import type { ConversationLedgerEventReader } from './parity';
import { ConversationLedgerWriter } from './writer';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'conversation-ledger-diagnostics-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writer(): ConversationLedgerWriter {
  let now = Date.parse('2026-06-11T00:00:00.000Z');
  return new ConversationLedgerWriter({
    rootDir: tempRoot(),
    now: () => now++,
    eventIdGenerator: (ms) => `event-${ms}`,
  });
}

function insertConversation(db: Database.Database, id: string, updatedAt: number): void {
  db.prepare(
    `INSERT INTO conversations (
      id, title, workspace_path, pinned, provider, model, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, id, null, 0, 'anthropic', 'claude-sonnet', updatedAt, updatedAt);
}

function insertMessage(
  db: Database.Database,
  id: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: number
): void {
  db.prepare(
    `INSERT INTO messages (
      id, conversation_id, role, content, tool_name, tool_call_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, conversationId, role, content, null, null, createdAt);
}

describe('conversation ledger parity diagnostics', () => {
  it('lists recent SQLite conversations that have visible messages', () => {
    const db = createTestDb();
    try {
      ensureSchema(db, ':memory:');
      insertConversation(db, 'conv-old', 1);
      insertConversation(db, 'conv-new', 3);
      insertConversation(db, 'conv-empty', 5);
      insertMessage(db, 'msg-old', 'conv-old', 'user', 'Old', 1);
      insertMessage(db, 'msg-new', 'conv-new', 'user', 'New', 2);

      expect(listConversationIdsForLedgerParity(db, { limit: 1 })).toEqual(['conv-new']);
      expect(listConversationIdsForLedgerParity(db)).toEqual(['conv-new', 'conv-old']);
      expect(listConversationIdsForLedgerParity(db, { limit: 0 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('returns per-conversation failures when ledger readback fails', async () => {
    const db = createTestDb();
    try {
      ensureSchema(db, ':memory:');
      insertConversation(db, 'conv-good', 2);
      insertConversation(db, 'conv-bad', 1);
      insertMessage(db, 'msg-good-user', 'conv-good', 'user', 'Hello', 1);
      insertMessage(db, 'msg-good-assistant', 'conv-good', 'assistant', 'Hi', 2);
      insertMessage(db, 'msg-bad-user', 'conv-bad', 'user', 'Broken?', 3);

      const ledger = writer();
      await ledger.append({
        conversation_id: 'conv-good',
        turn_id: 'turn-1',
        source: 'app:chat',
        provider: 'anthropic',
        model: 'claude-sonnet',
        stream_event_type: 'user-message',
        payload: { message: { role: 'user', content: 'Hello' } },
      });
      await ledger.append({
        conversation_id: 'conv-good',
        turn_id: 'turn-1',
        source: 'provider:vercel',
        provider: 'anthropic',
        model: 'claude-sonnet',
        stream_event_type: 'text-delta',
        payload: { type: 'text-delta', id: 'text-1', text: 'Hi' },
      });

      const reader: ConversationLedgerEventReader = {
        async readEvents(conversationId) {
          if (conversationId === 'conv-bad') {
            throw new Error('invalid JSONL line');
          }
          return ledger.readEvents(conversationId);
        },
      };

      const report = await runConversationLedgerParityDiagnostics({
        reader,
        db,
        conversationIds: ['conv-good', 'conv-bad'],
        now: () => '2026-06-11T00:00:00.000Z',
      });

      expect(report).toMatchObject({
        ok: false,
        checked_conversation_count: 2,
        requested_conversation_count: 2,
        generated_at: '2026-06-11T00:00:00.000Z',
        results: [
          {
            conversation_id: 'conv-good',
            ok: true,
            projected_count: 2,
            live_count: 2,
          },
          {
            conversation_id: 'conv-bad',
            ok: false,
            projected_count: 0,
            live_count: 1,
          },
        ],
      });
      expect(report.results[1].mismatches).toEqual([
        'conv-bad: ledger parity diagnostic failed: invalid JSONL line',
      ]);
    } finally {
      db.close();
    }
  });
});
