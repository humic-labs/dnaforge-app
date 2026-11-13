import { describe, expect, it } from 'vitest';

import { dispatchRouteFor, PARSER_DISPATCH_LIMITS } from './parser-dispatch';

const MIB = 1024 * 1024;

describe('dispatchRouteFor', () => {
  it('keeps measured MG1655-scale GenBank files on the legacy route', () => {
    expect(
      dispatchRouteFor({
        sizeBytes: 7_853_962,
        ext: '.gb',
        sampledFeatureCount: 9_924,
      })
    ).toBe('legacy');
  });

  it('routes chromosome-scale GenBank files to the indexed backend by byte size', () => {
    expect(
      dispatchRouteFor({
        sizeBytes: PARSER_DISPATCH_LIMITS.genbankIndexedBytes,
        ext: 'gb',
        sampledFeatureCount: 5_000,
      })
    ).toBe('indexed');
  });

  it('routes dense small GenBank files to the indexed backend by feature count', () => {
    expect(
      dispatchRouteFor({
        sizeBytes: 5 * MIB,
        ext: 'gbk',
        sampledFeatureCount: 50_000,
      })
    ).toBe('indexed');
  });

  it('does not treat raw FASTA size like annotated GenBank size', () => {
    expect(
      dispatchRouteFor({
        sizeBytes: 30 * MIB,
        ext: 'fasta',
        sampledFeatureCount: 0,
      })
    ).toBe('legacy');
  });

  it('routes chromosome-scale FASTA files to indexed range reads', () => {
    expect(
      dispatchRouteFor({
        sizeBytes: PARSER_DISPATCH_LIMITS.fastaIndexedBytes,
        ext: 'fna',
      })
    ).toBe('indexed');
  });

  it('defaults unknown extensions to legacy for backwards compatibility', () => {
    expect(
      dispatchRouteFor({
        sizeBytes: 512 * MIB,
        ext: 'txt',
      })
    ).toBe('legacy');
  });

  it('always routes GFF3 to the indexed backend (DNA-TG1 canonical path)', () => {
    expect(dispatchRouteFor({ sizeBytes: 1024, ext: 'gff3' })).toBe('indexed');
    expect(dispatchRouteFor({ sizeBytes: 1024, ext: 'gff' })).toBe('indexed');
    expect(dispatchRouteFor({ sizeBytes: 10 * MIB, ext: 'gff3' })).toBe('indexed');
  });
});
