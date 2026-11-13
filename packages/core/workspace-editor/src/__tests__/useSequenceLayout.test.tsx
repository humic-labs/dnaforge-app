/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { DEFAULT_EDITOR_CONFIG, type PrimerDisplay } from '../types';
import { computeSequenceLayoutImpl, useSequenceLayout } from '../useSequenceLayout';
import { captureScreenTracks, morphScreenTracks } from '../screen-track-morph';
import { lineTrackBoundaries } from '../line-track-layout';

const BASE_CONFIG = {
  charsPerLine: 12,
  showAnnotations: true,
  showTranslation: false,
  showReverseComplement: false,
  showPrimers: false,
};

function makeSequence(overrides: Partial<AnnotatedSequence> = {}): AnnotatedSequence {
  const sequence = overrides.sequence ?? 'ACGTACGTACGTACGTACGT';
  return {
    id: 'seq',
    name: 'seq',
    sequence,
    length: sequence.length,
    annotations: [],
    circular: false,
    ...overrides,
  };
}

function makeAnnotation(overrides: Partial<Annotation>): Annotation {
  return {
    name: 'feature',
    type: 'misc_feature',
    start: 1,
    end: 3,
    direction: 1,
    ...overrides,
  };
}

function makePrimer(overrides: Partial<PrimerDisplay> = {}): PrimerDisplay {
  return {
    id: 'primer-a',
    name: 'Primer A',
    start: 2,
    end: 14,
    direction: 'forward',
    bases: 'ACGTACGTACGT',
    tm: 60,
    gc: 50,
    ...overrides,
  };
}

