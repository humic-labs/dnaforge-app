import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockSelect, mockExecute } = vi.hoisted(() => ({
  mockSelect: vi.fn().mockResolvedValue([]),
  mockExecute: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    db: { select: mockSelect, execute: mockExecute },
  }),
}));

import {
  getConversationHistory,
  getConversations,
  getRecentMessages,
  updateConversation,
  updateConversationWithResult,
  toggleConversationPinned,
  toggleConversationPinnedWithResult,
} from './index';

describe('getConversations workspace bucket ', () => {
  beforeEach(() => {
    mockSelect.mockClear();
  });

  it('filters by exact workspace path when one is provided', async () => {
    await getConversations('/Users/me/lab');
    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('workspace_path = ?');
    expect(sql).not.toContain('IS NULL');
    expect(params).toEqual(['/Users/me/lab']);
  });

  it('returns ONLY the IS NULL bucket for null — not every conversation', async () => {
    await getConversations(null);
    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[] | undefined];
    expect(sql).toContain('workspace_path IS NULL');
    expect(sql).not.toContain('workspace_path = ?');
    expect(params).toBeUndefined();
  });
});

describe('getConversationHistory app-wide discovery', () => {
  beforeEach(() => {
    mockSelect.mockClear();
  });

  it('lists a native conversation with an unsent draft and hides a completely blank one', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    vi.stubGlobal('window', { electronAPI: {} });
    try {
      db.exec(`
        CREATE TABLE conversations (id TEXT PRIMARY KEY, pinned INTEGER, updated_at INTEGER);
        CREATE TABLE messages (conversation_id TEXT);
        CREATE TABLE chat_composer_drafts (conversation_id TEXT PRIMARY KEY);
        INSERT INTO conversations VALUES ('draft', 0, 2), ('blank', 0, 1);
        INSERT INTO chat_composer_drafts VALUES ('draft');
      `);
      mockSelect.mockImplementationOnce((sql: string) => db.prepare(sql).all());
      expect((await getConversationHistory()).map((row) => row.id)).toEqual(['draft']);
    } finally {
      vi.unstubAllGlobals();
      db.close();
    }
  });

  it('discovers populated conversations across workspaces and excludes empty placeholder rows', async () => {
    await getConversationHistory();
    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[] | undefined];
    expect(sql).not.toContain('workspace_path = ?');
    expect(sql).not.toContain('workspace_path IS NULL');
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('m.conversation_id = c.id');
    expect(sql).toContain('ORDER BY c.pinned DESC, c.updated_at DESC');
    expect(params).toBeUndefined();
  });
});

describe('getRecentMessages  P4 preview source)', () => {
  beforeEach(() => {
    mockSelect.mockClear();
  });

  it('reads newest-first, capped by limit (default 3), scoped to the conversation', async () => {
    await getRecentMessages('conv-1');
    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('conversation_id = ?');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual(['conv-1', 3]);
  });

  it('honors an explicit limit', async () => {
    await getRecentMessages('conv-2', 5);
    const [, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['conv-2', 5]);
  });
});

describe('native conversation write result authority (H1)', () => {
  beforeEach(() => {
    mockSelect.mockReset().mockResolvedValue([{ pinned: 0 }]);
    mockExecute.mockReset();
  });
  it.each([
    [1, 'updated'],
    [0, 'not_applied'],
    [undefined, 'not_attested'],
  ] as const)(
    'uses actual SQLite changes=%s for rename, preserving manual-title lock',
    async (changes, status) => {
      mockExecute.mockResolvedValue(changes === undefined ? undefined : { changes });
      expect(await updateConversationWithResult('row', 'private title')).toEqual({ status });
      expect(mockExecute).toHaveBeenCalledOnce();
      expect(mockExecute.mock.calls[0]![0]).toContain('title_locked = 1');
      expect(mockExecute.mock.calls[0]![1].slice(0, 1)).toEqual(['private title']);
    }
  );
  it('preserves legacy void and Boolean API shapes with one SQL write', async () => {
    mockExecute.mockResolvedValue({ changes: 1 });
    await expect(updateConversation('row', 'title')).resolves.toBeUndefined();
    expect(mockExecute).toHaveBeenCalledOnce();
    mockExecute.mockClear();
    await expect(toggleConversationPinned('row')).resolves.toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();

    mockExecute.mockClear();
    mockExecute.mockResolvedValue({ changes: 0 });
    await expect(updateConversation('row', 'title')).resolves.toBeUndefined();
    await expect(toggleConversationPinned('row')).resolves.toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
  it('does not turn missing pin rows or zero changes into a committed pin', async () => {
    mockSelect.mockResolvedValueOnce([]);
    expect(await toggleConversationPinnedWithResult('gone')).toEqual({
      status: 'missing',
      pinned: false,
    });
    expect(mockExecute).not.toHaveBeenCalled();
    mockExecute.mockResolvedValue({ changes: 0 });
    expect(await toggleConversationPinnedWithResult('row')).toEqual({
      status: 'not_applied',
      pinned: true,
    });
  });
  it('preserves the original native rejection for both write helpers', async () => {
    const failure = new Error('synthetic SQLite refusal');
    mockExecute.mockRejectedValue(failure);
    await expect(updateConversationWithResult('row', 'title')).rejects.toBe(failure);
    await expect(toggleConversationPinnedWithResult('row')).rejects.toBe(failure);
  });
});
