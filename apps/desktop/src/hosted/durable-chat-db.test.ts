import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createHostedDurableChatDb } from './durable-chat-db';
import { createHostedMemoryDb } from './memory-db';
import type { CreateChatTurnWithUserMessageRequest } from '../shared/chat-turn-ipc';

const ALICE = 'cb7eba39-461c-4b58-a390-2bd30e0ca812';
const BOB = '86b1eea6-7f87-4bd1-a25b-51c6df7915af';
const HISTORY = `SELECT c.* FROM conversations c WHERE EXISTS (
  SELECT 1 FROM messages m WHERE m.conversation_id = c.id
) ORDER BY c.pinned DESC, c.updated_at DESC`;

function fixture() {
  const factory = new IDBFactory();
  let account: string | null = ALICE;
  const fresh = () => createHostedDurableChatDb({ factory, getAccountId: () => account });
  return {
    factory,
    fresh,
    account: (id: string | null) => {
      account = id;
    },
  };
}

async function conversation(
  db: Pick<ReturnType<typeof createHostedMemoryDb>, 'execute'>,
  id: string,
  pinned = 0
) {
  await db.execute(
    'INSERT INTO conversations (id, title, workspace_path, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'Temporary title', null, pinned, 10, 10]
  );
}

function turn(conversationId: string, suffix = ''): CreateChatTurnWithUserMessageRequest {
  return {
    turn: {
      id: `turn${suffix}`,
      conversation_id: conversationId,
      route_kind: 'hosted',
      host_id: 'browser',
      provider: null,
      model: null,
      transport: null,
      authority_profile_id: null,
      permission_mode: null,
      route_snapshot_json: '{}',
      status: 'running',
      terminal_reason: null,
      error: null,
      started_at: 11,
      completed_at: null,
    },
    message: {
      id: `user${suffix}`,
      conversation_id: conversationId,
      role: 'user',
      content: 'Synthetic persistence question',
      tool_name: null,
      tool_call_id: null,
      created_at: 11,
    },
  };
}

