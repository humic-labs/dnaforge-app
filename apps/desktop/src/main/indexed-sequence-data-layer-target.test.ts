import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GenomeFeature } from '@waypoint/genome-data';
import type { PreparedReferenceAssemblyEntryV1 } from '../shared/reference-assets-ipc';
import { fingerprintSequenceDataLayerAnnotations } from '../shared/sequence-data-layer-annotations';
import { sequenceDataLayerIndexedTargetId } from '../shared/sequence-data-layer-indexed-target';
import { indexedSequenceDataLayerTarget } from './indexed-sequence-data-layer-target';

const identity = { sequenceIdentity: 'a'.repeat(64), annotationIdentity: 'b'.repeat(64) };
const target = { referenceId: 'ecoli-mg1655', chrom: 'NC_000913.3', ...identity };
const documentId = sequenceDataLayerIndexedTargetId(target);
const rawFeature: GenomeFeature = {
  chrom: target.chrom,
  source: 'RefSeq',
  type: 'gene',
  start: 70,
  end: 90,
  score: null,
  strand: '-',
  phase: null,
  attributes: { ID: ['gene-b1007'], locus_tag: ['b1007'] },
  raw: '',
};
const entry: PreparedReferenceAssemblyEntryV1 = {
  referenceIdentity: identity,
  id: target.referenceId,
  name: 'E. coli',
  organism: 'E. coli',
  description: '',
  assetCacheKey: target.referenceId,
  members: [
    {
      chrom: target.chrom,
      lengthBp: 100,
      manifest: {
        fastaPath: '/owned/ecoli.fa',
        faiPath: '/owned/ecoli.fa.fai',
        gffPath: '/owned/ecoli.gff3.gz',
        tbiPath: '/owned/ecoli.gff3.gz.tbi',
      },
    },
  ],
};

function fixture(selected = entry) {
  const source = {
    getChromosomeLength: vi.fn(async () => 100),
    getSequence: vi.fn(async () => 'acgt'.repeat(25)),
    getFeatures: vi.fn(async () => [rawFeature]),
    close: vi.fn(async () => undefined),
  };
  const createSource = vi.fn(() => source);
  const stat = vi.fn(async (_path: string) => ({
    size: 100,
    mtimeMs: 1,
    ctimeMs: 2,
    ino: 3,
    dev: 4,
    isFile: () => true,
  }));
  const releases = vi.fn();
  const referenceRead = vi.fn();
  const withReference = async <T>(
    id: string,
    use: (value: PreparedReferenceAssemblyEntryV1) => Promise<T>
  ) => {
    referenceRead(id);
    if (id !== selected.id) throw new Error('REFERENCE_NOT_PREPARED');
    try {
      return await use(selected);
    } finally {
      releases();
    }
  };
  return {
    referenceRead,
    source,
    createSource,
    stat,
    releases,
    dependencies: { withReference, createSource, stat },
  };
}

