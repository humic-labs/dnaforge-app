import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  projectConversationFromLedger,
  runConversationLedgerProjectionParity,
  runConversationLedgerSQLiteProjectionParity,
} from './parity';
import { ConversationLedgerWriter } from './writer';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'conversation-ledger-parity-'));
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

describe('conversation ledger projection parity', () => {
  it('projects real JSONL readback and matches live provider messages', async () => {
    const ledger = writer();
    await ledger.append({
      conversation_id: 'conv-provider',
      turn_id: 'turn-1',
      source: 'app:chat',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'user-message',
      payload: {
        message: { role: 'user', content: 'List files' },
        route: { routeKind: 'provider' },
      },
    });
    await ledger.append({
      conversation_id: 'conv-provider',
      turn_id: 'turn-1',
      source: 'provider:vercel',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'text-delta',
      payload: { type: 'text-delta', id: 'text-1', text: 'I will check. ' },
    });
    await ledger.append({
      conversation_id: 'conv-provider',
      turn_id: 'turn-1',
      source: 'provider:vercel',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'tool-result',
      payload: {
        type: 'tool-result',
        toolCallId: 'tc-1',
        toolName: 'list_files',
        input: { path: '/workspace' },
        output: { files: ['a.gb'] },
      },
    });
    await ledger.append({
      conversation_id: 'conv-provider',
      turn_id: 'turn-1',
      source: 'provider:vercel',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'text-delta',
      payload: { type: 'text-delta', id: 'text-2', text: 'Done.' },
    });

    const report = await runConversationLedgerProjectionParity({
      reader: ledger,
      conversations: [
        {
          conversation_id: 'conv-provider',
          live_messages: [
            { role: 'user', content: 'List files' },
            { role: 'assistant', content: 'I will check. ' },
            {
              role: 'tool',
              content: JSON.stringify({
                input: { path: '/workspace' },
                output: { files: ['a.gb'] },
                isError: false,
              }),
              tool_name: 'list_files',
              tool_call_id: 'tc-1',
            },
            { role: 'assistant', content: 'Done.' },
          ],
        },
      ],
    });

    expect(report).toMatchObject({
      ok: true,
      checked_conversation_count: 1,
      results: [{ conversation_id: 'conv-provider', projected_count: 4, live_count: 4 }],
    });
  });

  it('reports conversation-scoped semantic mismatches', async () => {
    const ledger = writer();
    await ledger.append({
      conversation_id: 'conv-mismatch',
      turn_id: 'turn-1',
      source: 'app:chat',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'user-message',
      payload: { message: { role: 'user', content: 'Hello' } },
    });
    await ledger.append({
      conversation_id: 'conv-mismatch',
      turn_id: 'turn-1',
      source: 'provider:vercel',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'text-delta',
      payload: { type: 'text-delta', id: 'text-1', text: 'Hi' },
    });

    const report = await runConversationLedgerProjectionParity({
      reader: ledger,
      conversations: [
        {
          conversation_id: 'conv-mismatch',
          live_messages: [{ role: 'user', content: 'Hello' }],
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.results[0].mismatches).toContain('conv-mismatch: message count 2 !== 1');
  });

  it('compares projected JSONL against real SQLite message rows', async () => {
    const db: Database.Database = createTestDb();
    try {
      ensureSchema(db, ':memory:');
      db.prepare(
        `INSERT INTO conversations (
          id, title, workspace_path, pinned, provider, model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('conv-sqlite', 'Parity', null, 0, 'anthropic', 'claude-sonnet', 1, 1);
      db.prepare(
        `INSERT INTO chat_turns (
          id, conversation_id, route_kind, host_id, provider, model, transport,
          authority_profile_id, permission_mode, route_snapshot_json, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'turn-1',
        'conv-sqlite',
        'provider',
        'anthropic',
        'anthropic',
        'claude-sonnet',
        null,
        null,
        null,
        '{"routeKind":"provider"}',
        'completed',
        1
      );
      db.prepare(
        `INSERT INTO messages (
          id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('msg-user', 'conv-sqlite', 'turn-1', 'user', 'List files', null, null, 1);
      db.prepare(
        `INSERT INTO messages (
          id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('msg-assistant', 'conv-sqlite', 'turn-1', 'assistant', 'I will check. ', null, null, 2);
      db.prepare(
        `INSERT INTO messages (
          id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-tool',
        'conv-sqlite',
        'turn-1',
        'tool',
        JSON.stringify({
          input: { path: '/workspace' },
          output: { files: ['a.gb'] },
          isError: false,
        }),
        'list_files',
        'tc-1',
        3
      );

      const ledger = writer();
      await ledger.append({
        conversation_id: 'conv-sqlite',
        turn_id: 'turn-1',
        source: 'app:chat',
        provider: 'anthropic',
        model: 'claude-sonnet',
        stream_event_type: 'user-message',
        payload: { message: { role: 'user', content: 'List files' } },
      });
      await ledger.append({
        conversation_id: 'conv-sqlite',
        turn_id: 'turn-1',
        source: 'provider:vercel',
        provider: 'anthropic',
        model: 'claude-sonnet',
        stream_event_type: 'text-delta',
        payload: { type: 'text-delta', id: 'text-1', text: 'I will check. ' },
      });
      await ledger.append({
        conversation_id: 'conv-sqlite',
        turn_id: 'turn-1',
        source: 'provider:vercel',
        provider: 'anthropic',
        model: 'claude-sonnet',
        stream_event_type: 'tool-result',
        payload: {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'list_files',
          input: { path: '/workspace' },
          output: { files: ['a.gb'] },
        },
      });

      await expect(
        runConversationLedgerSQLiteProjectionParity({
          reader: ledger,
          db,
          conversationIds: ['conv-sqlite'],
        })
      ).resolves.toMatchObject({
        ok: true,
        checked_conversation_count: 1,
        results: [{ conversation_id: 'conv-sqlite', projected_count: 3, live_count: 3 }],
      });
    } finally {
      db.close();
    }
  });

  it('projects through real JSONL readback while ignoring a torn trailing line', async () => {
    const ledger = writer();
    await ledger.append({
      conversation_id: 'conv-torn',
      turn_id: 'turn-1',
      source: 'app:chat',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'user-message',
      payload: { message: { role: 'user', content: 'Hello' } },
    });
    await ledger.append({
      conversation_id: 'conv-torn',
      turn_id: 'turn-1',
      source: 'provider:vercel',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'text-delta',
      payload: { type: 'text-delta', id: 'text-1', text: 'Hi there' },
    });

    appendFileSync(ledger.getConversationPath('conv-torn'), '{"schema_version":1', 'utf8');

    await expect(
      runConversationLedgerProjectionParity({
        reader: ledger,
        conversations: [
          {
            conversation_id: 'conv-torn',
            live_messages: [
              { role: 'user', content: 'Hello' },
              { role: 'assistant', content: 'Hi there' },
            ],
          },
        ],
      })
    ).resolves.toMatchObject({
      ok: true,
      checked_conversation_count: 1,
      results: [{ conversation_id: 'conv-torn', projected_count: 2, live_count: 2 }],
    });
  });

  it('returns an empty projection for a missing ledger conversation', async () => {
    await expect(projectConversationFromLedger(writer(), 'missing-conv')).resolves.toEqual({
      conversation_id: 'missing-conv',
      messages: [],
    });
  });
});