describe('hosted browser conversation durability', () => {
  it('restores exact terminal turns, messages and manual title lock in a fresh database', async () => {
    const f = fixture();
    const before = f.fresh();
    await conversation(before, 'conversation');
    await before.createChatTurnWithUserMessage(turn('conversation'));
    await before.commitChatTurnTerminalState({
      turn_id: 'turn',
      conversation_id: 'conversation',
      status: 'completed',
      terminal_reason: 'completed',
      error: null,
      completed_at: 12,
      messages: [
        {
          message: {
            id: 'answer',
            conversation_id: 'conversation',
            turn_id: 'turn',
            role: 'assistant',
            content: 'Synthetic retained answer.',
            tool_name: null,
            tool_call_id: null,
            created_at: 12,
          },
          reference_ids: [],
        },
      ],
    });
    await before.execute(
      'UPDATE conversations SET title = ?, title_locked = 1, updated_at = ? WHERE id = ?',
      ['My conversation', 13, 'conversation']
    );
    const after = f.fresh();
    expect(
      await after.select('SELECT * FROM conversations WHERE id = ?', ['conversation'])
    ).toEqual(await before.select('SELECT * FROM conversations WHERE id = ?', ['conversation']));
    expect(await after.select('SELECT * FROM messages ORDER BY created_at ASC')).toEqual(
      await before.select('SELECT * FROM messages ORDER BY created_at ASC')
    );
    expect(await after.select('SELECT * FROM chat_turns WHERE id = ?', ['turn'])).toEqual([
      expect.objectContaining({ status: 'completed', completed_at: 12 }),
    ]);
    expect(
      await after.execute(
        'UPDATE conversations SET title = ? WHERE id = ? AND title = ? AND title_locked = 0',
        ['Late auto title', 'conversation', 'My conversation']
      )
    ).toMatchObject({ changes: 0 });
  });

  it('uses the real app-wide history query, excludes empty drafts and orders pins before activity', async () => {
    const db = fixture().fresh();
    for (const [id, pinned, at] of [
      ['old-pin', 1, 10],
      ['new', 0, 30],
      ['old', 0, 20],
      ['empty', 1, 40],
    ] as const) {
      await conversation(db, id, pinned);
      await db.execute('UPDATE conversations SET updated_at = ? WHERE id = ?', [at, id]);
      if (id !== 'empty')
        await db.execute(
          'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
          [`m-${id}`, id, 'user', id, at]
        );
    }
    expect((await db.select<Array<{ id: string }>>(HISTORY)).map((row) => row.id)).toEqual([
      'old-pin',
      'new',
      'old',
    ]);
  });

  it('keeps accounts separate, refuses a changed-account mutation and retains deletion', async () => {
    const f = fixture();
    const db = f.fresh();
    await conversation(db, 'alice');
    const pending = conversation(f.fresh(), 'must-not-save');
    f.account(BOB);
    await expect(pending).rejects.toThrow(/account changed/i);
    expect(await f.fresh().select('SELECT * FROM conversations')).toEqual([]);
    await conversation(f.fresh(), 'bob');
    f.account(ALICE);
    expect(await f.fresh().select('SELECT id FROM conversations')).toEqual([{ id: 'alice' }]);
    await f.fresh().execute('DELETE FROM conversations WHERE id = ?', ['alice']);
    expect(await f.fresh().select('SELECT * FROM conversations')).toEqual([]);
    f.account(null);
    expect(await f.fresh().select('SELECT * FROM conversations')).toEqual([]);
    await expect(conversation(f.fresh(), 'signed-out')).rejects.toThrow(/sign in/i);
  });

  it('serializes concurrent independent tabs without losing either conversation', async () => {
    const f = fixture();
    await Promise.all([conversation(f.fresh(), 'tab-one'), conversation(f.fresh(), 'tab-two')]);
    expect(await f.fresh().select('SELECT id FROM conversations ORDER BY id ASC')).toEqual([
      { id: 'tab-one' },
      { id: 'tab-two' },
    ]);
  });

  it.each(['initial-turn', 'message'] as const)(
    'refuses a delayed %s for a conversation belonging to the account selected before a switch',
    async (kind) => {
      const f = fixture();
      const db = f.fresh();
      await conversation(db, 'alice-private-conversation');
      f.account(BOB);
      const delayedWrite =
        kind === 'initial-turn'
          ? db.createChatTurnWithUserMessage(turn('alice-private-conversation'))
          : db.execute(
              'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
              [
                'delayed-message',
                'alice-private-conversation',
                'user',
                'Prior account private draft.',
                20,
              ]
            );
      await expect(delayedWrite).rejects.toThrow(/conversation.*current account/i);
      expect(await f.fresh().select('SELECT * FROM messages')).toEqual([]);
      expect(await f.fresh().select('SELECT * FROM chat_turns')).toEqual([]);
      f.account(ALICE);
      expect(await f.fresh().select('SELECT id FROM conversations')).toEqual([
        { id: 'alice-private-conversation' },
      ]);
      expect(await f.fresh().select('SELECT * FROM messages')).toEqual([]);
    }
  );

  it('atomically removes a conversation transcript and its links while retaining another conversation', async () => {
    const f = fixture();
    const db = f.fresh();
    for (const id of ['remove', 'retain']) {
      await conversation(db, id);
      await db.createChatTurnWithUserMessage(turn(id, id));
      await db.execute(
        'INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)',
        [`user${id}`, `ref-${id}`, 0]
      );
      await db.execute(
        'INSERT INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, ?)',
        [`user${id}`, `attachment-${id}`, 0]
      );
    }
    await db.deleteConversation('remove');
    const after = f.fresh();
    expect(await after.select('SELECT id FROM conversations')).toEqual([{ id: 'retain' }]);
    expect(await after.select('SELECT id FROM messages')).toEqual([{ id: 'userretain' }]);
    expect(await after.select('SELECT id FROM chat_turns')).toEqual([{ id: 'turnretain' }]);
    expect(await after.select('SELECT reference_id FROM message_references')).toEqual([
      { reference_id: 'ref-retain' },
    ]);
    expect(await after.select('SELECT attachment_id FROM message_attachments')).toEqual([
      { attachment_id: 'attachment-retain' },
    ]);
  });

  it('does not save any part of an invalid atomic turn and refuses unavailable storage', async () => {
    const f = fixture();
    const db = f.fresh();
    await conversation(db, 'conversation');
    const invalid = turn('conversation');
    invalid.message.conversation_id = 'different';
    await expect(db.createChatTurnWithUserMessage(invalid)).rejects.toThrow(/same conversation/);
    expect(await f.fresh().select('SELECT * FROM chat_turns')).toEqual([]);
    expect(await f.fresh().select('SELECT * FROM messages')).toEqual([]);
    const unavailable = createHostedDurableChatDb({ factory: null, getAccountId: () => ALICE });
    await expect(conversation(unavailable, 'not-durable')).rejects.toThrow(/storage.*unavailable/i);
  });
});
