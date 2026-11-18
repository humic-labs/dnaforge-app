import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildGenomeComparisonLayout,
  parseGenomeComparisonPaf,
  type GenomeFeature,
} from '@waypoint/genome-data';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import { describe, expect, it, vi } from 'vitest';
import type { PreparedReferenceAssemblyEntryV1 } from '../shared/reference-assets-ipc';
import {
  comparisonSourceProjectionId,
  comparisonSourceWindowRequestSchema,
  MAX_COMPARISON_WINDOW_FEATURES,
  type ComparisonSourceWindowRequest,
} from '../shared/comparison-source';
import { comparisonSourceIntervals, readComparisonSourceWindow } from './comparison-source-window';

const identity = { sequenceIdentity: 'a'.repeat(64), annotationIdentity: 'b'.repeat(64) };
const source = {
  schema: 'dnaforge.comparison-source.v1' as const,
  path: 'alignment.paf',
  sha256: 'c'.repeat(64),
  targetReference: { id: 'puc19', chrom: 'puc19', length: 2686 },
  queryReference: { id: 'puc19', chrom: 'puc19', length: 2686 },
  targetSource: { referenceId: 'target-prepared', ...identity },
  querySource: { referenceId: 'query-prepared', ...identity },
};
const comparison = parseGenomeComparisonPaf(
  [
    'puc19\t2686\t140\t154\t+\tpuc19\t2686\t140\t152\t12\t14\t60\tcg:Z:5=2I7=',
    'puc19\t2686\t2000\t2010\t-\tpuc19\t2686\t180\t190\t8\t12\t60\tcg:Z:3=2D3=2I2=',
  ].join('\n'),
  { target: { id: 'puc19', length: 2686 }, query: { id: 'puc19', length: 2686 } }
);
const layout = buildGenomeComparisonLayout(comparison.blocks);
const request: ComparisonSourceWindowRequest = {
  project: '/project',
  source,
  camera: {
    projectionId: comparisonSourceProjectionId(source),
    startColumn: 0,
    endColumn: layout.columnLength,
  },
};
const feature: GenomeFeature = {
  chrom: 'puc19',
  source: 'RefSeq',
  type: 'gene',
  start: 145,
  end: 160,
  strand: '-',
  phase: null,
  score: null,
  raw: '',
  attributes: { ID: ['source-gene'], Name: ['source gene'] },
};
function fixture() {
  const entries = Object.fromEntries(
    ['target', 'query'].map((side) => [
      side,
      {
        id: `${side}-prepared`,
        name: side,
        organism: side,
        description: '',
        assetCacheKey: side,
        referenceIdentity: identity,
        members: [
          {
            chrom: 'puc19',
            lengthBp: 2686,
            manifest: {
              fastaPath: `/${side}.fa`,
              faiPath: `/${side}.fa.fai`,
              gffPath: `/${side}.gff.gz`,
              tbiPath: `/${side}.gff.gz.tbi`,
            },
          },
        ],
      },
    ])
  ) as Record<'target' | 'query', PreparedReferenceAssemblyEntryV1>;
  const sources = ['target', 'query'].map(() => ({
    getChromosomeLength: vi.fn(async () => 2686),
    getSequence: vi.fn(async (_chrom: string, start: number, end: number) =>
      'A'.repeat(end - start)
    ),
    getFeatures: vi.fn(async () => [feature]),
    close: vi.fn(async () => undefined),
  }));
  const retained = new Set<string>();
  const released = vi.fn();
  const assertCurrent = vi.fn();
  const stat = vi.fn(async (_path: string) => ({
    dev: 1,
    ino: 2,
    size: 100,
    mtimeMs: 3,
    ctimeMs: 4,
    isFile: () => true,
  }));
  const createSource = vi.fn((manifest: { fastaPath: string }) => {
    expect(retained.size).toBe(manifest.fastaPath.includes('target') ? 1 : 2);
    return sources[manifest.fastaPath.includes('target') ? 0 : 1];
  });
  const withReference = async <T>(
    id: string,
    use: (entry: PreparedReferenceAssemblyEntryV1) => Promise<T>
  ) => {
    const entry = Object.values(entries).find((candidate) => candidate.id === id);
    if (!entry) throw new Error('REFERENCE_NOT_PREPARED');
    retained.add(id);
    try {
      return await use(entry);
    } finally {
      retained.delete(id);
      released(id);
    }
  };
  return {
    entries,
    sources,
    retained,
    released,
    assertCurrent,
    stat,
    createSource,
    dependencies: { withReference, stat, createSource },
  };
}

