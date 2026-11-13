/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  projectWebglPrimerPbsBoundary,
  useWebglMapInteractions,
  type WebglMapCrossoverBoundaryCommit,
  type WebglMapCrossoverRange,
  type WebglPrimerPbsLengthCommit,
  type WebglPrimerPbsLengthPreview,
} from '../useWebglMapInteractions';

function renderInteractions(
  onPrimerPbsLengthCommit?: WebglPrimerPbsLengthCommit,
  crossover: {
    range?: WebglMapCrossoverRange | null;
    commit?: WebglMapCrossoverBoundaryCommit;
    circular?: boolean;
    primerPreview?: WebglPrimerPbsLengthPreview;
  } = {}
) {
  const clearSelection = vi.fn();
  const setHighlightedRange = vi.fn();
  const setViewCursor = vi.fn();
  const setSelectedAnnotation = vi.fn();
  const onPositionClick = vi.fn();
  const scrollToBiologicalPosition = vi.fn();
  const previewHighlight = vi.fn();
  const sequenceViewerRef = {
    current: { previewHighlight },
  };

  const hook = renderHook(() =>
    useWebglMapInteractions({
      sequenceViewerRef,
      clearSelection,
      setHighlightedRange,
      setViewCursor,
      setSelectedAnnotation,
      scrollToBiologicalPosition,
      genomeLength: 100,
      circular: crossover.circular ?? false,
      onPositionClick,
      onPrimerPbsLengthPreview: crossover.primerPreview,
      onPrimerPbsLengthCommit,
      mapCrossoverEditRange: crossover.range,
      onMapCrossoverBoundaryCommit: crossover.commit,
    })
  );

  return {
    ...hook,
    clearSelection,
    setHighlightedRange,
    setViewCursor,
    setSelectedAnnotation,
    onPositionClick,
    scrollToBiologicalPosition,
    previewHighlight,
  };
}

