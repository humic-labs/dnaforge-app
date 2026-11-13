import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import { codonCarrierRange, translateCodonCarrier } from './codon-carrier-translation';

describe('composite CDS translation and intron ownership', () => {
  it('reads every repeated translation exception from the canonical qualifier values', () => {
    const feature: Feature = {
      id: 1,
      type: 'CDS',
      start: 0,
      end: 12,
      direction: 'forward',
      displayName: 'recoded',
      color: 0x3399cc,
      lane: 0,
      qualifiers: { transl_except: '(pos:4..6,aa:Pyl)' },
      qualifierValues: { transl_except: ['(pos:4..6,aa:Pyl)', '(pos:7..9,aa:Sec)'] },
    };
    const dna = 'ATGTAGTGATAA';
    const result = translateCodonCarrier(
      feature,
      codonCarrierRange(feature)!,
      (position) => dna[position],
      { length: dna.length, circular: false }
    );
    expect(result.codons.map((codon) => codon.aa).join('')).toBe('MOU*');
  });
  it('keeps the original reading substrate while retiring the duplicate legacy intron presenter', () => {
    const parts = [
      { start: 1, end: 3 },
      { start: 8, end: 10 },
    ];
    const feature: Feature = {
      id: 1,
      type: 'CDS',
      start: 0,
      end: 10,
      direction: 'forward',
      displayName: 'joined CDS',
      color: 0x3399cc,
      lane: 0,
      segments: parts,
      qualifiers: { _locationString: 'join(1..3,8..10)' },
    };
    const composite = {
      ...feature,
      exons: parts,
      cds: parts,
      compositeKind: 'compound-cds' as const,
    };
    const bare = codonCarrierRange(feature)!;
    const resolved = codonCarrierRange(composite)!;
    expect(bare.legacy).toBe(true);
    expect(codonCarrierRange({ ...feature, exons: parts })?.legacy).toBe(true);
    expect(resolved.legacy).toBe(false);
    expect(resolved.segments).toBe(parts);
    const reader = (position: number) => 'ATGAAAAAAA'[position] ?? 'N';
    const genome = { length: 10, circular: false };
    expect(translateCodonCarrier(composite, resolved, reader, genome)).toEqual(
      translateCodonCarrier(feature, bare, reader, genome)
    );
  });
});
