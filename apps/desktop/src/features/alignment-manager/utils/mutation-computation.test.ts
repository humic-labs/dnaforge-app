import { describe, expect, it } from 'vitest';
import { classifyMutation } from '@waypoint/sequence-utils';
import type { VerificationTrack } from '../types';
import {
  calculateCoverage,
  computeTrackMutations,
  toMutationEffect,
  getTrackStatus,
  queryInReferenceCoordinates,
  getAlignmentEvidence,
} from './mutation-computation';

describe('clone verification evidence', () => {
  it('reports observed differences even when structural analysis considers them minor', () => {
    expect(getTrackStatus(99.95, 2, { result: 'PASS' })).toBe('variants');
    expect(getTrackStatus(100, 0, { result: 'PASS' })).toBe('pass');
    expect(getTrackStatus(80, 40, { result: 'FAIL' })).toBe('fail');
  });

  it('keeps the first covered base when the alignment begins at reference position one', () => {
    expect(calculateCoverage('ACGT', 'ACGT')).toEqual({ start: 1, end: 4 });
    expect(calculateCoverage('ACGT', '--GT')).toEqual({ start: 3, end: 4 });
  });

  it('looks up codons at reference coordinates after insertions and deletions', () => {
    expect(queryInReferenceCoordinates('A-CGT', 'ATC-T', 'ACGT')).toBe('ACNT');
    expect(() => queryInReferenceCoordinates('CGTA', 'CGTA', 'ACGT')).toThrow(/coordinate order/);
  });

  it('places an origin-spanning partial read on the whole reference without inventing sequence or amino acids', () => {
    const ref = 'TACGTA';
    const query = 'TCCG-A';
    const projected = queryInReferenceCoordinates(ref, query, 'GTACCCCCCTAC', 9);
    expect(projected).toBe('GNANNNNNNTCC');
    expect(calculateCoverage(ref, query, 9, 12)).toEqual({ start: 10, end: 3 });
    expect(getAlignmentEvidence(ref, query, 12)).toMatchObject({
      total: 12,
      unresolved: 6,
      complete: false,
    });
    expect(() => queryInReferenceCoordinates(ref, query, 'GTACCCCCCTAC', 2)).toThrow(
      /coordinate order/
    );
    const track: VerificationTrack = {
      id: 'r',
      queryPath: 'r.ab1',
      label: 'r',
      alignedAt: 'now',
      status: 'incomplete',
      alignment: {
        alignedReference: ref,
        alignedQuery: query,
        coverageStart: 10,
        coverageEnd: 3,
        identity: 80,
        algorithm: 'MAFFT',
        referenceOffset: 9,
        referenceLength: 12,
      },
      mutations: [
        {
          id: 'm1',
          type: 'substitution',
          position: 11,
          length: 1,
          referenceBase: 'A',
          alternateBase: 'C',
        },
        {
          id: 'm2',
          type: 'deletion',
          position: 2,
          length: 1,
          referenceBase: 'T',
          alternateBase: '',
        },
      ],
    };
    expect(computeTrackMutations(track).map((m) => [m.column, m.refPosition])).toEqual([
      [1, 11],
      [4, 2],
    ]);
    const partial = queryInReferenceCoordinates('G', 'A', 'GCTTTT', 0);
    const effect = classifyMutation(
      { position: 1, type: 'substitution', length: 1, ref_base: 'G', query_base: 'A' },
      'GCTTTT',
      partial,
      [{ name: 'coding', type: 'CDS', start: 1, end: 6, direction: 1 }]
    );
    expect(effect.affects_cds).toBe(true);
    expect(toMutationEffect(effect, 'substitution')).toBeUndefined();
  });

  it('keeps complete, missing and ambiguous evidence distinct', () => {
    expect(getAlignmentEvidence('ACGT', 'ACGT')).toMatchObject({ complete: true, unresolved: 0 });
    expect(getAlignmentEvidence('ACGT', '--GT')).toMatchObject({ complete: false, unresolved: 2 });
    expect(getAlignmentEvidence('ACGT', 'ANGT')).toMatchObject({ complete: false, unresolved: 1 });
    expect(getAlignmentEvidence('ANGT', 'ANGT')).toMatchObject({ complete: false, unresolved: 1 });
    expect(getAlignmentEvidence('ACGT', '----')).toMatchObject({ complete: false, unresolved: 4 });
    expect(getAlignmentEvidence('', '')).toMatchObject({ complete: false });
    expect(getAlignmentEvidence('ACGT', 'AC-T')).toMatchObject({ complete: true });
    expect(calculateCoverage('ACGT', '----')).toEqual({ start: 0, end: 0 });
  });

  it('cannot turn incomplete evidence into a pass through structural assessment', () => {
    expect(getTrackStatus(100, 0, { result: 'PASS' }, false)).toBe('incomplete');
  });
});
