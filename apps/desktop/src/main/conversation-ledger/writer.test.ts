import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONVERSATION_LEDGER_SHADOW } from './constants';
import { serializeLedgerPayload } from './serialize';
import { ConversationLedgerWriter } from './writer';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'conversation-ledger-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('conversation ledger shadow contract', () => {
  it('keeps the temporary shadow banner and read-cutover exit criterion visible', () => {
    expect(CONVERSATION_LEDGER_SHADOW).toContain('TEMPORARY SHADOW PHASE');
    expect(CONVERSATION_LEDGER_SHADOW).toContain('FUTURE source of truth');
    expect(CONVERSATION_LEDGER_SHADOW).toContain('LEGACY');
    expect(CONVERSATION_LEDGER_SHADOW).toContain('Read-cutover requires offline projection parity.');
  });
});

describe('serializeLedgerPayload', () => {
  it('turns non-JSON SDK payload shapes into JSON-safe values', () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    const payload = serializeLedgerPayload({
      raw: circular,
      fn: function providerChunk() {},
      amount: 12n,
      bytes: new Uint8Array([1, 2, 3]),
      nan: Number.NaN,
    });

    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload).toMatchObject({
      fn: { __conversation_ledger_type: 'function', name: 'providerChunk' },
      amount: { __conversation_ledger_type: 'bigint', value: '12' },
      bytes: { __conversation_ledger_type: 'typed_array', name: 'Uint8Array' },
      nan: { __conversation_ledger_type: 'non_finite_number', value: 'NaN' },
    });
  });
});

describe('ConversationLedgerWriter', () => {
  it('bounds the derived next-sequence cache with LRU reuse', () => {
    const writer = new ConversationLedgerWriter({ rootDir: tempRoot() });
    const rememberNextSeq = Reflect.get(writer, 'rememberNextSeq');
    expect(rememberNextSeq).toBeTypeOf('function');
    if (typeof rememberNextSeq !== 'function') throw new Error('rememberNextSeq is unavailable');

    for (let index = 0; index < 128; index++) {
      Reflect.apply(rememberNextSeq, writer, [`conversation-${index}`, index + 1]);
    }
    Reflect.apply(rememberNextSeq, writer, ['conversation-0', 2]);
    Reflect.apply(rememberNextSeq, writer, ['overflow', 129]);

    const cache = Reflect.get(writer, 'nextSeq');
    expect(cache).toBeInstanceOf(Map);
    if (!(cache instanceof Map)) throw new Error('nextSeq cache is unavailable');
    expect(cache.size).toBe(128);
    expect(cache.has('conversation-1')).toBe(false);
    expect(cache.get('conversation-0')).toBe(2);
  });

  it('serializes appends per conversation and assigns monotonic event_seq', async () => {
    let now = 1_000;
    const writer = new ConversationLedgerWriter({
      rootDir: tempRoot(),
      now: () => now++,
      eventIdGenerator: (ms) => `event-${ms}`,
    });

    const events = await Promise.all([
      writer.append({
        conversation_id: 'conv-a',
        source: 'cli:codex',
        provider: 'codex-sdk',
        model: 'gpt-5-codex',
        stream_event_type: 'item.completed',
        payload: { sequence: 0, providerItemId: 'item-1' },
      }),
      writer.append({
        conversation_id: 'conv-a',
        source: 'cli:codex',
        provider: 'codex-sdk',
        model: 'gpt-5-codex',
        stream_event_type: 'item.completed',
        payload: { sequence: 0, providerItemId: 'item-2' },
      }),
    ]);

    expect(events.map((event) => event.event_seq)).toEqual([1, 2]);
    expect(events.map((event) => event.item_id)).toEqual(['item-1', 'item-2']);
    await expect(writer.readEvents('conv-a')).resolves.toHaveLength(2);
    await expect(writer.readManifest()).resolves.toMatchObject({
      conversations: [
        expect.objectContaining({
          conversation_id: 'conv-a',
          event_count: 2,
          last_event_seq: 2,
        }),
      ],
    });
  });

  it('serializes manifest updates across concurrent conversations', async () => {
    let now = 2_000;
    const writer = new ConversationLedgerWriter({
      rootDir: tempRoot(),
      now: () => now++,
      eventIdGenerator: (ms) => `event-${ms}`,
    });
    const conversationIds = Array.from({ length: 24 }, (_, index) => `conv-${index}`);

    await Promise.all(
      conversationIds.map((conversationId) =>
        writer.append({
          conversation_id: conversationId,
          source: 'provider:vercel',
          provider: 'anthropic',
          model: 'claude-sonnet',
          stream_event_type: 'text-delta',
          payload: { text: conversationId },
        })
      )
    );

    const manifest = await writer.readManifest();
    expect(manifest.conversations.map((entry) => entry.conversation_id)).toEqual(
      [...conversationIds].sort((a, b) => a.localeCompare(b))
    );
    expect(manifest.conversations.every((entry) => entry.event_count === 1)).toBe(true);
    await Promise.all(
      conversationIds.map((conversationId) =>
        expect(writer.readEvents(conversationId)).resolves.toHaveLength(1)
      )
    );
  });

  it('discards a torn trailing line on read and rebuilds the manifest by scanning files', async () => {
    const writer = new ConversationLedgerWriter({
      rootDir: tempRoot(),
      now: () => 10_000,
      eventIdGenerator: () => 'event-complete',
    });
    const complete = await writer.append({
      conversation_id: 'conv-torn',
      source: 'provider:vercel',
      provider: 'anthropic',
      model: 'claude-sonnet',
      stream_event_type: 'text-delta',
      payload: { text: 'hello' },
    });
    writeFileSync(writer.getConversationPath('conv-torn'), '{"partial":', { flag: 'a' });

    const events = await writer.readEvents('conv-torn');
    expect(events).toEqual([complete]);

    const manifest = await writer.rebuildManifest();
    expect(manifest.conversations).toEqual([
      expect.objectContaining({
        conversation_id: 'conv-torn',
        event_count: 1,
        last_event_seq: 1,
      }),
    ]);
  });

  it('unlinks a conversation ledger file and removes it from the manifest', async () => {
    const root = tempRoot();
    const writer = new ConversationLedgerWriter({
      rootDir: root,
      eventIdGenerator: () => 'event-delete',
    });
    await writer.append({
      conversation_id: 'conv-delete',
      source: 'system',
      provider: null,
      model: null,
      stream_event_type: 'test',
      payload: {},
    });

    await writer.unlinkConversation('conv-delete');

    await expect(writer.readEvents('conv-delete')).resolves.toEqual([]);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      conversations: unknown[];
    };
    expect(manifest.conversations).toEqual([]);
  });
});
