import { describe, expect, it, vi } from 'vitest';

import { createSearchBuildPairingV1 } from './assembly-search-build-pairing';

const request = { assemblyId: 'a', chromosomes: [{ chrom: 'c', length: 1 }] };
const annotationJob = { request } as never;
const proteinJob = { request } as never;
const annotationResult = { status: 'committed', featureCount: 1, byteCount: 1 } as never;
const proteinResult = { status: 'committed', featureCount: 2, byteCount: 2 } as never;

function runners() {
  return {
    annotation: vi.fn(async () => annotationResult),
    protein: vi.fn(async () => proteinResult),
    both: vi.fn(async () => ({
      annotation: { value: annotationResult },
      protein: { value: proteinResult },
    })),
  };
}

describe('search build pairing', () => {
  it('builds both indexes in one run once both sides submit', async () => {
    const run = runners();
    const pairing = createSearchBuildPairingV1(run);
    const annotation = pairing.annotation(annotationJob);
    expect(run.both).not.toHaveBeenCalled();
    const protein = pairing.protein(proteinJob);
    await expect(annotation).resolves.toBe(annotationResult);
    await expect(protein).resolves.toBe(proteinResult);
    expect(run.both).toHaveBeenCalledTimes(1);
    expect(run.annotation).not.toHaveBeenCalled();
    expect(run.protein).not.toHaveBeenCalled();
  });

  it('builds one side alone when the other side releases without building', async () => {
    const run = runners();
    const pairing = createSearchBuildPairingV1(run);
    const protein = pairing.protein(proteinJob);
    pairing.release('annotation');
    await expect(protein).resolves.toBe(proteinResult);
    expect(run.protein).toHaveBeenCalledTimes(1);
    expect(run.both).not.toHaveBeenCalled();
  });

  it('keeps each side’s failure to itself', async () => {
    const run = runners();
    run.both.mockResolvedValue({
      annotation: { value: annotationResult },
      protein: { error: { name: 'Error', message: 'protein failed' } },
    } as never);
    const pairing = createSearchBuildPairingV1(run);
    const annotation = pairing.annotation(annotationJob);
    const protein = pairing.protein(proteinJob);
    await expect(annotation).resolves.toBe(annotationResult);
    await expect(protein).rejects.toThrow('protein failed');
  });

  it('builds separately when the two jobs plan different chromosomes', async () => {
    const run = runners();
    const pairing = createSearchBuildPairingV1(run);
    const annotation = pairing.annotation(annotationJob);
    const protein = pairing.protein({ request: { ...request, assemblyId: 'b' } } as never);
    await Promise.all([annotation, protein]);
    expect(run.both).not.toHaveBeenCalled();
    expect(run.annotation).toHaveBeenCalledTimes(1);
    expect(run.protein).toHaveBeenCalledTimes(1);
  });
});