describe('useSequenceLayout annotation interval index', () => {
  it.each([false, true])(
    'retains identical row geometry during fractional resize, circular=%s',
    (circular) => {
      const sequence = makeSequence({
        sequence: 'ACGT'.repeat(36),
        circular,
        annotations: [makeAnnotation({ start: 9, end: 44 })],
      });
      const config = {
        ...DEFAULT_EDITOR_CONFIG,
        ...BASE_CONFIG,
        showReverseComplement: true,
        wrapTrackForecast: false,
      };
      const rows = circular ? 2 : 0;
      const { result, rerender } = renderHook(
        ({ capacity, cpr }) =>
          useSequenceLayout(
            sequence,
            { ...config, wrapCapacity: capacity, charsPerLine: cpr },
            0,
            rows
          ),
        { initialProps: { capacity: 12.25, cpr: 12 } }
      );
      const original = result.current.snapshot;
      expect(
        computeSequenceLayoutImpl(sequence, { ...config, wrapCapacity: 12.75 }, 0, rows)
      ).toEqual(original);
      rerender({ capacity: 12.75, cpr: 12 });
      expect(result.current.snapshot).toBe(original);
      rerender({ capacity: 13.25, cpr: 13 });
      expect(result.current.snapshot).not.toBe(original);
      expect(result.current.snapshot).toEqual(
        computeSequenceLayoutImpl(
          sequence,
          { ...config, wrapCapacity: 13.25, charsPerLine: 13 },
          0,
          rows
        )
      );
    }
  );

  it.each([
    { wrapTrackForecast: true },
    { wrapTrackForecast: false, wrapAnchorBp: 7, wrapAnchorViewportX: 84 },
  ])('retains fractional width invalidation for active wrap geometry: %o', (wrap) => {
    const sequence = makeSequence({ sequence: 'ACGT'.repeat(36), circular: true });
    const config = { ...DEFAULT_EDITOR_CONFIG, ...BASE_CONFIG, ...wrap };
    const { result, rerender } = renderHook(
      ({ capacity }) => useSequenceLayout(sequence, { ...config, wrapCapacity: capacity }, 0, 2),
      { initialProps: { capacity: 12.25 } }
    );
    const original = result.current.snapshot;
    rerender({ capacity: 12.75 });
    expect(result.current.snapshot).not.toBe(original);
    expect(result.current.snapshot).toEqual(
      computeSequenceLayoutImpl(sequence, { ...config, wrapCapacity: 12.75 }, 0, 2)
    );
  });

  it('releases cached large-genome forecast bands on the vertical deadline while keeping the wrap anchor', () => {
    const sequence = makeSequence({
      sequence: 'ACGT'.repeat(25_001),
      annotations: Array.from({ length: 4 }, (_, lane) =>
        makeAnnotation({
          name: `lane-${lane}`,
          start: lane === 0 ? 95 : 100 + lane,
          end: 150 - lane,
        })
      ),
    });
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      ...BASE_CONFIG,
      charsPerLine: 100,
      wrapCapacity: 100,
      wrapPreviewTargetCpr: 120,
      wrapAnchorBp: 43,
      wrapAnchorViewportX: DEFAULT_EDITOR_CONFIG.marginLeft + 43 * DEFAULT_EDITOR_CONFIG.charWidth,
    };
    const range = { firstRowIndex: 0, lastRowIndex: 10, emitOnlyViewportLines: true };
    const { result, rerender } = renderHook(
      ({ forecast }) =>
        useSequenceLayout(
          sequence,
          { ...config, wrapTrackForecast: forecast },
          0,
          0,
          undefined,
          false,
          undefined,
          0,
          range
        ),
      { initialProps: { forecast: true } }
    );
    const reserved = result.current.snapshot;
    expect(reserved.lines[0].trackMorph!.painted[1]).toBeGreaterThan(
      reserved.lines[0].trackMorph!.natural[1]
    );
    rerender({ forecast: false });
    const released = result.current.snapshot;
    expect(released).not.toBe(reserved);
    expect(released.lines[0].xOffset).toBe(reserved.lines[0].xOffset);
    expect(released.lines[0].startPos).toBe(reserved.lines[0].startPos);
    let frame = captureScreenTracks(reserved, config, 43, 0);
    for (const time of [0, 8, 16, 24, 32, 40, 48, 56]) {
      const resize = morphScreenTracks(released, config, frame, 43, time);
      frame = resize.frame;
      if (time === 40) {
        expect(resize.pending).toBe(true);
      }

      if (time === 48 || time === 56) {
        expect(resize.pending).toBe(false);
        expect(frame.bands.get(0)).toEqual(lineTrackBoundaries(released.lines[0], config));
        expect(resize.layout.summary!.rowHeights[0]).toBe(released.lines[0].naturalHeight);
      }
    }
    rerender({ forecast: true });
    expect(result.current.snapshot).toBe(reserved);
  });

  it('reuses an exact large-genome viewport layout across remounts and invalidates changed annotations', () => {
    const sequence = makeSequence({ sequence: 'ACGT'.repeat(25_001) });
    const config = { ...BASE_CONFIG, charsPerLine: 1000 };
    const primers: PrimerDisplay[] = [];
    const orfs: [] = [];
    const range = { firstRowIndex: 0, lastRowIndex: 10 };
    const useLayoutForTest = () =>
      useSequenceLayout(sequence, config, 0, 0, primers, false, orfs, 0, range);

    const first = renderHook(useLayoutForTest);
    const firstSnapshot = first.result.current.snapshot;
    first.unmount();
    const reopened = renderHook(useLayoutForTest);
    expect(reopened.result.current.snapshot).toBe(firstSnapshot);
    reopened.unmount();

    sequence.annotations = [makeAnnotation({ name: 'new feature', start: 1, end: 10 })];
    const changed = renderHook(useLayoutForTest);
    expect(changed.result.current.snapshot).not.toBe(firstSnapshot);
    expect(changed.result.current.snapshot.lines[0].annotations[0]?.name).toBe('new feature');
    changed.unmount();
  });
  it('lays out exposed digest strands while keeping the original sequence unchanged', () => {
    const sequence = makeSequence({
      sequence: 'AAAA....CCCC',
      strandOverrides: [{ start: 4, reverse: 'ATAC' }],
    });
    const { result, rerender } = renderHook(
      ({ seq }) => useSequenceLayout(seq, { ...BASE_CONFIG, showReverseComplement: true }),
      { initialProps: { seq: sequence } }
    );
    expect(result.current.snapshot.lines[0].sequence).toBe('AAAA....CCCC');
    expect(result.current.snapshot.lines[0].complementSequence).toBe('TTTTATACGGGG');
    const firstSnapshot = result.current.snapshot;
    rerender({
      seq: {
        ...sequence,
        strandOverrides: sequence.strandOverrides?.map((entry) => ({ ...entry })),
      },
    });
    expect(result.current.snapshot).toBe(firstSnapshot);
    rerender({
      seq: {
        ...sequence,
        strandOverrides: [{ start: 4, forward: 'C'.repeat(4), reverse: 'G'.repeat(4) }],
      },
    });
    expect(result.current.snapshot.lines[0].sequence.slice(4, 8)).toBe('C'.repeat(4));
    expect(result.current.snapshot.lines[0].complementSequence?.slice(4, 8)).toBe('G'.repeat(4));
    rerender({ seq: { ...sequence, strandOverrides: [] } });
    expect(result.current.snapshot.lines[0].complementSequence).toBe('TTTT....GGGG');
    expect(sequence.sequence).toBe('AAAA....CCCC');
  });
  it('uses the canonical IUPAC complement for emitted sequence rows', () => {
    const sequence = makeSequence({ sequence: 'ARYKMBVDHNarykmbvdhn' });

    const { result } = renderHook(() =>
      useSequenceLayout(sequence, { ...BASE_CONFIG, charsPerLine: sequence.length })
    );

    expect(result.current.snapshot.lines[0]?.complementSequence).toBe('TYRMKVBHDNtyrmkvbhdn');
  });

  it('complements an RNA record with U and follows a molecule change ', () => {
    const rna = makeSequence({ sequence: 'AUGGCAagcu', molecule: 'mRNA' });
    const config = { ...BASE_CONFIG, showReverseComplement: true, charsPerLine: 10 };
    const rnaLayout = renderHook(() => useSequenceLayout(rna, config));
    expect(rnaLayout.result.current.snapshot.lines[0]?.complementSequence).toBe('UACCGUucga');

    const dna = makeSequence({ sequence: 'AAGGCCaagg', molecule: 'DNA' });
    const { result, rerender } = renderHook(({ seq }) => useSequenceLayout(seq, config), {
      initialProps: { seq: dna },
    });
    expect(result.current.snapshot.lines[0]?.complementSequence).toBe('TTCCGGttcc');
    rerender({ seq: { ...dna, molecule: 'RNA' } });
    expect(result.current.snapshot.lines[0]?.complementSequence).toBe('UUCCGGuucc');
  });

  it('materializes circular complement letters only when nucleotide text is visible', () => {
    const sequence = makeSequence({
      sequence: 'ARYKMBVDHNarykmbvdhn',
      circular: true,
      strandOverrides: [{ start: 19, reverse: 'Z' }],
    });
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      ...BASE_CONFIG,
      showReverseComplement: true,
      charsPerLine: sequence.sequence.length,
    };
    const feature = computeSequenceLayoutImpl(sequence, { ...config, lodLevel: 'feature' }, 17);
    expect(feature.lines[0]?.sequence).toHaveLength(sequence.sequence.length);
    expect(feature.lines[0]?.complementSequence).toBe('');

    const detail = computeSequenceLayoutImpl(sequence, { ...config, lodLevel: 'detail' }, 17);
    expect(detail.lines[0]?.complementSequence).toBe('hdZTYRMKVBHDNtyrmkvb');
  });

  it('renders CDS annotations in feature-level annotation lanes', () => {
    const sequence = makeSequence({
      sequence: 'ATG'.repeat(20),
      annotations: [
        makeAnnotation({ name: 'gene-a', type: 'gene', start: 1, end: 18, direction: 1 }),
        makeAnnotation({ name: 'cds-a', type: 'CDS', start: 7, end: 36, direction: 1 }),
      ],
    });

    const { result } = renderHook(() =>
      useSequenceLayout(sequence, { ...BASE_CONFIG, lodLevel: 'feature' })
    );
    const cdsLine = result.current.snapshot.lines.find((line) =>
      line.annotations.some((ann) => ann.name === 'cds-a')
    );

    expect(cdsLine).toBeDefined();
    expect(cdsLine?.annotations.some((ann) => ann.type === 'CDS')).toBe(true);
    expect(cdsLine?.annotationLaneCount).toBeGreaterThan(0);
    expect(cdsLine?.translationLaneCount).toBe(0);
  });

  it('keeps CDS annotations in translation lanes at detail LOD', () => {
    const sequence = makeSequence({
      sequence: 'ATG'.repeat(20),
      annotations: [
        makeAnnotation({ name: 'gene-a', type: 'gene', start: 1, end: 18, direction: 1 }),
        makeAnnotation({ name: 'cds-a', type: 'CDS', start: 7, end: 36, direction: 1 }),
      ],
    });

    const { result } = renderHook(() =>
      useSequenceLayout(sequence, { ...BASE_CONFIG, showTranslation: true, lodLevel: 'detail' })
    );
    const cdsLine = result.current.snapshot.lines.find((line) =>
      line.classifiedCDSs?.some((cds) => cds.name === 'cds-a')
    );

    expect(cdsLine).toBeDefined();
    expect(cdsLine?.annotations.some((ann) => ann.name === 'cds-a')).toBe(false);
    expect(cdsLine?.translationLaneCount).toBeGreaterThan(0);
  });

  it('reserves primer tracks at feature LOD when primers are enabled', () => {
    const sequence = makeSequence({ sequence: 'ACGT'.repeat(20) });
    const primer = makePrimer();

    const withoutPrimers = renderHook(() =>
      useSequenceLayout(sequence, { ...BASE_CONFIG, lodLevel: 'feature' })
    );
    const withPrimers = renderHook(() =>
      useSequenceLayout(
        sequence,
        { ...BASE_CONFIG, showPrimers: true, lodLevel: 'feature' },
        0,
        0,
        [primer]
      )
    );

    expect(withPrimers.result.current.snapshot.totalHeight).toBeGreaterThan(
      withoutPrimers.result.current.snapshot.totalHeight
    );
  });

  it('keeps distinct origin-spanning annotations with identical names and bounds', () => {
    const sequence = makeSequence({
      circular: true,
      annotations: [
        makeAnnotation({ name: 'ori-wrap', start: 18, end: 3, direction: 1 }),
        makeAnnotation({ name: 'ori-wrap', start: 18, end: 3, direction: -1 }),
      ],
    });

    const { result } = renderHook(() => useSequenceLayout(sequence, BASE_CONFIG, 15));
    const wrapLine = result.current.snapshot.lines.find((line) => line.startPos === 15);

    expect(wrapLine).toBeDefined();
    expect(wrapLine?.annotations).toHaveLength(2);
    expect(wrapLine?.annotations.map((ann) => ann.direction).sort()).toEqual([-1, 1]);
  });

  it('recomputes when annotation positions change without changing annotation count', () => {
    const config = { ...BASE_CONFIG, charsPerLine: 8 };
    const initial = makeSequence({
      annotations: [makeAnnotation({ name: 'before', start: 1, end: 3 })],
    });
    const updated = makeSequence({
      annotations: [makeAnnotation({ name: 'after', start: 10, end: 12 })],
    });

    const { result, rerender } = renderHook(({ seq }) => useSequenceLayout(seq, config), {
      initialProps: { seq: initial },
    });

    expect(
      result.current.snapshot.lines.flatMap((line) => line.annotations.map((ann) => ann.name))
    ).toEqual(['before']);

    rerender({ seq: updated });

    expect(
      result.current.snapshot.lines.flatMap((line) => line.annotations.map((ann) => ann.name))
    ).toEqual(['after']);
  });

  it('recomputes when pLannotate draft acceptance changes without moving the annotation', () => {
    const config = { ...BASE_CONFIG, charsPerLine: 8 };
    const draft = (status: 'accepted' | 'rejected') =>
      makeAnnotation({
        name: 'draft-feature',
        type: 'misc_feature',
        start: 1,
        end: 3,
        color: '#06b6d4',
        qualifiers: { source: 'pLannotate-draft', status },
      });
    const initial = makeSequence({ annotations: [draft('rejected')] });
    const updated = makeSequence({ annotations: [draft('accepted')] });

    const { result, rerender } = renderHook(({ seq }) => useSequenceLayout(seq, config), {
      initialProps: { seq: initial },
    });

    expect(result.current.snapshot.lines[0]?.annotations[0]?.qualifiers?.status).toBe('rejected');

    rerender({ seq: updated });

    expect(result.current.snapshot.lines[0]?.annotations[0]?.qualifiers?.status).toBe('accepted');
  });

  it('recomputes when an annotation draft changes type from regular to CDS', () => {
    const config = {
      ...BASE_CONFIG,
      charsPerLine: 12,
      showTranslation: true,
      lodLevel: 'detail' as const,
    };
    const sequenceText = 'ATG'.repeat(20);
    const draft = (type: 'misc_feature' | 'CDS') =>
      makeAnnotation({
        name: 'draft-feature',
        type,
        start: 1,
        end: 36,
        direction: 1,
        color: '#4E79A7',
        qualifiers: { source: ['annotation-draft'] },
      });
    const initial = makeSequence({ sequence: sequenceText, annotations: [draft('misc_feature')] });
    const updated = makeSequence({ sequence: sequenceText, annotations: [draft('CDS')] });

    const { result, rerender } = renderHook(({ seq }) => useSequenceLayout(seq, config), {
      initialProps: { seq: initial },
    });

    expect(
      result.current.snapshot.lines.some((line) =>
        line.annotations.some((ann) => ann.name === 'draft-feature')
      )
    ).toBe(true);
    expect(
      result.current.snapshot.lines.some((line) =>
        line.classifiedCDSs?.some((cds) => cds.name === 'draft-feature')
      )
    ).toBe(false);

    rerender({ seq: updated });

    expect(
      result.current.snapshot.lines.some((line) =>
        line.annotations.some((ann) => ann.name === 'draft-feature')
      )
    ).toBe(false);
    expect(
      result.current.snapshot.lines.some((line) =>
        line.classifiedCDSs?.some((cds) => cds.name === 'draft-feature')
      )
    ).toBe(true);
  });
});
