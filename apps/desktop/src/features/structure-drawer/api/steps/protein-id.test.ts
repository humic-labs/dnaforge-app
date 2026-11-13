// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { classifyProteinId, proteinIdStep } from './protein-id';

describe('classifyProteinId', () => {
  it('classifies RefSeq protein accessions', () => {
    expect(classifyProteinId('NP_414543')).toBe('refseq');
    expect(classifyProteinId('NP_414543.1')).toBe('refseq');
    expect(classifyProteinId('WP_000123456.1')).toBe('refseq');
    expect(classifyProteinId('XP_001234567')).toBe('refseq');
    expect(classifyProteinId('YP_009987654.2')).toBe('refseq');
  });

  it('classifies GenBank-style protein accessions', () => {
    expect(classifyProteinId('AAC73112.1')).toBe('embl');
    expect(classifyProteinId('CAA00001')).toBe('embl');
    expect(classifyProteinId('BAA12345.1')).toBe('embl');
    expect(classifyProteinId('EAA12345')).toBe('embl');
  });

  it('returns null for unrecognized formats', () => {
    expect(classifyProteinId('1TUP')).toBeNull();
    expect(classifyProteinId('P0AD86')).toBeNull();
    expect(classifyProteinId('foo123')).toBeNull();
    expect(classifyProteinId('')).toBeNull();
  });

  it('trims surrounding whitespace before classifying', () => {
    expect(classifyProteinId('  NP_414543.1  ')).toBe('refseq');
  });
});

import {
  callBody,
  sidecarAfdbHit,
  sidecarAfdbMiss,
  sidecarSearchHit,
  sidecarSearchMiss,
} from '../__tests__/sidecar-mocks';

describe('proteinIdStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips when no proteinId hint is present', async () => {
    const result = await proteinIdStep.resolve('M', {}, new AbortController().signal);
    expect(result).toBeNull();
  });

  it('skips when proteinId is unrecognized', async () => {
    const result = await proteinIdStep.resolve(
      'M',
      { proteinId: '1TUP' },
      new AbortController().signal
    );
    expect(result).toBeNull();
  });

  it('queries xref:embl-{id} for GenBank-style protein ids', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarSearchHit('P0AD86'))
      .mockResolvedValueOnce(sidecarAfdbHit('P0AD86', 88.2));

    const result = await proteinIdStep.resolve(
      'M',
      { proteinId: 'AAC73112.1' },
      new AbortController().signal
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(callBody(fetchSpy, 0).query).toContain('xref:embl-AAC73112.1');
    expect(result?.source).toBe('protein_id');
    expect(result?.structure).toMatchObject({ kind: 'uniprot', accession: 'P0AD86' });
  });

  it('queries xref:refseq-{id} for RefSeq-style protein ids', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarSearchHit('P0AD86'))
      .mockResolvedValueOnce(sidecarAfdbHit('P0AD86'));

    await proteinIdStep.resolve('M', { proteinId: 'NP_414543.1' }, new AbortController().signal);

    expect(callBody(fetchSpy, 0).query).toContain('xref:refseq-NP_414543.1');
  });

  it('returns null when UniProt search misses', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarSearchMiss())
      .mockResolvedValueOnce(sidecarSearchMiss());
    const result = await proteinIdStep.resolve(
      'M',
      { proteinId: 'AAC73112.1' },
      new AbortController().signal
    );
    expect(result).toBeNull();
  });

  it('returns null when AFDB has no prediction', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarSearchHit('Q12345'))
      .mockResolvedValueOnce(sidecarAfdbMiss());
    const result = await proteinIdStep.resolve(
      'M',
      { proteinId: 'AAC73112.1' },
      new AbortController().signal
    );
    expect(result).toBeNull();
  });
});
