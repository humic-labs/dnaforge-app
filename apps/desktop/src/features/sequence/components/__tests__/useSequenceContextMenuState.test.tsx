/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import type { Annotation } from '@waypoint/sequence-utils';
import { describe, expect, it, vi } from 'vitest';
import { useSequenceContextMenuState } from '../useSequenceContextMenuState';

const cdsAnnotation: Annotation = {
  name: 'lacZ-alpha',
  type: 'CDS',
  start: 2,
  end: 7,
  direction: 1,
};

function triggerEvent(clientX = 10, clientY = 20) {
  return {
    clientX,
    clientY,
    preventDefault: vi.fn(),
  };
}

describe('useSequenceContextMenuState', () => {
  it.each(['canvas', 'webgl'] as const)(
    'gives a %s primer priority over an overlapping CDS and selected bases',
    (surface) => {
      const primer = {
        id: 'primer-1',
        name: 'Modified primer',
        start: 2,
        end: 8,
        direction: 'forward' as const,
        bases: 'ACGTAC',
      };
      const { result } = renderHook(() =>
        useSequenceContextMenuState({
          annotations: [cdsAnnotation],
          sequenceLength: 12,
          primers: [primer],
          highlightedRange: { start: 1, end: 6 },
          setHighlightedRange: vi.fn(),
          setViewCursor: vi.fn(),
          setSelectedAnnotation: vi.fn(),
        })
      );
      act(() => {
        if (surface === 'canvas')
          result.current.handleContextMenu(
            triggerEvent(),
            { start: 1, end: 6 },
            {
              isOnNucleotideRow: false,
              position: 3,
              annotation: cdsAnnotation,
              primer,
            }
          );
        else
          result.current.handleWebglMapContextMenu(new MouseEvent('contextmenu'), {
            position: 3,
            featureIndex: 0,
            orf: null,
            primer,
            hitResult: null,
            highlightRange: [1, 6],
            cutSite: null,
          });
      });
      expect(result.current.contextMenu.primer).toBe(primer);
      expect(result.current.contextMenu.clickedStructureFeature).toBeNull();
      expect(result.current.effectiveStructureFeature).toBeNull();
    }
  );

  it.each(['canvas', 'webgl'] as const)(
    'does not offer a structure for a %s promoter overlapping a CDS',
    (surface) => {
      const promoter: Annotation = { ...cdsAnnotation, name: 'promoter', type: 'promoter' };
      const { result } = renderHook(() =>
        useSequenceContextMenuState({
          annotations: [cdsAnnotation, promoter],
          sequenceLength: 12,
          highlightedRange: { start: 1, end: 6 },
          setHighlightedRange: vi.fn(),
          setViewCursor: vi.fn(),
          setSelectedAnnotation: vi.fn(),
        })
      );
      act(() => {
        if (surface === 'canvas') {
          result.current.handleContextMenu(triggerEvent(), null, {
            isOnNucleotideRow: false,
            position: 3,
            annotation: promoter,
          });
        } else {
          result.current.handleWebglMapContextMenu(new MouseEvent('contextmenu'), {
            position: 3,
            featureIndex: 1,
            orf: null,
            primer: null,
            hitResult: null,
            highlightRange: [1, 6],
            cutSite: null,
          });
        }
      });
      expect(result.current.effectiveStructureFeature).toBeNull();
    }
  );

  it('does not infer a structure from an old selection when right-clicking empty canvas', () => {
    const { result } = renderHook(() =>
      useSequenceContextMenuState({
        annotations: [cdsAnnotation],
        sequenceLength: 12,
        highlightedRange: { start: 1, end: 6 },
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
      })
    );
    act(() => {
      result.current.handleContextMenu(triggerEvent(), null, {
        isOnNucleotideRow: false,
        position: null,
        annotation: null,
      });
    });
    expect(result.current.effectiveStructureFeature).toBeNull();
  });

  it('does not offer the overlapping CDS structure for a WebGL cut site', () => {
    const { result } = renderHook(() =>
      useSequenceContextMenuState({
        annotations: [cdsAnnotation],
        sequenceLength: 12,
        highlightedRange: { start: 1, end: 6 },
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
      })
    );
    act(() => {
      result.current.handleWebglMapContextMenu(new MouseEvent('contextmenu'), {
        position: 3,
        featureIndex: null,
        orf: null,
        primer: null,
        hitResult: { kind: 'cut-site', payload: {} as any },
        highlightRange: [1, 6],
        cutSite: null,
      });
    });
    expect(result.current.effectiveStructureFeature).toBeNull();
  });

  it('opens a biological context menu and derives CDS targets from the clicked position', () => {
    const setHighlightedRange = vi.fn();
    const setViewCursor = vi.fn();
    const setSelectedAnnotation = vi.fn();

    const { result } = renderHook(() =>
      useSequenceContextMenuState({
        annotations: [cdsAnnotation],
        sequenceLength: 12,
        highlightedRange: null,
        setHighlightedRange,
        setViewCursor,
        setSelectedAnnotation,
      })
    );

    act(() => {
      result.current.handleContextMenu(triggerEvent(30, 40), null, {
        isOnNucleotideRow: true,
        position: 3,
        annotation: null,
      });
    });

    expect(result.current.contextMenu).toMatchObject({
      x: 30,
      y: 40,
      isOpen: true,
      isOnNucleotideRow: true,
      position: 3,
      clickedCDS: cdsAnnotation,
    });
    expect(result.current.effectiveCDS).toBe(cdsAnnotation);
    expect(setHighlightedRange).not.toHaveBeenCalled();
  });

  it('offers the parent coding feature when right-clicking its translated amino acid', () => {
    const { result } = renderHook(() =>
      useSequenceContextMenuState({
        annotations: [cdsAnnotation],
        sequenceLength: 12,
        highlightedRange: null,
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
      })
    );
    act(() => {
      result.current.handleContextMenu(triggerEvent(), null, {
        isOnNucleotideRow: false,
        position: 3,
        annotation: null,
        translatedCDS: cdsAnnotation,
      });
    });
    expect(result.current.effectiveStructureFeature).toBe(cdsAnnotation);
  });

  it('captures an assembly part only for the WebGL part that opened the menu', () => {
    const { result } = renderHook(() =>
      useSequenceContextMenuState({
        annotations: [],
        sequenceLength: 300,
        highlightedRange: null,
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
      })
    );
    const part = { regionId: 'promoter', rangeStart: 25, rangeEnd: 110 };

    act(() => {
      result.current.handleWebglMapContextMenu(
        new MouseEvent('contextmenu', { clientX: 30, clientY: 40 }),
        {
          position: 60,
          featureIndex: null,
          orf: null,
          primer: null,
          hitResult: { kind: 'backbone-part', payload: part },
          highlightRange: null,
          cutSite: null,
        }
      );
    });

    expect(result.current.contextMenu.assemblyPart).toEqual(part);

    act(() => {
      result.current.handleWebglMapContextMenu(
        new MouseEvent('contextmenu', { clientX: 50, clientY: 60 }),
        {
          position: 200,
          featureIndex: null,
          orf: null,
          primer: null,
          hitResult: null,
          highlightRange: null,
          cutSite: null,
        }
      );
    });

    expect(result.current.contextMenu.assemblyPart).toBeNull();
  });
});
