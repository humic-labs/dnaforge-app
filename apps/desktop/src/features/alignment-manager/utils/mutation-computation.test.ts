import { describe, expect, it } from 'vitest';
import {
  calculateCoverage,
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
