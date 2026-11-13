/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isApplePlatform } from '@waypoint/ui-components/keyboard';
import { useSequenceClipboardActions } from '../useSequenceClipboardActions';
import type { SelectionRange } from '../../selection-state';
import { useToastStore } from '../../../../stores/toast-store';

describe('useSequenceClipboardActions', () => {
  const sequenceViewToSource = {
    selection: (selection: SelectionRange) => ({
      start: selection.start + 10,
      end: selection.end + 10,
      wraps: selection.wraps,
    }),
    selectionAsRange: () => ({ start: 101, end: 104 }),
  };

  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('copies only the focused viewer when an older selected tab is still mounted', async () => {
    const onCopyA = vi.fn();
    const onCopyB = vi.fn();
    const input = {
      highlightedRange: { start: 0, end: 2 },
      sequenceLength: 3,
      sequenceViewToSource,
      sequenceViewCopyOrientation: () => 'forward' as const,
      effectiveCDS: null,
      setHighlightedRange: vi.fn(),
    };
    const a = renderHook(
      ({ active }) =>
        useSequenceClipboardActions({
          ...input,
          sequenceText: 'AAA',
          onCopy: onCopyA,
          keyboardActive: active,
        }),
      { initialProps: { active: false } }
    );
    const b = renderHook(
      ({ active }) =>
        useSequenceClipboardActions({
          ...input,
          sequenceText: 'CCC',
          onCopy: onCopyB,
          keyboardActive: active,
        }),
      { initialProps: { active: true } }
    );
    const copy = () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          [isApplePlatform() ? 'metaKey' : 'ctrlKey']: true,
          bubbles: true,
          cancelable: true,
        })
      );
    await act(async () => {
      copy();
    });
    expect(onCopyA).not.toHaveBeenCalled();
    expect(onCopyB).toHaveBeenCalledWith(expect.objectContaining({ sequence: 'CCC' }));
    a.rerender({ active: true });
    b.rerender({ active: false });
    onCopyB.mockClear();
    await act(async () => {
      copy();
    });
    expect(onCopyA).toHaveBeenCalledWith(expect.objectContaining({ sequence: 'AAA' }));
    expect(onCopyB).not.toHaveBeenCalled();
  });

  it('copies real DNA only across scaffold columns', async () => {
    const onCopy = vi.fn();
    const { result } = renderHook(() =>
      useSequenceClipboardActions({
        scaffoldRanges: [{ start: 2, end: 8 }],
        highlightedRange: { start: 0, end: 9 },
        sequenceText: 'AC......GT',
        sequenceLength: 10,
        sequenceViewToSource,
        sequenceViewCopyOrientation: () => 'forward',
        onCopy,
        effectiveCDS: null,
        setHighlightedRange: vi.fn(),
      })
    );
    expect(result.current.selectionLength).toBe(4);
    expect(result.current.getSelectedSequenceText()).toBe('ACGT');
    await act(async () => {
      await result.current.handleCopySequence();
    });
    expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ sequence: 'ACGT' }));
  });

  it('materializes selected DNA and sends source-coordinate copy payloads', async () => {
    const onCopy = vi.fn();
    const setHighlightedRange = vi.fn();
    const { result } = renderHook(() =>
      useSequenceClipboardActions({
        highlightedRange: { start: 1, end: 3 },
        sequenceText: 'AACCGGTT',
        sequenceLength: 8,
        sequenceViewToSource,
        sequenceViewCopyOrientation: (reverseComplementRequested) =>
          reverseComplementRequested ? 'reverse-complement' : 'forward',
        onCopy,
        effectiveCDS: null,
        setHighlightedRange,
      })
    );

    expect(result.current.selectionLength).toBe(3);
    expect(result.current.getSelectedSequenceText()).toBe('ACC');
    expect(result.current.annotationBoundarySelection).toEqual({ start: 12, end: 14 });

    await act(async () => {
      await result.current.handleCopySequence();
    });

    expect(onCopy).toHaveBeenLastCalledWith({
      start: 101,
      end: 104,
      sequence: 'ACC',
      orientation: 'forward',
    });

    await act(async () => {
      await result.current.handleCopyReverseComplement();
    });

    expect(onCopy).toHaveBeenLastCalledWith({
      start: 101,
      end: 104,
      sequence: 'GGT',
      orientation: 'reverse-complement',
    });
  });

  it('fires a "Copied N bp · strand" toast on copy, with base-pair count and orientation', async () => {
    const { result } = renderHook(() =>
      useSequenceClipboardActions({
        highlightedRange: { start: 1, end: 3 },
        sequenceText: 'AACCGGTT',
        sequenceLength: 8,
        sequenceViewToSource,
        sequenceViewCopyOrientation: (reverseComplementRequested) =>
          reverseComplementRequested ? 'reverse-complement' : 'forward',
        onCopy: vi.fn(),
        effectiveCDS: null,
        setHighlightedRange: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.handleCopySequence();
    });
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      type: 'success',
      message: 'Copied 3 bp · forward strand',
    });

    await act(async () => {
      await result.current.handleCopyReverseComplement();
    });
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      type: 'success',
      message: 'Copied 3 bp · reverse complement',
    });
  });

  describe('global Cmd+C listener — must not hijack a real text selection elsewhere', () => {
    function mockNativeSelection(text: string | null) {
      const getSelectionSpy = vi
        .spyOn(window, 'getSelection')
        .mockReturnValue(
          text
            ? ({ isCollapsed: false, toString: () => text } as unknown as Selection)
            : ({ isCollapsed: true, toString: () => '' } as unknown as Selection)
        );
      return getSelectionSpy;
    }

    const commandModifierKey = isApplePlatform() ? 'metaKey' : 'ctrlKey';
    function pressCmdC() {
      const event = new KeyboardEvent('keydown', {
        key: 'c',
        [commandModifierKey]: true,
        bubbles: true,
      });
      document.dispatchEvent(event);
      return event;
    }

    it.each(['input', 'textarea'] as const)(
      'lets a focused %s copy its text while canvas bases remain highlighted',
      async (tag) => {
        mockNativeSelection(null);
        const onCopy = vi.fn();
        renderHook(() =>
          useSequenceClipboardActions({
            highlightedRange: { start: 1, end: 3 },
            sequenceText: 'AACCGGTT',
            sequenceLength: 8,
            sequenceViewToSource,
            sequenceViewCopyOrientation: () => 'forward',
            onCopy,
            effectiveCDS: null,
            setHighlightedRange: vi.fn(),
          })
        );
        const input = document.createElement(tag);
        input.value = 'AC*GT';
        document.body.append(input);
        try {
          input.focus();
          input.setSelectionRange(0, input.value.length);
          const event = new KeyboardEvent('keydown', {
            key: 'c',
            [commandModifierKey]: true,
            bubbles: true,
            cancelable: true,
          });
          await act(async () => input.dispatchEvent(event));
          expect(onCopy).not.toHaveBeenCalled();
          expect(event.defaultPrevented).toBe(false);
          expect(useToastStore.getState().toasts).toHaveLength(0);
        } finally {
          input.remove();
        }
      }
    );

    it('copies the sequence selection when there is no real DOM text selected elsewhere', async () => {
      mockNativeSelection(null);
      const onCopy = vi.fn();
      renderHook(() =>
        useSequenceClipboardActions({
          highlightedRange: { start: 1, end: 3 },
          sequenceText: 'AACCGGTT',
          sequenceLength: 8,
          sequenceViewToSource,
          sequenceViewCopyOrientation: () => 'forward',
          onCopy,
          effectiveCDS: null,
          setHighlightedRange: vi.fn(),
        })
      );

      await act(async () => {
        pressCmdC();
      });
      expect(onCopy).toHaveBeenCalledWith(
        expect.objectContaining({ sequence: 'ACC', orientation: 'forward' })
      );
    });

    it('defers to native copy — does NOT hijack Cmd+C — when real text is selected elsewhere (e.g. a modal)', async () => {
      mockNativeSelection('proteins/mioC-abc12345.faa');
      const onCopy = vi.fn();
      renderHook(() =>
        useSequenceClipboardActions({
          highlightedRange: { start: 1, end: 3 },
          sequenceText: 'AACCGGTT',
          sequenceLength: 8,
          sequenceViewToSource,
          sequenceViewCopyOrientation: () => 'forward',
          onCopy,
          effectiveCDS: null,
          setHighlightedRange: vi.fn(),
        })
      );

      const event = await act(async () => pressCmdC());
      expect(onCopy).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('never touches the underlying sequence selection state either way', async () => {
      mockNativeSelection('some modal text');
      const setHighlightedRange = vi.fn();
      renderHook(() =>
        useSequenceClipboardActions({
          highlightedRange: { start: 1, end: 3 },
          sequenceText: 'AACCGGTT',
          sequenceLength: 8,
          sequenceViewToSource,
          sequenceViewCopyOrientation: () => 'forward',
          onCopy: vi.fn(),
          effectiveCDS: null,
          setHighlightedRange,
        })
      );

      await act(async () => {
        pressCmdC();
      });
      expect(setHighlightedRange).not.toHaveBeenCalled();
    });
  });

  it('inverts selection using the circular sequence selection model', () => {
    const setHighlightedRange = vi.fn();
    const { result } = renderHook(() =>
      useSequenceClipboardActions({
        highlightedRange: { start: 1, end: 3 },
        sequenceText: 'AACCGGTT',
        sequenceLength: 8,
        sequenceViewToSource,
        sequenceViewCopyOrientation: () => 'forward',
        effectiveCDS: null,
        setHighlightedRange,
      })
    );

    act(() => {
      result.current.handleInvertSelection();
    });

    expect(setHighlightedRange).toHaveBeenCalledWith({ start: 4, end: 0, wraps: true });
  });
});
