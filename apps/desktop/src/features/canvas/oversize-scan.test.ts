// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';
import {
  fileBackedTabPath,
  revalidateFileTab,
  scanTabForOversize,
  scanTabsForOversize,
  sameFileTabReadAuthority,
} from './oversize-scan';
import { SOFT_WARN_BYTES, HARD_CAP_BYTES } from '../../shared/oversized-guard';
import type { Tab } from './types';

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    type: 'sequence',
    entityId: '/tmp/x.gb',
    label: 'x.gb',
    ...overrides,
  };
}

describe('scanTabForOversize', () => {
  it('compares current scan authority without confusing it with labels or cached load state', () => {
    const current = tab({
      type: 'file',
      entityId: '/synthetic/current.txt',
      loadStatus: 'pending',
    });
    expect(
      sameFileTabReadAuthority(current, { ...current, label: 'Renamed', loadStatus: 'missing' })
    ).toBe(true);
    expect(
      sameFileTabReadAuthority(current, { ...current, entityId: '/synthetic/other.txt' })
    ).toBe(false);
    expect(sameFileTabReadAuthority(current, { ...current, type: 'table' })).toBe(false);
    const structure = tab({
      type: 'structure',
      entityId: 'saved-view:synthetic',
      initialStructureAttrs: {
        source: 'file',
        sourceId: '/synthetic/old.pdb',
        coordinateFilePath: '/synthetic/old.pdb',
      },
    });
    expect(
      sameFileTabReadAuthority(structure, {
        ...structure,
        initialStructureAttrs: {
          ...structure.initialStructureAttrs,
          source: 'file',
          coordinateFilePath: '/synthetic/current.pdb',
        },
      })
    ).toBe(false);
  });

  it('resolves the real coordinate path for both pinned and not-yet-readable structure tabs', () => {
    expect(
      fileBackedTabPath(
        tab({
          type: 'structure',
          entityId: 'view:file:pinned',
          initialStructureAttrs: {
            source: 'file',
            sourceId: '/old/1FS0.pdb',
            coordinateFilePath: '/current/1FS0.pdb',
            structureArtifactRef: {
              entityId: 'catalog-1',
              revisionId: 'revision-1',
              structureId: 'structure-1',
              coordinateDigestSha256: 'abc',
              artifactPath: '/stale/catalog/1FS0.pdb',
              format: 'pdb',
            },
          },
        })
      )
    ).toBe('/current/1FS0.pdb');
    expect(
      fileBackedTabPath(
        tab({
          type: 'structure',
          entityId: 'view:file:unreadable',
          initialStructureAttrs: {
            source: 'file',
            sourceId: '/lab/private.pdb',
            coordinateFilePath: '/lab/private.pdb',
          },
        })
      )
    ).toBe('/lab/private.pdb');
  });

  it('returns loaded for sub-threshold sequence tab', async () => {
    const stat = vi.fn().mockResolvedValue({ size: 1024 });
    const out = await scanTabForOversize(tab(), stat);
    expect(out.loadStatus).toBe('loaded');
    expect(out.fileSizeBytes).toBe(1024);
    expect(stat).toHaveBeenCalledWith('/tmp/x.gb');
  });

  it('returns deferred-oversized at exactly SOFT_WARN_BYTES', async () => {
    const stat = vi.fn().mockResolvedValue({ size: SOFT_WARN_BYTES });
    const out = await scanTabForOversize(tab(), stat);
    expect(out.loadStatus).toBe('deferred-oversized');
    expect(out.fileSizeBytes).toBe(SOFT_WARN_BYTES);
  });

  it('returns deferred-oversized between SOFT_WARN and HARD_CAP', async () => {
    const stat = vi.fn().mockResolvedValue({ size: SOFT_WARN_BYTES + 1024 });
    const out = await scanTabForOversize(tab(), stat);
    expect(out.loadStatus).toBe('deferred-oversized');
  });

  it('returns deferred-oversized above HARD_CAP_BYTES too', async () => {
    const stat = vi.fn().mockResolvedValue({ size: HARD_CAP_BYTES + 1 });
    const out = await scanTabForOversize(tab(), stat);
    expect(out.loadStatus).toBe('deferred-oversized');
  });

  it('returns missing when stat returns null', async () => {
    const stat = vi.fn().mockResolvedValue(null);
    const out = await scanTabForOversize(tab(), stat);
    expect(out.loadStatus).toBe('missing');
    expect(out.fileSizeBytes).toBeUndefined();
  });

  it('returns error when stat throws', async () => {
    const stat = vi.fn().mockRejectedValue(new Error('EACCES'));
    const out = await scanTabForOversize(tab(), stat);
    expect(out.loadStatus).toBe('error');
    expect(out.fileSizeBytes).toBeUndefined();
  });

  it('classifies a missing local table file without mounting the table viewer', async () => {
    const stat = vi.fn().mockResolvedValue(null);
    const csvTab = tab({
      type: 'table',
      entityId: '/retired-worktree/test-fixtures/tabular/quoted-notes.csv',
      label: 'quoted-notes.csv',
      loadStatus: 'loaded',
    });

    expect(fileBackedTabPath(csvTab)).toBe(
      '/retired-worktree/test-fixtures/tabular/quoted-notes.csv'
    );
    await expect(scanTabForOversize(csvTab, stat)).resolves.toMatchObject({
      loadStatus: 'missing',
      fileSizeBytes: undefined,
    });
    expect(stat).toHaveBeenCalledWith('/retired-worktree/test-fixtures/tabular/quoted-notes.csv');
  });

  it('keeps a large local table on the table-viewer policy instead of sequence deferral', async () => {
    const stat = vi.fn().mockResolvedValue({ size: SOFT_WARN_BYTES });
    const out = await scanTabForOversize(
      tab({ type: 'table', entityId: '/tmp/large.csv', label: 'large.csv' }),
      stat
    );

    expect(out.loadStatus).toBe('loaded');
    expect(out.fileSizeBytes).toBe(SOFT_WARN_BYTES);
  });

  it('does not treat a notebook table identifier as a filesystem path', async () => {
    const stat = vi.fn();
    const notebookTable = tab({
      type: 'table',
      entityId: 'notebook-table:results',
      label: 'Results',
    });

    expect(fileBackedTabPath(notebookTable)).toBeNull();
    await expect(scanTabForOversize(notebookTable, stat)).resolves.toEqual(notebookTable);
    expect(stat).not.toHaveBeenCalled();
  });

  it('single-flights pending revalidation and applies the result after the tab moves', async () => {
    let resolveStat: ((value: { size: number }) => void) | undefined;
    const stat = vi.fn(
      () =>
        new Promise<{ size: number }>((resolve) => {
          resolveStat = resolve;
        })
    );
    const updateTab = vi.fn();
    const csvTab = tab({
      id: 'moving-table',
      type: 'table',
      entityId: '/tmp/moving.csv',
      loadStatus: 'pending',
    });
    let panelId = 'left';
    const deps = {
      stat,
      locateTabById: vi.fn(() => ({ panelId, tab: csvTab })),
      updateTab,
    };

    const first = revalidateFileTab(csvTab, deps);
    const strictModeReplay = revalidateFileTab(csvTab, deps);
    panelId = 'right';
    resolveStat?.({ size: 512 });
    await Promise.all([first, strictModeReplay]);

    expect(stat).toHaveBeenCalledTimes(1);
    expect(updateTab).toHaveBeenCalledWith('right', 'moving-table', {
      loadStatus: 'loaded',
      fileSizeBytes: 512,
    });
  });

  it('does not apply an old reopen stat after the same tab/entity changes coordinate read authority', async () => {
    let finishOld!: (value: { size: number }) => void;
    let finishCurrent!: (value: { size: number }) => void;
    const oldStat = new Promise<{ size: number }>((resolve) => {
      finishOld = resolve;
    });
    const currentStat = new Promise<{ size: number }>((resolve) => {
      finishCurrent = resolve;
    });
    const old = tab({
      id: 'reopened-coordinate',
      type: 'structure',
      entityId: 'saved-view:synthetic',
      loadStatus: 'pending',
      initialStructureAttrs: {
        source: 'file',
        sourceId: '/synthetic/old.pdb',
        coordinateFilePath: '/synthetic/old.pdb',
      },
    });
    let current = old;
    const stat = vi.fn((path: string) => (path === '/synthetic/old.pdb' ? oldStat : currentStat));
    const updateTab = vi.fn();
    const deps = { stat, locateTabById: () => ({ panelId: 'right', tab: current }), updateTab };
    const oldTask = revalidateFileTab(old, deps);
    current = {
      ...old,
      initialStructureAttrs: {
        source: 'file',
        sourceId: '/synthetic/current.pdb',
        coordinateFilePath: '/synthetic/current.pdb',
      },
    };
    const currentTask = revalidateFileTab(current, deps);
    expect(stat.mock.calls.map(([path]) => path)).toEqual([
      '/synthetic/old.pdb',
      '/synthetic/current.pdb',
    ]);
    finishCurrent({ size: 512 });
    await currentTask;
    expect(updateTab).toHaveBeenCalledTimes(1);
    expect(updateTab).toHaveBeenCalledWith('right', current.id, {
      loadStatus: 'loaded',
      fileSizeBytes: 512,
    });
    finishOld({ size: SOFT_WARN_BYTES + 1 });
    await oldTask;
    expect(updateTab).toHaveBeenCalledTimes(1);
  });

  it('does not apply a deferred stat after the same managed document changes its package locator', async () => {
    let finish!: (value: { size: number }) => void;
    const statResult = new Promise<{ size: number }>((resolve) => {
      finish = resolve;
    });
    const old = tab({
      id: 'reopened-package',
      entityId: 'sequence-document:synthetic',
      loadStatus: 'pending',
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'sequence-document:synthetic',
        packageRoot: '/synthetic/old-package',
      },
    });
    let current = old;
    const updateTab = vi.fn();
    const stat = vi.fn(() => statResult);
    const task = revalidateFileTab(old, {
      stat,
      resolveSequenceSource: async () => '/synthetic/old-package/product.gb',
      locateTabById: () => ({ panelId: 'main', tab: current }),
      updateTab,
    });
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    current = {
      ...old,
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'sequence-document:synthetic',
        packageRoot: '/synthetic/current-package',
      },
    };
    finish({ size: 64 });
    await task;
    expect(updateTab).not.toHaveBeenCalled();
  });

  it('does not apply an old indexed manifest receipt to a new native manifest on the same source path', async () => {
    const old = tab({
      id: 'reopened-indexed',
      entityId: 'assembly:synthetic',
      loadStatus: 'indexed',
      indexedGenome: {
        sourcePath: '/synthetic/source.gbff',
        sourceExt: 'gbff',
        sourceSizeBytes: 64,
        chrom: 'chr11',
        manifest: {
          chrom: 'chr11',
          fastaPath: '/synthetic/old.fa',
          faiPath: '/synthetic/old.fa.fai',
        },
      },
    });
    let current = old;
    const updateTab = vi.fn();
    const stat = vi.fn();
    const task = revalidateFileTab(old, {
      stat,
      locateTabById: () => ({ panelId: 'main', tab: current }),
      updateTab,
    });
    current = {
      ...old,
      indexedGenome: {
        ...old.indexedGenome,
        sourcePath: '/synthetic/source.gbff',
        sourceExt: 'gbff',
        sourceSizeBytes: 128,
        chrom: 'chr11',
        manifest: {
          chrom: 'chr11',
          fastaPath: '/synthetic/current.fa',
          faiPath: '/synthetic/current.fa.fai',
        },
      },
    };
    await task;
    expect(stat).not.toHaveBeenCalled();
    expect(updateTab).not.toHaveBeenCalled();
  });

  it('keeps an indexed tab with a manifest on the indexed path', async () => {
    const stat = vi.fn();
    const out = await scanTabForOversize(
      tab({
        loadStatus: 'indexed',
        indexedGenome: {
          sourcePath: '/tmp/chr11.gbff',
          sourceSizeBytes: HARD_CAP_BYTES + 1,
          sourceExt: 'gbff',
          chrom: 'chr11',
          manifest: {
            chrom: 'chr11',
            fastaPath: '/tmp/.waypoint/genome-index/chr11/chr11.fa',
            faiPath: '/tmp/.waypoint/genome-index/chr11/chr11.fa.fai',
            gffPath: '/tmp/.waypoint/genome-index/chr11/chr11.gff3.gz',
            tbiPath: '/tmp/.waypoint/genome-index/chr11/chr11.gff3.gz.tbi',
          },
        },
      }),
      stat
    );
    expect(out.loadStatus).toBe('indexed');
    expect(out.fileSizeBytes).toBe(HARD_CAP_BYTES + 1);
    expect(stat).not.toHaveBeenCalled();
  });

  it('keeps an indexed tab without a manifest pending when the source exists', async () => {
    const stat = vi.fn().mockResolvedValue({ size: HARD_CAP_BYTES + 1 });
    const resolveSequenceSource = vi.fn().mockRejectedValue(new Error('must not resolve'));
    const out = await scanTabForOversize(
      tab({
        entityId: 'assembly:grch38',
        sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:grch38' },
        indexedGenome: {
          sourcePath: '/tmp/chr11.gbff',
          sourceSizeBytes: HARD_CAP_BYTES + 1,
          sourceExt: 'gbff',
          chrom: 'chr11',
        },
      }),
      stat,
      resolveSequenceSource
    );
    expect(out.loadStatus).toBe('indexed-pending');
    expect(out.fileSizeBytes).toBe(HARD_CAP_BYTES + 1);
    expect(stat).toHaveBeenCalledWith('/tmp/chr11.gbff');
    expect(resolveSequenceSource).not.toHaveBeenCalled();
  });

  it('passes through non-file-backed tabs untouched', async () => {
    const stat = vi.fn();
    const chatTab = tab({ id: 'c1', type: 'chat', entityId: 'conv-1', label: 'Chat' });
    const out = await scanTabForOversize(chatTab, stat);
    expect(out).toEqual(chatTab);
    expect(stat).not.toHaveBeenCalled();
  });

  it('scans persisted local structure tabs by artifact path but never stats provider tabs', async () => {
    const stat = vi.fn().mockResolvedValue({ size: 4096 });
    const local = tab({
      type: 'structure',
      entityId: 'view:file:1',
      initialStructureAttrs: {
        source: 'file',
        coordinateFilePath: '/lab/1FS0.pdb',
        structureArtifactRef: {
          entityId: 'catalog-1',
          revisionId: 'revision-1',
          structureId: 'structure-1',
          coordinateDigestSha256: 'abc',
          artifactPath: '/lab/1FS0.pdb',
          format: 'pdb',
        },
      },
    });
    const provider = tab({
      type: 'structure',
      entityId: 'view:rcsb:1',
      initialStructureAttrs: { source: 'pdb', sourceId: '1FS0' },
    });

    const localResult = await scanTabForOversize(local, stat);
    const providerResult = await scanTabForOversize(provider, stat);

    expect(localResult).toMatchObject({ loadStatus: 'loaded', fileSizeBytes: 4096 });
    expect(providerResult).toEqual(provider);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith('/lab/1FS0.pdb');
  });

  it('preserves other Tab fields', async () => {
    const stat = vi.fn().mockResolvedValue({ size: 50 });
    const out = await scanTabForOversize(
      tab({ id: 'X', label: 'My Label', isDirty: true, viewState: { sequenceViewMode: '1d' } }),
      stat
    );
    expect(out.id).toBe('X');
    expect(out.label).toBe('My Label');
    expect(out.isDirty).toBe(true);
    expect(out.viewState).toEqual({ sequenceViewMode: '1d' });
  });
});

