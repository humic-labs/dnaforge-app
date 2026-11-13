import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn().mockResolvedValue([]) }));

vi.mock('../platform', () => ({
  platform: () => ({ db: { select: mockSelect, execute: vi.fn() } }),
}));

import { resolveCurrentFileByObjectUuid, resolveFileByObjectUuid } from './resolve-by-object-uuid';

describe('resolveFileByObjectUuid', () => {
  beforeEach(() => {
    mockSelect.mockReset().mockResolvedValue([]);
  });

  it('resolves an id to the file CURRENT path', async () => {
    mockSelect.mockResolvedValue([
      {
        path: '/ws/beta/sequences/pUC19/pUC19.gb',
        relative_path: 'sequences/pUC19/pUC19.gb',
        content_hash: 'sha256:abc',
        status: 'current',
        entity_id: 'ent-1',
      },
    ]);

    const found = await resolveFileByObjectUuid('uuid-1', '/ws/beta');

    expect(found).toEqual({
      absolutePath: '/ws/beta/sequences/pUC19/pUC19.gb',
      workspaceRelativePath: 'sequences/pUC19/pUC19.gb',
      contentHash: 'sha256:abc',
      entityId: 'ent-1',
    });
  });

  it('queries by object_uuid, which is the indexed unique column', async () => {
    await resolveFileByObjectUuid('uuid-1', '/ws/beta');

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('object_uuid = ?');
    expect(params[0]).toBe('uuid-1');
  });

  it('accepts only a CURRENT binding — a historical row names a stale path', async () => {
    await resolveFileByObjectUuid('uuid-1', '/ws/beta');
    const [sql] = mockSelect.mock.calls[0] as [string];
    expect(sql).toContain("status = 'current'");
  });

  it('returns null when the id is unknown', async () => {
    expect(await resolveFileByObjectUuid('nope', '/ws/beta')).toBeNull();
  });

  it('refuses a row whose path escapes the owning root', async () => {
    mockSelect.mockResolvedValue([
      {
        path: '/ws/alpha/x.gb',
        relative_path: 'x.gb',
        content_hash: null,
        status: 'current',
        entity_id: 'e',
      },
    ]);

    expect(await resolveFileByObjectUuid('uuid-1', '/ws/beta')).toBeNull();
  });

  it('does not let a sibling root with a shared prefix pass', async () => {
    mockSelect.mockResolvedValue([
      {
        path: '/ws/beta-archive/x.gb',
        relative_path: 'x.gb',
        content_hash: null,
        status: 'current',
        entity_id: 'e',
      },
    ]);

    expect(await resolveFileByObjectUuid('uuid-1', '/ws/beta')).toBeNull();
  });

  it('derives the relative path when the row has none', async () => {
    mockSelect.mockResolvedValue([
      {
        path: '/ws/beta/a/b.gb',
        relative_path: null,
        content_hash: null,
        status: 'current',
        entity_id: 'e',
      },
    ]);

    const found = await resolveFileByObjectUuid('uuid-1', '/ws/beta');
    expect(found?.workspaceRelativePath).toBe('a/b.gb');
  });

  it('returns null without an owning root rather than guessing one', async () => {
    expect(await resolveFileByObjectUuid('uuid-1', null)).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns null for an empty id instead of matching a null column', async () => {
    expect(await resolveFileByObjectUuid('', '/ws/beta')).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('resolves one global current path without guessing a mounted project', async () => {
    mockSelect.mockResolvedValue([
      {
        path: '/ws/beta/sequences/pUC19/pUC19.gb',
        relative_path: 'sequences/pUC19/pUC19.gb',
        content_hash: 'sha256:abc',
        status: 'current',
        entity_id: 'ent-1',
      },
    ]);

    await expect(resolveCurrentFileByObjectUuid('uuid-1')).resolves.toEqual({
      absolutePath: '/ws/beta/sequences/pUC19/pUC19.gb',
    });
  });
});
