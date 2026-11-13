import { describe, it, expect } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import { buildCanvasContentReportCounts } from '../content-report';

function makeFixture(): AnnotatedSequence {
  return {
    id: 'test',
    name: 'test',
    sequence:
      'atgaaaaaaggtgcaagcgaggttttatgtcattcaagaccacgaagacaaaagcgttgaagcaaagaaagctgcggccaatgaagctaaactaaaagcaacagctgaaaaagaaaaaaaaaaa',
    length: 124,
    annotations: [
      {
        name: 'rbcL',
        type: 'gene',
        start: 1,
        end: 120,
        direction: 1,
      },
      {
        name: 'rbcL',
        type: 'CDS',
        start: 1,
        end: 120,
        direction: 1,
        color: '#FF6600',
      },
    ],
    circular: false,
  };
}

describe(' feature-LOD CDS-as-bar fallback', () => {
  it('detail LOD: CDSes are NOT in line.annotations (translation track owns them)', () => {
    const seq = makeFixture();
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
      lodLevel: 'detail' as const,
    };
    const layout = computeSequenceLayoutImpl(seq, config);
    const row0 = layout.lines[0];

    expect(row0.annotations.some((a) => a.type === 'CDS')).toBe(false);
    expect(row0.annotations.some((a) => a.type === 'gene')).toBe(true);
    expect(row0.classifiedCDSs?.some((c) => c.name === 'rbcL')).toBe(true);
  });

  it('feature LOD: CDSes ARE in line.annotations (annotation lane owns them)', () => {
    const seq = makeFixture();
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
      lodLevel: 'feature' as const,
    };
    const layout = computeSequenceLayoutImpl(seq, config);
    const row0 = layout.lines[0];

    const hasCdsInAnnotationLane = row0.annotations.some((a) => a.name.includes('rbcL'));
    expect(hasCdsInAnnotationLane).toBe(true);
  });

  it('feature LOD: gene+CDS at identical coords merge into ONE bar', () => {
    const seq = makeFixture();
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
      lodLevel: 'feature' as const,
    };
    const layout = computeSequenceLayoutImpl(seq, config);
    const row0 = layout.lines[0];

    const matchingRecords = row0.annotations.filter((a) => a.start === 1 && a.end === 120);
    expect(matchingRecords).toHaveLength(1);
  });

  it('feature LOD: merged record uses CDS as canonical (color + type)', () => {
    const seq = makeFixture();
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
      lodLevel: 'feature' as const,
    };
    const layout = computeSequenceLayoutImpl(seq, config);
    const row0 = layout.lines[0];
    const merged = row0.annotations.find((a) => a.start === 1 && a.end === 120);

    expect(merged?.type).toBe('CDS');
    expect(merged?.color).toBe('#FF6600');
    expect(merged?.name).toContain('rbcL');
  });
});

describe('manual annotation draft render ownership', () => {
  function makeDraftFixture(type: 'misc_feature' | 'CDS'): AnnotatedSequence {
    return {
      id: 'draft-preview',
      name: 'draft-preview',
      sequence:
        'atgaaaaaaggtgcaagcgaggttttatgtcattcaagaccacgaagacaaaagcgttgaagcaaagaaagctgcggccaatgaagctaaactaaaagcaacagctgaaaaagaaaaaaaaaaa',
      length: 124,
      annotations: [
        {
          name: 'Draft annotation',
          type,
          start: 1,
          end: 120,
          direction: 1,
          color: '#4E79A7',
          qualifiers: { source: ['annotation-draft'] },
        },
      ],
      circular: false,
    };
  }

  it('regular authored draft stays in the annotation-lane renderer', () => {
    const layout = computeSequenceLayoutImpl(makeDraftFixture('misc_feature'), {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
      lodLevel: 'detail' as const,
    });
    const row0 = layout.lines[0];

    expect(row0.annotations.some((a) => a.name === 'Draft annotation')).toBe(true);
    expect(row0.classifiedCDSs?.some((c) => c.name === 'Draft annotation')).toBe(false);
    expect(row0.translationLaneCount).toBe(0);
    const counts = buildCanvasContentReportCounts(layout);
    expect(counts.totalDraftAnnotations).toBeGreaterThan(0);
    expect(counts.totalDraftCds).toBe(0);
  });

  it('CDS authored draft moves to the translation renderer, not the regular annotation lane', () => {
    const layout = computeSequenceLayoutImpl(makeDraftFixture('CDS'), {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
      lodLevel: 'detail' as const,
    });
    const row0 = layout.lines[0];

    expect(row0.annotations.some((a) => a.name === 'Draft annotation')).toBe(false);
    expect(row0.classifiedCDSs?.some((c) => c.name === 'Draft annotation')).toBe(true);
    expect(row0.translationLaneCount).toBeGreaterThan(0);
    const counts = buildCanvasContentReportCounts(layout);
    expect(counts.totalDraftAnnotations).toBe(0);
    expect(counts.totalDraftCds).toBeGreaterThan(0);
  });
});
