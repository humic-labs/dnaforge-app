// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  extractGenotypeRelationships,
  extractSourceRelationships,
  type ExtractedEdge,
} from './genotype-grammar';

describe('extractGenotypeRelationships', () => {
  it('extracts a bracketed plasmid as carried_by (fromRole other)', () => {
    const edges = extractGenotypeRelationships('MATa his3Δ1 [pRS416]', 'BY4741');
    const plasmid = edges.find((e) => e.type === 'carried_by');
    expect(plasmid).toEqual<ExtractedEdge>({
      type: 'carried_by',
      fromRole: 'other',
      toLookup: { kind: 'plasmid', name: 'pRS416' },
      confidence: 'suggested',
      sourceSpan: '[pRS416]',
    });
  });

  it('extracts vocabulary marker tokens as has_marker (fromRole self)', () => {
    const edges = extractGenotypeRelationships('ura3Δ0::kanMX URA3', 'BY4741');
    const markers = edges.filter((e) => e.type === 'has_marker');
    expect(markers.map((e) => e.toLookup.name).sort()).toEqual(['URA3', 'kanMX']);
    for (const marker of markers) {
      expect(marker.fromRole).toBe('self');
      expect(marker.toLookup.kind).toBe('marker');
      expect(marker.confidence).toBe('suggested');
    }
  });

  it('does NOT treat lowercase auxotrophic mutations as markers (case-sensitive)', () => {
    const edges = extractGenotypeRelationships('MATa his3Δ1 leu2Δ0', 'BY4741');
    expect(edges.filter((e) => e.type === 'has_marker')).toEqual([]);
  });

  it('extracts "<Parent> derivative" lineage as derives_from', () => {
    const edges = extractGenotypeRelationships('BY4741 derivative', 'strainX');
    expect(edges).toContainEqual<ExtractedEdge>({
      type: 'derives_from',
      fromRole: 'self',
      toLookup: { kind: 'strain', name: 'BY4741' },
      confidence: 'suggested',
      sourceSpan: 'BY4741 derivative',
    });
  });

  it('extracts "derived from <Parent>" lineage', () => {
    const edges = extractGenotypeRelationships('derived from W303', 'strainX');
    const edge = edges.find((e) => e.type === 'derives_from');
    expect(edge?.toLookup).toEqual({ kind: 'strain', name: 'W303' });
    expect(edge?.sourceSpan).toBe('derived from W303');
  });

  it('extracts "parent: <Parent>" lineage', () => {
    const edges = extractGenotypeRelationships('parent: S288C', 'strainX');
    const edge = edges.find((e) => e.type === 'derives_from');
    expect(edge?.toLookup).toEqual({ kind: 'strain', name: 'S288C' });
  });

  it('does not emit a self-referential lineage edge', () => {
    const edges = extractGenotypeRelationships('BY4741 derivative', 'BY4741');
    expect(edges.filter((e) => e.type === 'derives_from')).toEqual([]);
  });

  it('composes plasmid + marker + lineage from one genotype string', () => {
    const edges = extractGenotypeRelationships(
      'MATa ura3Δ0::kanMX [pRS416] derived from BY4741',
      'strainX'
    );
    const types = edges.map((e) => e.type).sort();
    expect(types).toEqual(['carried_by', 'derives_from', 'has_marker']);
    expect(edges.every((e) => e.confidence === 'suggested')).toBe(true);
  });

  it('returns [] for empty/whitespace genotype', () => {
    expect(extractGenotypeRelationships('', 'strainX')).toEqual([]);
    expect(extractGenotypeRelationships('   ', 'strainX')).toEqual([]);
  });
});

describe('extractSourceRelationships', () => {
  it('extracts an Addgene accession as associated_with', () => {
    const edges = extractSourceRelationships('Addgene #125028');
    expect(edges).toEqual<ExtractedEdge[]>([
      {
        type: 'associated_with',
        fromRole: 'self',
        toLookup: { kind: 'external_ref', name: 'Addgene #125028' },
        confidence: 'suggested',
        sourceSpan: 'Addgene #125028',
      },
    ]);
  });

  it('splits a vendor+accession source, emitting only the accession edge', () => {
    const edges = extractSourceRelationships('Smith Lab, Addgene #125028');
    expect(edges).toHaveLength(1);
    expect(edges[0].toLookup).toEqual({ kind: 'external_ref', name: 'Addgene #125028' });
    expect(edges[0].sourceSpan).toBe('Addgene #125028');
  });

  it('emits [] for a bare lab name with no accession', () => {
    expect(extractSourceRelationships('Smith Lab')).toEqual([]);
    expect(extractSourceRelationships('gift from a colleague')).toEqual([]);
  });

  it('returns [] for empty/whitespace source', () => {
    expect(extractSourceRelationships('')).toEqual([]);
    expect(extractSourceRelationships('   ')).toEqual([]);
  });
});
