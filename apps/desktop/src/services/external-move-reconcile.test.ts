import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBCatalogEntityFile } from '../db/workspace-catalog';

const { relinkSpy, getCatalogFilesUnderPathMock } = vi.hoisted(() => ({
  relinkSpy: vi.fn(),
  getCatalogFilesUnderPathMock: vi.fn(),
}));
vi.mock('../platform', () => ({
  platform: () => ({ workspace: { relinkMovedEntityFile: relinkSpy } }),
}));
vi.mock('../db/workspace-catalog', () => ({
  getCatalogFilesUnderPath: getCatalogFilesUnderPathMock,
  inferCatalogFileKind: (p: string) => (p.endsWith('.gb') ? 'genbank' : 'other'),
}));

import { applyExternalMovesForRoot, type CurrentRegistryFile } from './external-move-reconcile';

const OK_RESULT = {
  newPath: '',
  counts: {
    catalog: { updated: 1 },
    indexed: { indexedFilesMoved: 1, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
    lims: { rebasedEntityIds: ['e'], workspaceIds: [1] },
  },
};

const ROOT = '/w';
const GIT = (c: string) => `git:${c.repeat(40)}`;

function row(
  path: string,
  contentHash: string | null,
  over: Partial<DBCatalogEntityFile> = {}
): DBCatalogEntityFile {
  return {
    id: `cf-${path}`,
    entity_id: `ce-${path}`,
    workspace_id: 1,
    path,
    relative_path: null,
    file_kind: 'genbank',
    content_hash: contentHash,
    object_uuid: null,
    size_bytes: 10,
    modified_at: 0,
    status: 'current',
    last_seen_at: 0,
    missing_since: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}
const cur = (path: string, contentHash: string | null): CurrentRegistryFile => ({
  path,
  contentHash,
});

describe('applyExternalMovesForRoot', () => {
  beforeEach(() => {
    relinkSpy.mockReset();
    relinkSpy.mockResolvedValue(OK_RESULT);
    getCatalogFilesUnderPathMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('rebases the existing entity when a file vanished and reappeared with the SAME byte hash', async () => {
    getCatalogFilesUnderPathMock.mockResolvedValue([row('/w/old.gb', GIT('a'))]);
    const res = await applyExternalMovesForRoot(ROOT, [cur('/w/sub/new.gb', GIT('a'))]);

    expect(relinkSpy).toHaveBeenCalledTimes(1);
    expect(relinkSpy).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      oldPath: '/w/old.gb',
      newPath: '/w/sub/new.gb',
    });
    expect(res).toEqual({ relinked: 1, ambiguous: 0, errors: [] });
  });

  it('does NOTHING in the steady state (every current file already in the catalog)', async () => {
    getCatalogFilesUnderPathMock.mockResolvedValue([row('/w/a.gb', GIT('a'))]);
    const res = await applyExternalMovesForRoot(ROOT, [cur('/w/a.gb', GIT('a'))]);

    expect(relinkSpy).not.toHaveBeenCalled();
    expect(res.relinked).toBe(0);
  });
  it('forwards the owning reconciliation capability to a matched move', async () => {
    getCatalogFilesUnderPathMock.mockResolvedValue([row('/w/old.gb', GIT('a'))]);
    await applyExternalMovesForRoot(ROOT, [cur('/w/new.gb', GIT('a'))], 'outer-reconcile');
    expect(relinkSpy).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      oldPath: '/w/old.gb',
      newPath: '/w/new.gb',
      mutationToken: 'outer-reconcile',
    });
  });

  it('never guesses on an AMBIGUOUS match (two vanished rows share the appeared file’s hash)', async () => {
    getCatalogFilesUnderPathMock.mockResolvedValue([
      row('/w/one.gb', GIT('a')),
      row('/w/two.gb', GIT('a')),
    ]);
    const res = await applyExternalMovesForRoot(ROOT, [cur('/w/new.gb', GIT('a'))]);

    expect(relinkSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ relinked: 0, ambiguous: 1, errors: [] });
  });

  it('refuses a cross-namespace match (git: vs sha256: are never comparable)', async () => {
    getCatalogFilesUnderPathMock.mockResolvedValue([row('/w/old.gb', GIT('a'))]);
    const res = await applyExternalMovesForRoot(ROOT, [
      cur('/w/new.gb', `sha256:${'a'.repeat(64)}`),
    ]);

    expect(relinkSpy).not.toHaveBeenCalled();
    expect(res.relinked).toBe(0);
  });

  it('skips a historical (superseded) catalog row — only live bindings relink', async () => {
    getCatalogFilesUnderPathMock.mockResolvedValue([
      row('/w/old.gb', GIT('a'), { status: 'historical' }),
    ]);
    const res = await applyExternalMovesForRoot(ROOT, [cur('/w/new.gb', GIT('a'))]);

    expect(relinkSpy).not.toHaveBeenCalled();
    expect(res.relinked).toBe(0);
  });

  it('a relink failure is captured and NON-fatal (never throws, never a mis-link)', async () => {
    getCatalogFilesUnderPathMock.mockResolvedValue([row('/w/old.gb', GIT('a'))]);
    relinkSpy.mockRejectedValueOnce(new Error('RELOCATE_CATALOG_CONFLICT: x'));

    const res = await applyExternalMovesForRoot(ROOT, [cur('/w/new.gb', GIT('a'))]);

    expect(res.relinked).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toMatch(/RELOCATE_CATALOG_CONFLICT/);
  });
});
