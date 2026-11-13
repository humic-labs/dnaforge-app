import { beforeEach, describe, expect, it, vi } from 'vitest';

import { admitIndexedBigWigSource } from './indexed-track-admission';
import { useLaneContractStore } from './lane-contract-store';
import {
  assemblyIdFromIndexedGenome,
  assemblyReferencesFromIndexedGenome,
  attachIndexedBigWig,
} from './attach-indexed-bigwig';
import type { IndexedGenomeTabState } from '../../shared/indexed-genome';

vi.mock('./indexed-track-admission', () => ({
  admitIndexedBigWigSource: vi.fn(),
}));

const GENOME = {
  laneOwnerId: 'tab-1',
  assemblyId: 'grch38',
  assemblyReferences: [{ name: 'chr1', length: 1_000 }],
};

function admittedSource(source: { kind: 'path'; path: string } | { kind: 'url'; url: string }) {
  const locator = source.kind === 'path' ? source.path : source.url;
  return {
    admissionVersion: 1 as const,
    uri: source.kind === 'path' ? `file://${locator}` : locator,
    input: source,
    formatId: 'bigwig' as const,
    recommendedTypes: ['quantitative'],
    fingerprint: `generation:${locator}`,
    readerKind: 'bbi' as const,
    scientificKind: 'quantitative' as const,
    assemblyId: GENOME.assemblyId,
    referenceReceipt: {
      assemblyId: GENOME.assemblyId,
      referenceSignature: 'chr1',
      sourceSignature: 'chr1',
      contigMap: { chr1: 'chr1' },
      checkedContigs: 1,
      status: 'compatible' as const,
      checkedAt: '2026-08-17T00:00:00.000Z',
    },
    provenance: {
      provider: source.kind === 'path' ? ('local-file' as const) : ('direct-url' as const),
      sourceKind: source.kind === 'path' ? ('local-file' as const) : ('remote-url' as const),
      label: 'signal.bigWig',
    },
  };
}

describe('attachIndexedBigWig', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
    vi.mocked(admitIndexedBigWigSource)
      .mockReset()
      .mockImplementation(async ({ source }) => admittedSource(source));
  });

  it('admits a URL once and reports the second attach as duplicate', async () => {
    const source = { kind: 'url' as const, url: 'https://results.example.org/run/signal.bigWig' };
    const first = await attachIndexedBigWig({
      ...GENOME,
      source,
      label: 'RNA-seq coverage',
    });
    const second = await attachIndexedBigWig({
      ...GENOME,
      source,
      label: 'A later label does not rename the existing lane',
    });

    expect(first).toMatchObject({ status: 'added', label: 'RNA-seq coverage' });
    expect(second).toMatchObject({ status: 'duplicate', label: 'RNA-seq coverage' });
    expect(vi.mocked(admitIndexedBigWigSource)).toHaveBeenCalledTimes(1);
    expect(useLaneContractStore.getState().lanesForOwner(GENOME.laneOwnerId)).toEqual([
      expect.objectContaining({
        dataset: expect.objectContaining({ label: 'RNA-seq coverage', trackPx: 96 }),
      }),
    ]);
  });

  it('single-flights concurrent admissions and keeps the first durable label', async () => {
    const source = { kind: 'url' as const, url: 'https://results.example.org/run/race.bigWig' };
    let releaseAdmission: (() => void) | undefined;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    vi.mocked(admitIndexedBigWigSource).mockImplementationOnce(async ({ source: admitted }) => {
      await admissionGate;
      return admittedSource(admitted);
    });

    const firstAttachment = attachIndexedBigWig({ ...GENOME, source, label: 'First label' });
    const secondAttachment = attachIndexedBigWig({ ...GENOME, source, label: 'Second label' });

    expect(vi.mocked(admitIndexedBigWigSource)).toHaveBeenCalledTimes(1);
    if (!releaseAdmission) {
      throw new Error('Admission gate was not initialized.');
    }
    releaseAdmission();
    const [first, second] = await Promise.all([firstAttachment, secondAttachment]);

    expect(first).toMatchObject({ status: 'added', label: 'First label' });
    expect(second).toMatchObject({ status: 'duplicate', label: 'First label' });
    expect(vi.mocked(admitIndexedBigWigSource)).toHaveBeenCalledTimes(1);
    expect(useLaneContractStore.getState().lanesForOwner(GENOME.laneOwnerId)).toHaveLength(1);
  });

  it('retires a failed single-flight so a later attach can retry', async () => {
    const source = { kind: 'url' as const, url: 'https://results.example.org/run/retry.bigWig' };
    let rejectAdmission: ((reason?: unknown) => void) | undefined;
    const failedAdmission = new Promise<never>((_resolve, reject) => {
      rejectAdmission = reject;
    });
    vi.mocked(admitIndexedBigWigSource).mockReturnValueOnce(failedAdmission);

    const firstAttachment = attachIndexedBigWig({ ...GENOME, source });
    const secondAttachment = attachIndexedBigWig({ ...GENOME, source });
    const firstFailure = expect(firstAttachment).rejects.toThrow('temporary admission failure');
    const secondFailure = expect(secondAttachment).rejects.toThrow('temporary admission failure');

    expect(vi.mocked(admitIndexedBigWigSource)).toHaveBeenCalledTimes(1);
    if (!rejectAdmission) {
      throw new Error('Admission rejection gate was not initialized.');
    }
    rejectAdmission(new Error('temporary admission failure'));
    await Promise.all([firstFailure, secondFailure]);

    const retry = await attachIndexedBigWig({ ...GENOME, source });
    expect(retry.status).toBe('added');
    expect(vi.mocked(admitIndexedBigWigSource)).toHaveBeenCalledTimes(2);
  });

  it('derives assembly identity from a multi-chromosome tab or a single contig', () => {
    const assemblyGenome = {
      sourcePath: 'refs/chrI.fa',
      sourceExt: '.fa',
      chrom: 'chrI',
      assembly: {
        assemblyId: 'grcz12tu',
        displayName: 'GRCz12tu',
        chromosomes: [
          {
            chrom: 'chr1',
            displayName: 'chr1',
            length: 100,
            aliases: { refseq: 'NC_000001.11', genbank: 'CM000663.2', ensembl: '1' },
            manifest: { chrom: 'chr1', fastaPath: 'chr1.fa', faiPath: 'chr1.fa.fai' },
          },
          {
            chrom: 'chr2',
            displayName: 'chr2',
            length: 200,
            manifest: { chrom: 'chr2', fastaPath: 'chr2.fa', faiPath: 'chr2.fa.fai' },
          },
        ],
      },
    } as IndexedGenomeTabState;
    expect(assemblyIdFromIndexedGenome(assemblyGenome)).toBe('grcz12tu');
    expect(assemblyReferencesFromIndexedGenome(assemblyGenome)).toEqual([
      { name: 'chr1', length: 100, aliases: ['NC_000001.11', 'CM000663.2', '1'] },
      { name: 'chr2', length: 200 },
    ]);

    const contigGenome = {
      sourcePath: 'refs/chrIV.fa',
      sourceExt: '.fa',
      chrom: 'chrIV',
      manifest: {
        chrom: 'chrIV',
        fastaPath: 'chrIV.fa',
        faiPath: 'chrIV.fa.fai',
        length: 1_531_933,
      },
    } as IndexedGenomeTabState;
    expect(assemblyIdFromIndexedGenome(contigGenome)).toBe('chrIV');
    expect(assemblyReferencesFromIndexedGenome(contigGenome)).toEqual([
      { name: 'chrIV', length: 1_531_933 },
    ]);
  });
});
