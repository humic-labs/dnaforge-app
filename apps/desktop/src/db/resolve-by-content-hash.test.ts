import { describe, expect, it, vi, beforeEach } from 'vitest';

import { resolveFileByContentHash } from './resolve-by-content-hash';

const selectMock = vi.fn();

vi.mock('../platform', () => ({
  platform: () => ({ db: { select: selectMock } }),
}));

const ROOT = '/workspaces/alpha';
const HASH = 'sha256:aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999';

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    path: `${ROOT}/sequences/pUC19.gb`,
    relative_path: 'sequences/pUC19.gb',
    content_hash: HASH,
    status: 'current',
    entity_id: 'ent-1',
    object_uuid: 'uuid-1',
    ...overrides,
  };
}

beforeEach(() => {
  selectMock.mockReset();
});

describe('resolveFileByContentHash', () => {
  it('resolves a unique in-workspace match', async () => {
    selectMock.mockResolvedValue([row()]);

    const found = await resolveFileByContentHash(HASH, ROOT);

    expect(found).toEqual({
      absolutePath: `${ROOT}/sequences/pUC19.gb`,
      workspaceRelativePath: 'sequences/pUC19.gb',
      entityId: 'ent-1',
      objectUuid: 'uuid-1',
    });
  });

  it('🟥 refuses an AMBIGUOUS match rather than guessing', async () => {
    selectMock.mockResolvedValue([
      row({ path: `${ROOT}/sequences/pUC19.gb`, relative_path: 'sequences/pUC19.gb' }),
      row({ path: `${ROOT}/backup/pUC19-copy.gb`, relative_path: 'backup/pUC19-copy.gb' }),
    ]);

    expect(await resolveFileByContentHash(HASH, ROOT)).toBeNull();
  });

  it('🟥 refuses a git: oid — the namespaces must never cross', async () => {
    selectMock.mockResolvedValue([row({ content_hash: 'git:deadbeef' })]);

    expect(await resolveFileByContentHash('git:deadbeef', ROOT)).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('refuses an unprefixed bare hex hash', async () => {
    expect(await resolveFileByContentHash('a'.repeat(64), ROOT)).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('excludes out-of-root rows BEFORE judging ambiguity', async () => {
    selectMock.mockResolvedValue([
      row({ path: `${ROOT}/sequences/pUC19.gb`, relative_path: 'sequences/pUC19.gb' }),
      row({ path: '/workspaces/beta/sequences/pUC19.gb', relative_path: 'sequences/pUC19.gb' }),
    ]);

    const found = await resolveFileByContentHash(HASH, ROOT);
    expect(found?.absolutePath).toBe(`${ROOT}/sequences/pUC19.gb`);
  });

  it('does not treat a sibling with a shared prefix as in-root', async () => {
    selectMock.mockResolvedValue([
      row({ path: '/workspaces/alpha-archive/sequences/pUC19.gb', relative_path: null }),
    ]);

    expect(await resolveFileByContentHash(HASH, ROOT)).toBeNull();
  });

  it('only considers CURRENT bindings', async () => {
    selectMock.mockResolvedValue([]);

    await resolveFileByContentHash(HASH, ROOT);

    const sql = String(selectMock.mock.calls[0][0]);
    expect(sql).toMatch(/status\s*=\s*'current'/);
  });

  it('binds the hash as a parameter, never interpolated', async () => {
    selectMock.mockResolvedValue([]);

    await resolveFileByContentHash(HASH, ROOT);

    expect(selectMock.mock.calls[0][1]).toEqual([HASH]);
    expect(String(selectMock.mock.calls[0][0])).not.toContain(HASH);
  });

  it('returns null for a missing hash or missing root', async () => {
    expect(await resolveFileByContentHash('', ROOT)).toBeNull();
    expect(await resolveFileByContentHash(HASH, null)).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('derives the relative path when the column is null', async () => {
    selectMock.mockResolvedValue([
      row({ path: `${ROOT}/sequences/pUC19.gb`, relative_path: null }),
    ]);

    const found = await resolveFileByContentHash(HASH, ROOT);
    expect(found?.workspaceRelativePath).toBe('sequences/pUC19.gb');
  });

  it('tolerates a trailing separator on the root', async () => {
    selectMock.mockResolvedValue([row()]);

    const found = await resolveFileByContentHash(HASH, `${ROOT}/`);
    expect(found?.absolutePath).toBe(`${ROOT}/sequences/pUC19.gb`);
  });
});
