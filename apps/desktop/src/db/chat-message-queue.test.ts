import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openFileTestDb } from '../main/__tests__/test-db';
import { ensureSchema } from '../main/schema';
import { persistQueuedMessage, loadQueuedMessages } from './chat-message-queue';
import type { QueuedChatMessage } from '../features/ai/orchestration/chat-store-types';

const bridge = vi.hoisted(() => ({ db: { execute: vi.fn(), select: vi.fn() } }));
vi.mock('../platform', () => ({ platform: () => bridge }));
vi.mock('../utils/environment', () => ({ isDesktopRuntime: () => true }));

it('reopens pending follow-ups in order and consumes each only in the accepted message transaction', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'queued-chat-'));
  const file = join(folder, 'chat.sqlite');
  let db = openFileTestDb(file);
  try {
    ensureSchema(db, ':memory:');
    db.pragma('foreign_keys = ON');
    bridge.db.execute.mockImplementation((sql, params) => db.prepare(sql).run(...params));
    bridge.db.select.mockImplementation((sql, params) => db.prepare(sql).all(...params));
    db.exec(
      "INSERT INTO conversations (id,title,created_at,updated_at) VALUES ('chat','Color',0,0)"
    );
    const route = {
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    } as const;
    const first: QueuedChatMessage = {
      id: 'first',
      content: '雪',
      workspacePath: null,
      referenceIds: ['note'],
      routeSelection: route,
      routeSnapshot: {
        routeKind: 'cli',
        hostId: 'claude-code',
        provider: null,
        model: null,
        transport: 'claude-agent-sdk',
        authorityProfileId: null,
        permissionMode: 'native-cli',
        routeSnapshotJson: JSON.stringify(route),
      },
      createdAt: 1,
      attachments: [
        {
          kind: 'text',
          name: 'color.txt',
          size: 2,
          mediaType: 'text/plain',
          sha256: 'a'.repeat(64),
          id: 'attachment-' + 'a'.repeat(64),
        },
      ],
    };
    const second = { ...first, id: 'second', content: 'another color' };
    await persistQueuedMessage('chat', first);
    await persistQueuedMessage('chat', second);
    db.close();
    db = openFileTestDb(file);
    db.pragma('foreign_keys = ON');
    expect(await loadQueuedMessages('chat')).toEqual([first, second]);
    const accept = db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content,created_at) VALUES ('first','chat','user','雪',2)"
    );
    db.exec('BEGIN');
    accept.run();
    db.exec('ROLLBACK');
    expect(await loadQueuedMessages('chat')).toEqual([first, second]);
    accept.run();
    expect(await loadQueuedMessages('chat')).toEqual([second]);
    expect(db.prepare('SELECT count(*) AS n FROM chat_message_queue').get()).toEqual({ n: 1 });
    db.exec("DELETE FROM conversations WHERE id='chat'");
    expect(await loadQueuedMessages('chat')).toEqual([]);
    await expect(persistQueuedMessage('chat', second)).rejects.toThrow();
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
