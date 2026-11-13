import { describe, expect, it, vi, beforeEach } from 'vitest';

import { findCurrentFilesByFilename } from './find-current-files-by-filename';

const selectMock = vi.fn();

vi.mock('../platform', () => ({
  platform: () => ({ db: { select: selectMock } }),
}));

const ROOT = '/ws/alpha';

function row(path: string, extra: Record<string, unknown> = {}) {
  return {
    path,
    relative_path: path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : null,
    content_hash: 'git:abc123',
    object_uuid: 'uuid-1',
    entity_id: 'ent-1',
    status: 'current',
    ...extra,
  };
}

beforeEach(() => selectMock.mockReset());

describe('findCurrentFilesByFilename', () => {
  it('returns in-root current matches', async () => {
    selectMock.mockResolvedValue([row(`${ROOT}/sequences/E1010m_CD/E1010m_CD.gb`)]);

    const found = await findCurrentFilesByFilename('E1010m_CD.gb', ROOT);

    expect(found).toEqual([
      {
        path: 'sequences/E1010m_CD/E1010m_CD.gb',
        contentHash: 'git:abc123',
        objectUuid: 'uuid-1',
        entityId: 'ent-1',
      },
    ]);
  });

  it('🟥 ESCAPES the LIKE wildcards in the filename', async () => {
    selectMock.mockResolvedValue([]);

    await findCurrentFilesByFilename('B0034m_BC.gb', ROOT);

    const [sql, params] = selectMock.mock.calls[0];
    expect(String(sql)).toContain("ESCAPE '\\'");
    expect(String(params[0])).toBe('%/B0034m\\_BC.gb');
  });

  it('escapes a percent sign too', async () => {
    selectMock.mockResolvedValue([]);
    await findCurrentFilesByFilename('100%_pure.gb', ROOT);
    expect(String(selectMock.mock.calls[0][1][0])).toBe('%/100\\%\\_pure.gb');
  });

  it('excludes rows outside the owning root', async () => {
    selectMock.mockResolvedValue([
      row(`${ROOT}/a/E1010m_CD.gb`),
      row('/ws/beta/a/E1010m_CD.gb', { relative_path: 'a/E1010m_CD.gb' }),
    ]);

    const found = await findCurrentFilesByFilename('E1010m_CD.gb', ROOT);
    expect(found.map((f) => f.path)).toEqual(['a/E1010m_CD.gb']);
  });

  it('does not treat a shared-prefix sibling root as in-root', async () => {
    selectMock.mockResolvedValue([
      row('/ws/alpha-archive/a/E1010m_CD.gb', { relative_path: 'a/E1010m_CD.gb' }),
    ]);

    expect(await findCurrentFilesByFilename('E1010m_CD.gb', ROOT)).toEqual([]);
  });

  it('asks only for CURRENT bindings', async () => {
    selectMock.mockResolvedValue([]);
    await findCurrentFilesByFilename('x.gb', ROOT);
    expect(String(selectMock.mock.calls[0][0])).toMatch(/status\s*=\s*'current'/);
  });

  it('returns every in-root match so the caller can judge ambiguity', async () => {
    selectMock.mockResolvedValue([row(`${ROOT}/kits/pUC19.gb`), row(`${ROOT}/backup/pUC19.gb`)]);

    const found = await findCurrentFilesByFilename('pUC19.gb', ROOT);
    expect(found).toHaveLength(2);
  });

  it('derives the relative path when the column is null', async () => {
    selectMock.mockResolvedValue([row(`${ROOT}/a/b.gb`, { relative_path: null })]);
    const found = await findCurrentFilesByFilename('b.gb', ROOT);
    expect(found[0].path).toBe('a/b.gb');
  });

  it('returns nothing for an empty filename or missing root', async () => {
    expect(await findCurrentFilesByFilename('', ROOT)).toEqual([]);
    expect(await findCurrentFilesByFilename('x.gb', null)).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('accepts a full path and matches on its basename', async () => {
    selectMock.mockResolvedValue([]);
    await findCurrentFilesByFilename('sequences/kits/moclo-cidar/DVA_AE.gb', ROOT);
    expect(String(selectMock.mock.calls[0][1][0])).toBe('%/DVA\\_AE.gb');
  });
});