describe('scanTabsForOversize', () => {
  it('classifies a heterogeneous tab list in parallel', async () => {
    const sizes: Record<string, { size: number } | null> = {
      '/tmp/small.gb': { size: 1024 },
      '/tmp/big.gb': { size: SOFT_WARN_BYTES + 100 },
      '/tmp/missing.gb': null,
    };
    const stat = vi.fn(async (p: string) => {
      if (p === '/tmp/throws.gb') throw new Error('EACCES');
      return sizes[p] ?? null;
    });

    const tabs: Tab[] = [
      tab({ id: '1', entityId: '/tmp/small.gb' }),
      tab({ id: '2', entityId: '/tmp/big.gb' }),
      tab({ id: '3', entityId: '/tmp/missing.gb' }),
      tab({ id: '4', entityId: '/tmp/throws.gb' }),
      tab({ id: '5', type: 'chat', entityId: 'conv-1', label: 'C' }),
    ];

    const out = await scanTabsForOversize(tabs, stat);
    expect(out.map((t) => t.loadStatus)).toEqual([
      'loaded',
      'deferred-oversized',
      'missing',
      'error',
      undefined,
    ]);
  });

  it('returns an empty list when given no tabs', async () => {
    const stat = vi.fn();
    const out = await scanTabsForOversize([], stat);
    expect(out).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });
});