describe('useWebglMapInteractions', () => {
  it('advertises primer endpoint editing only when the host grants commit authority', () => {
    const ordinarySequence = renderInteractions();

    expect(ordinarySequence.result.current.handleWebglMapPrimerPbsEndpointPreview).toBeUndefined();
    expect(ordinarySequence.result.current.handleWebglMapPrimerPbsEndpointCommit).toBeUndefined();

    const assemblyDraft = renderInteractions(
      vi.fn((primer) => primer),
      {
        primerPreview: vi.fn(),
      }
    );

    expect(assemblyDraft.result.current.handleWebglMapPrimerPbsEndpointPreview).toBeTypeOf(
      'function'
    );
    expect(assemblyDraft.result.current.handleWebglMapPrimerPbsEndpointCommit).toBeTypeOf(
      'function'
    );
  });

  it.each([
    {
      direction: 'forward' as const,
      primer: {
        id: 'forward',
        start: 92,
        end: 12,
        direction: 'forward' as const,
        overhangLength: 8,
      },
      nextPbsLength: 18,
      expectedBoundary: 18,
    },
    {
      direction: 'reverse' as const,
      primer: {
        id: 'reverse',
        start: 4,
        end: 24,
        direction: 'reverse' as const,
        overhangLength: 8,
      },
      nextPbsLength: 18,
      expectedBoundary: 98,
    },
  ])(
    'keeps a $direction PBS preview in the rendered circular-map coordinate space',
    ({ primer, nextPbsLength, expectedBoundary }) => {
      expect(
        projectWebglPrimerPbsBoundary({
          primer,
          nextPbsLength,
          genomeLength: 100,
          circular: true,
        })
      ).toBe(expectedBoundary);
    }
  );

  it('reports a real map position click separately from cursor projection', () => {
    const { result, onPositionClick, setViewCursor } = renderInteractions();

    act(() => {
      result.current.handleWebglMapPositionClick(42);
    });

    expect(setViewCursor).toHaveBeenCalledWith(42);
    expect(onPositionClick).toHaveBeenCalledWith(42);
  });

  it('routes feature selection and cleared feature selection to the sequence selection model', () => {
    const { result, clearSelection, setHighlightedRange } = renderInteractions();

    act(() => {
      result.current.handleWebglMapFeatureSelect({ start: 4, end: 9 });
    });
    expect(setHighlightedRange).toHaveBeenCalledWith({ start: 4, end: 9 });

    act(() => {
      result.current.handleWebglMapFeatureSelect(null);
    });
    expect(clearSelection).toHaveBeenCalledTimes(1);
  });

  it('maps WebGL primer clicks to cursor, scroll, and inclusive highlight updates', () => {
    const {
      result,
      setViewCursor,
      setSelectedAnnotation,
      scrollToBiologicalPosition,
      setHighlightedRange,
    } = renderInteractions();

    act(() => {
      result.current.handleWebglMapPrimerClick({
        id: 'primer-forward',
        start: 12,
        end: 18,
        direction: 'forward',
      });
    });

    expect(setViewCursor).toHaveBeenCalledWith(12);
    expect(setSelectedAnnotation).toHaveBeenCalledWith(null);
    expect(scrollToBiologicalPosition).toHaveBeenCalledWith(13);
    expect(setHighlightedRange).toHaveBeenCalledWith({ start: 12, end: 17 });
  });

  it('forwards drag preview ranges to the mounted sequence viewer', () => {
    const { result, previewHighlight } = renderInteractions();

    act(() => {
      result.current.handleWebglMapSelectionPreview(2, 5, true);
    });

    expect(previewHighlight).toHaveBeenCalledWith({ start: 2, end: 5, wraps: true });
  });

  it('commits a forward primer PBS edit directly from its rendered endpoint', () => {
    const commit = vi.fn<WebglPrimerPbsLengthCommit>((primer, length) => ({
      ...primer,
      end: primer.start + length,
    }));
    const { result, setHighlightedRange } = renderInteractions(commit);

    act(() => {
      result.current.handleWebglMapPrimerPbsEndpointCommit(
        {
          id: 'primer-forward',
          start: 12,
          end: 32,
          direction: 'forward',
        },
        36
      );
    });

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ id: 'primer-forward' }), 24);
    expect(setHighlightedRange).toHaveBeenLastCalledWith(null);
  });

  it.each([
    {
      direction: 'forward' as const,
      primer: { id: 'primer-forward', start: 12, end: 32, direction: 'forward' as const },
      targetBp: 36,
    },
    {
      direction: 'reverse' as const,
      primer: { id: 'primer-reverse', start: 80, end: 100, direction: 'reverse' as const },
      targetBp: 76,
    },
  ])('projects a held $direction drag through the same PBS-length calculation', (testCase) => {
    const preview = vi.fn<WebglPrimerPbsLengthPreview>();
    const commit = vi.fn<WebglPrimerPbsLengthCommit>((primer) => primer);
    const { result } = renderInteractions(commit, { primerPreview: preview });

    act(() => {
      result.current.handleWebglMapPrimerPbsEndpointPreview(testCase.primer, testCase.targetBp);
    });

    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ id: testCase.primer.id }), 24);
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits a reverse primer PBS edit directly from its rendered endpoint', () => {
    const commit = vi.fn<WebglPrimerPbsLengthCommit>((primer, length) => ({
      ...primer,
      start: primer.end - length,
    }));
    const { result, setHighlightedRange } = renderInteractions(commit);

    act(() => {
      result.current.handleWebglMapPrimerPbsEndpointCommit(
        {
          id: 'primer-reverse',
          start: 80,
          end: 100,
          direction: 'reverse',
        },
        76
      );
    });

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ id: 'primer-reverse' }), 24);
    expect(setHighlightedRange).toHaveBeenLastCalledWith(null);
  });

  it('subtracts a synthetic overhang when a primer glyph wraps the circular origin', () => {
    const commit = vi.fn<WebglPrimerPbsLengthCommit>((primer) => primer);
    const { result } = renderInteractions(commit, { circular: true });

    act(() => {
      result.current.handleWebglMapPrimerPbsEndpointCommit(
        {
          id: 'primer-wrapped-forward',
          start: 92,
          end: 12,
          direction: 'forward',
          overhangLength: 8,
        },
        16
      );
    });

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'primer-wrapped-forward' }),
      16
    );
  });

  it.each([
    {
      direction: 'forward' as const,
      primer: {
        id: 'linear-forward',
        start: 40,
        end: 60,
        direction: 'forward' as const,
        overhangLength: 10,
      },
      targetBp: 35,
    },
    {
      direction: 'reverse' as const,
      primer: {
        id: 'linear-reverse',
        start: 40,
        end: 60,
        direction: 'reverse' as const,
        overhangLength: 10,
      },
      targetBp: 65,
    },
  ])(
    'rejects a $direction primer drag that crosses its fixed endpoint on a linear map',
    (testCase) => {
      const preview = vi.fn<WebglPrimerPbsLengthPreview>();
      const commit = vi.fn<WebglPrimerPbsLengthCommit>();
      const { result } = renderInteractions(commit, { primerPreview: preview });

      act(() => {
        result.current.handleWebglMapPrimerPbsEndpointPreview(testCase.primer, testCase.targetBp);
        result.current.handleWebglMapPrimerPbsEndpointCommit(testCase.primer, testCase.targetBp);
      });

      expect(preview).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    }
  );

  it('keeps ordinary sequence selections out of direct primer mutation', () => {
    const commit = vi.fn<WebglPrimerPbsLengthCommit>();
    const { result, setHighlightedRange } = renderInteractions(commit);
    const primer = {
      id: 'primer-forward',
      start: 12,
      end: 32,
      direction: 'forward' as const,
    };

    act(() => {
      result.current.handleWebglMapPrimerClick(primer);
      result.current.handleWebglMapSelectionChange(8, 31, false);
      result.current.handleWebglMapSelectionStart('new');
      result.current.handleWebglMapSelectionChange(40, 50, false);
    });

    expect(commit).not.toHaveBeenCalled();
    expect(setHighlightedRange).toHaveBeenLastCalledWith({ start: 40, end: 50, wraps: false });
  });

  it('commits selected-part start and end handles as upstream and downstream crossover deltas', () => {
    const range = { regionId: 'part-1', start: 20, end: 60 };
    const commit = vi.fn<WebglMapCrossoverBoundaryCommit>((currentRange, side, deltaBp) => ({
      ...currentRange,
      start: side === 'upstream' ? currentRange.start + deltaBp : currentRange.start,
      end: side === 'downstream' ? currentRange.end + deltaBp : currentRange.end,
    }));
    const { result, setHighlightedRange } = renderInteractions(undefined, { range, commit });

    act(() => {
      result.current.handleWebglMapCrossoverBoundaryCommit(
        {
          regionId: range.regionId,
          side: 'upstream',
          rangeStart: range.start,
          rangeEnd: range.end,
          boundaryBp: range.start,
        },
        16
      );
      result.current.handleWebglMapCrossoverBoundaryCommit(
        {
          regionId: range.regionId,
          side: 'downstream',
          rangeStart: range.start,
          rangeEnd: range.end,
          boundaryBp: range.end,
        },
        64
      );
    });

    expect(commit).toHaveBeenNthCalledWith(1, range, 'upstream', -4);
    expect(commit).toHaveBeenNthCalledWith(2, range, 'downstream', 4);
    expect(setHighlightedRange).not.toHaveBeenCalled();
  });

  it('normalizes crossover deltas across the circular origin', () => {
    const commit = vi.fn<WebglMapCrossoverBoundaryCommit>((range) => range);
    const firstPart = { regionId: 'first', start: 0, end: 30 };
    const first = renderInteractions(undefined, {
      range: firstPart,
      commit,
      circular: true,
    });

    act(() => {
      first.result.current.handleWebglMapCrossoverBoundaryCommit(
        {
          regionId: firstPart.regionId,
          side: 'upstream',
          rangeStart: firstPart.start,
          rangeEnd: firstPart.end,
          boundaryBp: firstPart.start,
        },
        96
      );
    });
    expect(commit).toHaveBeenLastCalledWith(firstPart, 'upstream', -4);

    const lastPart = { regionId: 'last', start: 70, end: 100 };
    const last = renderInteractions(undefined, {
      range: lastPart,
      commit,
      circular: true,
    });
    act(() => {
      last.result.current.handleWebglMapCrossoverBoundaryCommit(
        {
          regionId: lastPart.regionId,
          side: 'downstream',
          rangeStart: lastPart.start,
          rangeEnd: lastPart.end,
          boundaryBp: lastPart.end,
        },
        2
      );
    });
    expect(commit).toHaveBeenLastCalledWith(lastPart, 'downstream', 2);
  });

  it('keeps ordinary selections out of crossover mutation even while a part is armed', () => {
    const commit = vi.fn<WebglMapCrossoverBoundaryCommit>();
    const { result, setHighlightedRange } = renderInteractions(undefined, {
      range: { regionId: 'part-1', start: 20, end: 60 },
      commit,
    });

    act(() => {
      result.current.handleWebglMapSelectionStart('new');
      result.current.handleWebglMapSelectionChange(4, 12, false);
    });

    expect(commit).not.toHaveBeenCalled();
    expect(setHighlightedRange).toHaveBeenCalledWith({ start: 4, end: 12, wraps: false });
  });
});