describe('native bounded comparison source windows', () => {
  it('clips CIGAR insertions/deletions and reverse segments to exact forward-source intervals', () => {
    expect(comparisonSourceIntervals(layout, 'target', 3, 10)).toEqual([{ start: 143, end: 148 }]);
    expect(comparisonSourceIntervals(layout, 'query', 3, 10)).toEqual([{ start: 143, end: 150 }]);
    expect(comparisonSourceIntervals(layout, 'target', 51, 55)).toEqual([{ start: 185, end: 188 }]);
    expect(comparisonSourceIntervals(layout, 'query', 51, 55)).toEqual([
      { start: 2003, end: 2007 },
    ]);
    expect(comparisonSourceIntervals(layout, 'query', 49, 51)).toEqual([]);
    expect(comparisonSourceIntervals(layout, 'target', 54, 56)).toEqual([]);
  });

  it('keeps distant rearranged windows separate and retains both sources until all reads close', async () => {
    const f = fixture();
    const result = await readComparisonSourceWindow(
      request,
      layout,
      f.dependencies,
      f.assertCurrent
    );
    expect(
      result.querySequenceWindows.map(({ start, sequence }) => [start, sequence.length])
    ).toEqual([
      [140, 14],
      [2000, 10],
    ]);
    expect(f.sources[1].getSequence.mock.calls).toEqual([
      ['puc19', 140, 154],
      ['puc19', 2000, 2010],
    ]);
    expect(result.annotations.target).toEqual([
      { id: 'source-gene', label: 'source gene', start: 145, end: 160, strand: '-' },
    ]);
    expect(result.annotationsStatus).toEqual({ target: 'ready', query: 'ready' });
    expect(f.sources.every((value) => value.close.mock.calls.length === 1)).toBe(true);
    expect(f.released.mock.calls).toEqual([['query-prepared'], ['target-prepared']]);
    expect(f.retained.size).toBe(0);
  });

  it('makes no biological range reads for a camera inside an unaligned join', async () => {
    const f = fixture();
    await readComparisonSourceWindow(
      { ...request, camera: { ...request.camera, startColumn: 16, endColumn: 40 } },
      layout,
      f.dependencies,
      f.assertCurrent
    );
    for (const value of f.sources) {
      expect(value.getSequence).not.toHaveBeenCalled();
      expect(value.getFeatures).not.toHaveBeenCalled();
      expect(value.close).toHaveBeenCalledOnce();
    }
  });

  it.each(['sequenceIdentity', 'annotationIdentity'] as const)(
    'rejects changed pinned %s before creating a source',
    async (field) => {
      const f = fixture();
      f.entries.target = {
        ...f.entries.target,
        referenceIdentity: { ...identity, [field]: 'd'.repeat(64) },
      };
      await expect(
        readComparisonSourceWindow(request, layout, f.dependencies, f.assertCurrent)
      ).rejects.toThrow('content has changed');
      expect(f.createSource).not.toHaveBeenCalled();
      expect(f.retained.size).toBe(0);
    }
  );

  it('rejects an alias or changed chromosome length in the prepared binding', async () => {
    for (const change of [{ chrom: 'alias' }, { lengthBp: 2687 }]) {
      const f = fixture();
      f.entries.query = {
        ...f.entries.query,
        members: [{ ...f.entries.query.members[0], ...change }],
      };
      await expect(
        readComparisonSourceWindow(request, layout, f.dependencies, f.assertCurrent)
      ).rejects.toThrow('exact prepared chromosome');
      expect(f.sources[0].close).toHaveBeenCalledOnce();
      expect(f.sources[1].getSequence).not.toHaveBeenCalled();
      expect(f.retained.size).toBe(0);
    }
  });

  it('closes sources and releases leases when a sequence is incomplete or authority is revoked', async () => {
    const f = fixture();
    f.sources[1].getSequence.mockResolvedValue('');
    await expect(
      readComparisonSourceWindow(request, layout, f.dependencies, f.assertCurrent)
    ).rejects.toThrow('incomplete');
    expect(f.sources.every((value) => value.close.mock.calls.length === 1)).toBe(true);
    expect(f.retained.size).toBe(0);
    const revoked = fixture();
    revoked.sources[1].getSequence.mockImplementation(async (_chrom, start, end) => {
      revoked.assertCurrent.mockImplementation(() => {
        throw new Error('PROJECT_READ_REVOKED');
      });
      return 'A'.repeat(end - start);
    });
    await expect(
      readComparisonSourceWindow(request, layout, revoked.dependencies, revoked.assertCurrent)
    ).rejects.toThrow('PROJECT_READ_REVOKED');
    expect(revoked.sources.every((value) => value.close.mock.calls.length === 1)).toBe(true);
    expect(revoked.retained.size).toBe(0);
  });

  it('rejects a source replacement during the retained window read, including after close', async () => {
    const f = fixture();
    let changed = false;
    f.sources[1].close.mockImplementation(async () => {
      changed = true;
    });
    f.stat.mockImplementation(async (_path) => ({
      dev: 1,
      ino: changed ? 99 : 2,
      size: 100,
      mtimeMs: 3,
      ctimeMs: 4,
      isFile: () => true,
    }));
    await expect(
      readComparisonSourceWindow(request, layout, f.dependencies, f.assertCurrent)
    ).rejects.toThrow('changed during');
    expect(f.sources.every((value) => value.close.mock.calls.length === 1)).toBe(true);
    expect(f.retained.size).toBe(0);
  });

  it('caps sequence blocks while retaining bounded annotations at whole-reference scale', async () => {
    const broad = parseGenomeComparisonPaf(
      'puc19\t50000\t0\t50000\t+\tpuc19\t50000\t0\t50000\t50000\t50000\t60\tcg:Z:50000=',
      {
        target: { id: 'puc19', length: 50000 },
        query: { id: 'puc19', length: 50000 },
      }
    );
    const f = fixture();
    for (const side of ['target', 'query'] as const)
      f.entries[side] = {
        ...f.entries[side],
        members: [{ ...f.entries[side].members[0], lengthBp: 50000 }],
      };
    for (const value of f.sources) value.getChromosomeLength.mockResolvedValue(50000);
    const result = await readComparisonSourceWindow(
      {
        ...request,
        source: {
          ...source,
          targetReference: { ...source.targetReference, length: 50000 },
          queryReference: { ...source.queryReference, length: 50000 },
        },
        camera: { ...request.camera, endColumn: 50000 },
      },
      buildGenomeComparisonLayout(broad.blocks),
      f.dependencies,
      f.assertCurrent
    );
    expect(result.basesStatus).toBe('zoom-in');
    expect(result.annotationsStatus).toEqual({ target: 'ready', query: 'ready' });
    expect(result.annotations.query[0]?.id).toBe('source-gene');
    for (const value of f.sources) expect(value.getSequence).not.toHaveBeenCalled();
  });

  it('distinguishes capped or unavailable annotations from an empty successful source', async () => {
    const f = fixture();
    f.sources[0].getFeatures.mockResolvedValue(
      Array.from({ length: MAX_COMPARISON_WINDOW_FEATURES + 1 }, () => feature)
    );
    const result = await readComparisonSourceWindow(
      request,
      layout,
      f.dependencies,
      f.assertCurrent
    );
    expect(result.annotationsStatus).toEqual({ target: 'zoom-in', query: 'zoom-in' });
    expect(result.annotations).toEqual({ target: [], query: [] });
    const absent = fixture();
    absent.entries.query = {
      ...absent.entries.query,
      members: [
        {
          ...absent.entries.query.members[0],
          manifest: { fastaPath: '/query.fa', faiPath: '/query.fa.fai' },
        },
      ],
    };
    const missing = await readComparisonSourceWindow(
      request,
      layout,
      absent.dependencies,
      absent.assertCurrent
    );
    expect(missing.annotationsStatus.query).toBe('unavailable');
    expect(absent.sources[1].getFeatures).not.toHaveBeenCalled();
  });

  it('does not manufacture source identities for unnamed features or move reverse-strand annotations', async () => {
    const f = fixture();
    f.sources[1].getFeatures.mockResolvedValue([
      { ...feature, attributes: {} },
      { ...feature, start: 2001, end: 2008 },
    ]);
    const result = await readComparisonSourceWindow(
      request,
      layout,
      f.dependencies,
      f.assertCurrent
    );
    expect(result.annotations.query).toEqual([
      { id: 'source-gene', label: 'source gene', start: 2001, end: 2008, strand: '-' },
    ]);
  });

  it('retains exact source gene parents when one protein ID occurs at distinct annotated loci', async () => {
    const f = fixture();
    f.sources[1].getFeatures.mockResolvedValue([
      { ...feature, attributes: { ID: ['gene-one'], Name: ['one'] } },
      { ...feature, start: 2001, end: 2008, attributes: { ID: ['gene-two'], Name: ['two'] } },
      { ...feature, type: 'CDS', attributes: { ID: ['same-protein'], Parent: ['gene-one'] } },
      {
        ...feature,
        type: 'CDS',
        start: 2001,
        end: 2008,
        attributes: { ID: ['same-protein'], Parent: ['gene-two'] },
      },
    ]);
    const result = await readComparisonSourceWindow(
      request,
      layout,
      f.dependencies,
      f.assertCurrent
    );
    expect(result.annotations.query).toEqual([
      { id: 'gene-one', label: 'one', start: 145, end: 160, strand: '-' },
      { id: 'gene-two', label: 'two', start: 2001, end: 2008, strand: '-' },
    ]);
  });

  it('requires the pinned camera and rejects columns beyond the exact layout', async () => {
    expect(
      comparisonSourceWindowRequestSchema.safeParse({
        ...request,
        camera: { ...request.camera, projectionId: `comparison:${source.sha256}` },
      }).success
    ).toBe(false);
    const f = fixture();
    await expect(
      readComparisonSourceWindow(
        { ...request, camera: { ...request.camera, endColumn: layout.columnLength + 1 } },
        layout,
        f.dependencies,
        f.assertCurrent
      )
    ).rejects.toThrow('alignment columns');
    expect(f.createSource).not.toHaveBeenCalled();
  });

  it('reads real indexed FASTA and tabix GFF windows without expanding a distant query span', async () => {
    const f = fixture();
    const base = resolve(import.meta.dirname, '../../../../test-fixtures/indexed/pUC19');
    const manifest = {
      fastaPath: resolve(base, 'pUC19.fa'),
      faiPath: resolve(base, 'pUC19.fa.fai'),
      gffPath: resolve(base, 'pUC19.gff3.gz'),
      tbiPath: resolve(base, 'pUC19.gff3.gz.tbi'),
    };
    for (const side of ['target', 'query'] as const)
      f.entries[side] = {
        ...f.entries[side],
        members: [{ chrom: 'puc19', lengthBp: 2686, manifest }],
      };
    const sequence = (await readFile(manifest.fastaPath, 'utf8'))
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith('>'))
      .join('')
      .toUpperCase();
    const readers: LocalIndexedGenomeDataSource[] = [];
    const readRanges: unknown[][] = [];
    const result = await readComparisonSourceWindow(
      request,
      layout,
      {
        withReference: f.dependencies.withReference,
        createSource: (input) => {
          const reader = new LocalIndexedGenomeDataSource(input, {
            sequenceBlockSize: 256,
            featureBucketSize: 1,
          });
          readers.push(reader);
          const original = reader.getSequence.bind(reader);
          vi.spyOn(reader, 'getSequence').mockImplementation(async (...args) => {
            readRanges.push(args);
            return original(...args);
          });
          vi.spyOn(reader, 'close');
          return reader;
        },
      },
      f.assertCurrent
    );
    expect(result.targetSequenceWindows).toEqual([
      { start: 140, sequence: sequence.slice(140, 152) },
      { start: 180, sequence: sequence.slice(180, 190) },
    ]);
    expect(result.querySequenceWindows).toEqual([
      { start: 140, sequence: sequence.slice(140, 154) },
      { start: 2000, sequence: sequence.slice(2000, 2010) },
    ]);
    expect(result.annotations.target).toContainEqual({
      id: 'lacZ.cds.1',
      label: 'lacZ-alpha',
      start: 145,
      end: 469,
      strand: '-',
    });
    expect(result.annotations.query).toContainEqual({
      id: 'bla.cds.1',
      label: 'AmpR',
      start: 1625,
      end: 2486,
      strand: '-',
    });
    expect(readRanges).toHaveLength(4);
    expect(readRanges.every(([, start, end]) => Number(end) - Number(start) <= 14)).toBe(true);
    expect(readers.every((reader) => vi.mocked(reader.close).mock.calls.length === 1)).toBe(true);
    expect(f.retained.size).toBe(0);
  });
});