describe('native indexed sequence data layer target', () => {
  it('reads an owned contig with exact normalized bases and raw identifier coordinates', async () => {
    const f = fixture();
    const snapshot = await indexedSequenceDataLayerTarget(documentId, target, f.dependencies);
    expect(snapshot).toEqual({
      documentId,
      length: 100,
      sequenceFingerprint: `sha256:${createHash('sha256').update('ACGT'.repeat(25)).digest('hex')}`,
      annotationFingerprint: await fingerprintSequenceDataLayerAnnotations([
        { id: 'gene-b1007', start0: 70, end0: 90, qualifiers: rawFeature.attributes },
      ]),
      annotations: [{ id: 'gene-b1007', start0: 70, end0: 90, qualifiers: rawFeature.attributes }],
    });
    expect(f.source.getFeatures).toHaveBeenCalledWith(target.chrom, 0, 100, 0);
    expect(f.source.close).toHaveBeenCalledOnce();
    expect(f.releases).toHaveBeenCalledOnce();
  });

  it.each(['sequenceIdentity', 'annotationIdentity'] as const)(
    'refuses a stale displayed %s before source reads',
    async (field) => {
      const f = fixture({ ...entry, referenceIdentity: { ...identity, [field]: 'c'.repeat(64) } });
      await expect(
        indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
      ).rejects.toThrow();
      expect(f.createSource).not.toHaveBeenCalled();
      expect(f.stat).not.toHaveBeenCalled();
      expect(f.releases).toHaveBeenCalledOnce();
    }
  );

  it('does not accept a missing local reference or resolve a caller-provided path', async () => {
    const f = fixture();
    const absent = { ...target, referenceId: '/arbitrary/other.fa' };
    await expect(
      indexedSequenceDataLayerTarget(
        sequenceDataLayerIndexedTargetId(absent),
        absent,
        f.dependencies
      )
    ).rejects.toThrow('REFERENCE_NOT_PREPARED');
    expect(f.createSource).not.toHaveBeenCalled();
    expect(f.stat).not.toHaveBeenCalled();
  });

  it('refuses a different logical identity before reading a reference', async () => {
    const f = fixture();
    await expect(
      indexedSequenceDataLayerTarget('ordinary-id', target, f.dependencies)
    ).rejects.toThrow();
    expect(f.referenceRead).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, 6_000_001])(
    'refuses unsupported contig length %s before opening source files',
    async (lengthBp) => {
      const f = fixture({ ...entry, members: [{ ...entry.members[0], lengthBp }] });
      await expect(
        indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
      ).rejects.toThrow();
      expect(f.createSource).not.toHaveBeenCalled();
      expect(f.stat).not.toHaveBeenCalled();
      expect(f.releases).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { ...entry, members: [] },
    { ...entry, members: [entry.members[0], entry.members[0]] },
    { ...entry, members: [{ ...entry.members[0], manifest: undefined }] },
    {
      ...entry,
      members: [
        { ...entry.members[0], manifest: { ...entry.members[0].manifest!, tbiPath: undefined } },
      ],
    },
  ])('refuses missing, ambiguous or partially indexed members', async (selected) => {
    const f = fixture(selected);
    await expect(
      indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
    ).rejects.toThrow();
    expect(f.createSource).not.toHaveBeenCalled();
  });

  it('refuses an oversized GFF before creating an indexed source', async () => {
    const f = fixture();
    f.stat.mockImplementation(async (path) => ({
      size: path.endsWith('.gff3.gz') ? 32 * 1024 * 1024 + 1 : 100,
      mtimeMs: 1,
      ctimeMs: 2,
      ino: 3,
      dev: 4,
      isFile: () => true,
    }));
    await expect(
      indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
    ).rejects.toThrow();
    expect(f.createSource).not.toHaveBeenCalled();
  });

  it('refuses a source whose actual sequence length differs from its prepared member', async () => {
    const f = fixture();
    f.source.getChromosomeLength.mockResolvedValue(101);
    await expect(
      indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
    ).rejects.toThrow();
    expect(f.source.getSequence).not.toHaveBeenCalled();
    expect(f.source.close).toHaveBeenCalledOnce();
  });

  it('closes the source and releases its reference when reading fails', async () => {
    const f = fixture();
    f.source.getFeatures.mockRejectedValue(new Error('GFF read failed'));
    await expect(
      indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
    ).rejects.toThrow('GFF read failed');
    expect(f.source.close).toHaveBeenCalledOnce();
    expect(f.releases).toHaveBeenCalledOnce();
  });

  it('refuses more than 100000 source annotations', async () => {
    const f = fixture();
    f.source.getFeatures.mockResolvedValue(Array(100_001).fill(rawFeature));
    await expect(
      indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
    ).rejects.toThrow();
    expect(f.source.close).toHaveBeenCalledOnce();
  });

  it.each([
    { ...rawFeature, chrom: 'another-chromosome' },
    { ...rawFeature, start: -1 },
    { ...rawFeature, end: 101 },
    { ...rawFeature, end: 70 },
  ])('refuses invalid raw feature coordinates', async (feature) => {
    const f = fixture();
    f.source.getFeatures.mockResolvedValue([feature]);
    await expect(
      indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
    ).rejects.toThrow();
    expect(f.source.close).toHaveBeenCalledOnce();
  });

  it('refuses changed source files across sequence and annotation reads', async () => {
    const f = fixture();
    f.source.getFeatures.mockImplementation(async () => {
      f.stat.mockResolvedValue({
        size: 100,
        mtimeMs: 2,
        ctimeMs: 3,
        ino: 3,
        dev: 4,
        isFile: () => true,
      });
      return [rawFeature];
    });
    await expect(
      indexedSequenceDataLayerTarget(documentId, target, f.dependencies)
    ).rejects.toThrow();
    expect(f.source.close).toHaveBeenCalledOnce();
  });

  it('reads an actual indexed fixture with native FASTA and Tabix readers', async () => {
    const directory = resolve('../../test-fixtures/indexed/pUC19');
    const selected: PreparedReferenceAssemblyEntryV1 = {
      ...entry,
      members: [
        {
          chrom: 'puc19',
          lengthBp: 2686,
          manifest: {
            fastaPath: `${directory}/pUC19.fa`,
            faiPath: `${directory}/pUC19.fa.fai`,
            gffPath: `${directory}/pUC19.gff3.gz`,
            tbiPath: `${directory}/pUC19.gff3.gz.tbi`,
          },
        },
      ],
    };
    const requested = { referenceId: selected.id, chrom: 'puc19', ...identity };
    const result = await indexedSequenceDataLayerTarget(
      sequenceDataLayerIndexedTargetId(requested),
      requested,
      {
        withReference: async (_id, use) => use(selected),
      }
    );
    const sequence = (await readFile(`${directory}/pUC19.fa`, 'utf8'))
      .split('\n')
      .filter((line) => !line.startsWith('>'))
      .join('')
      .toUpperCase();
    expect(result.sequenceFingerprint).toBe(
      `sha256:${createHash('sha256').update(sequence).digest('hex')}`
    );
    expect(result.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lacZ.cds.1', start0: 145, end0: 469 }),
      ])
    );
  });
});
