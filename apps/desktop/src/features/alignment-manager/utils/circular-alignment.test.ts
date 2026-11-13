import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentApiResponse } from './alignment-api';

const callAlignmentApiMock =
  vi.fn<(query: string, reference: string, timeoutMs?: number) => Promise<AlignmentApiResponse>>();

vi.mock('./alignment-api', () => ({
  callAlignmentApi: (query: string, reference: string, timeoutMs?: number) =>
    callAlignmentApiMock(query, reference, timeoutMs),
}));

import { callPairwiseCircularAware, CircularAlignmentMismatchError } from './circular-alignment';

function fakeApiResponse(
  alignedQuery: string,
  alignedReference: string,
  identity = 100
): AlignmentApiResponse {
  if (alignedQuery.length !== alignedReference.length) {
    throw new Error('test fixture: aligned strings must have equal length');
  }
  return {
    aligned_query: alignedQuery,
    aligned_reference: alignedReference,
    identity,
    mutations: [],
    alignment_length: alignedQuery.length,
  };
}

describe('callPairwiseCircularAware', () => {
  beforeEach(() => {
    callAlignmentApiMock.mockReset();
  });

  it('linear ref, non-wrapping match → passes through with refStart/refEnd in canonical space', async () => {
    const reference = 'TTTACGTAATTT';
    const query = 'ACGTAA';

    callAlignmentApiMock.mockResolvedValueOnce(fakeApiResponse('ACGTAA', 'ACGTAA', 100));

    const result = await callPairwiseCircularAware({
      query,
      reference,
      isCircular: false,
    });

    expect(callAlignmentApiMock).toHaveBeenCalledTimes(1);
    expect(callAlignmentApiMock.mock.calls[0][0]).toBe(query);
    expect(callAlignmentApiMock.mock.calls[0][1]).toBe(reference);

    expect(result.wraps).toBe(false);
    expect(result.refStart).toBe(3);
    expect(result.refEnd).toBe(9);
    expect(result.aligned_query).toBe('ACGTAA');
    expect(result.aligned_reference).toBe('ACGTAA');
    expect(result.identity).toBe(100);
  });

  it('circular ref, non-wrapping match → aligns against doubled ref but reports canonical [0, L) position', async () => {
    const reference = 'TTTACGTAATTT';
    const query = 'ACGTAA';
    const L = reference.length;

    callAlignmentApiMock.mockResolvedValueOnce(fakeApiResponse('ACGTAA', 'ACGTAA', 100));

    const result = await callPairwiseCircularAware({
      query,
      reference,
      isCircular: true,
    });

    expect(callAlignmentApiMock).toHaveBeenCalledTimes(1);
    expect(callAlignmentApiMock.mock.calls[0][1]).toBe(reference + reference);

    expect(result.wraps).toBe(false);
    expect(result.refStart).toBe(3);
    expect(result.refEnd).toBe(9);
    expect(result.refEnd).toBeLessThanOrEqual(L);
  });

  it('circular ref, origin-spanning match → wraps=true, refEnd > L, refStart in [0, L)', async () => {
    const reference = 'AAACGTAACC';
    const query = 'ACCAAA';
    const L = reference.length;

    callAlignmentApiMock.mockResolvedValueOnce(fakeApiResponse('ACCAAA', 'ACCAAA', 100));

    const result = await callPairwiseCircularAware({
      query,
      reference,
      isCircular: true,
    });

    expect(callAlignmentApiMock.mock.calls[0][1]).toBe(reference + reference);
    expect(result.wraps).toBe(true);
    expect(result.refStart).toBe(7);
    expect(result.refEnd).toBe(L + 3);
    expect(result.refEnd - L).toBe(3);
  });

  it('circular ref with TWO non-overlapping match locations → reports the higher-identity match position', async () => {
    const reference = 'TTTACGTAACGTTTACGTGGCGTT';
    const query = 'ACGTAACG';
    const L = reference.length;

    callAlignmentApiMock.mockResolvedValueOnce(fakeApiResponse('ACGTAACG', 'ACGTAACG', 100));

    const result = await callPairwiseCircularAware({
      query,
      reference,
      isCircular: true,
    });

    expect(callAlignmentApiMock.mock.calls[0][1]).toBe(reference + reference);
    expect(result.wraps).toBe(false);
    expect(result.refStart).toBe(3);
    expect(result.refEnd).toBe(11);
    expect(result.refEnd).toBeLessThanOrEqual(L);
    expect(result.identity).toBe(100);
  });

  it('circular ref, MAFFT pads aligned_reference past L but read coverage stays in [0, L) → wraps=false', async () => {
    const reference = 'AAGGGCCCTTTT';
    const L = reference.length;
    const alignedReference = 'AAGGGCCCTTTTAAGGGCCCTTTT';
    const alignedQuery = '--GGGCCC----------------';
    expect(alignedQuery.length).toBe(alignedReference.length);

    callAlignmentApiMock.mockResolvedValueOnce(
      fakeApiResponse(alignedQuery, alignedReference, 100)
    );

    const result = await callPairwiseCircularAware({
      query: 'GGGCCC',
      reference,
      isCircular: true,
    });

    expect(result.refStart).toBe(0);
    expect(result.refEnd).toBe(24);
    expect(result.refEnd).toBeGreaterThan(L);
    expect(result.wraps).toBe(false);
  });

  it('throws CircularAlignmentMismatchError when aligned_reference is empty (linear)', async () => {
    callAlignmentApiMock.mockResolvedValueOnce(fakeApiResponse('', '', 0));
    await expect(
      callPairwiseCircularAware({
        query: 'ACGT',
        reference: 'TTTACGTAATTT',
        isCircular: false,
      })
    ).rejects.toBeInstanceOf(CircularAlignmentMismatchError);
  });

  it('throws CircularAlignmentMismatchError when aligned_reference is not a substring of the reference', async () => {
    callAlignmentApiMock.mockResolvedValueOnce(fakeApiResponse('GGGGGG', 'GGGGGG', 100));
    await expect(
      callPairwiseCircularAware({
        query: 'ACGTAA',
        reference: 'TTTACGTAATTT',
        isCircular: true,
      })
    ).rejects.toBeInstanceOf(CircularAlignmentMismatchError);
  });

  it('circular ref, full-ref-length query → returns canonical [0, L) without duplicate-copy match', async () => {
    const reference = 'AAACGTAACC';
    const query = 'AAACGTAACC';
    const L = reference.length;

    callAlignmentApiMock.mockResolvedValueOnce(fakeApiResponse('AAACGTAACC', 'AAACGTAACC', 100));

    const result = await callPairwiseCircularAware({
      query,
      reference,
      isCircular: true,
    });

    expect(callAlignmentApiMock.mock.calls[0][1]).toBe(reference + reference);
    expect(result.wraps).toBe(false);
    expect(result.refStart).toBe(0);
    expect(result.refEnd).toBe(L);
    expect(result.identity).toBe(100);
  });
});
