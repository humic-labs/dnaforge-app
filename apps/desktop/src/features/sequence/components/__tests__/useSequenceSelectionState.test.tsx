/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectionRange, SelectionState } from '../../selection-state';
import { useSequenceSelectionState } from '../useSequenceSelectionState';
import { observeWorkflowAction } from '../../../../lib/workflow-telemetry';

vi.mock('../../../../lib/workflow-telemetry', () => ({
  observeWorkflowAction: vi.fn(),
}));

function makeProjector() {
  return {
    position: (position: number | null) => (position == null ? null : position + 100),
    selection: (selection: SelectionRange) => ({
      ...selection,
      start: selection.start + 100,
      end: selection.end + 100,
    }),
  };
}

describe('useSequenceSelectionState', () => {
  afterEach(() => {
    delete (window as unknown as { __test?: unknown }).__test;
  });

  it('keeps local selection state but notifies parents in source coordinates', () => {
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onSelectionStateChange = vi.fn();

    const { result } = renderHook(() =>
      useSequenceSelectionState({
        entityId: 'example.gb',
        sequenceViewToSource: makeProjector(),
        minimapRef: { current: null },
        onSelectionChange,
        onCursorChange,
        onSelectionStateChange,
      })
    );

    act(() => {
      result.current.setHighlightedRange({ start: 2, end: 5 });
    });

    expect(result.current.highlightedRange).toEqual({ start: 2, end: 5, wraps: undefined });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 102, end: 105 });
    expect(onSelectionStateChange).toHaveBeenLastCalledWith({
      kind: 'range',
      start: 2,
      end: 5,
      wraps: undefined,
    });

    act(() => {
      result.current.setViewCursor(7);
    });

    expect(result.current.viewCursor).toBe(7);
    expect(onCursorChange).toHaveBeenLastCalledWith(107);
  });

  it('preserves the dev test bridge used by Electron workflow tests', () => {
    (window as unknown as { __test: Record<string, unknown> }).__test = {};

    const { result } = renderHook(() =>
      useSequenceSelectionState({
        entityId: 'bridge.gb',
        sequenceViewToSource: makeProjector(),
        minimapRef: { current: null },
      })
    );

    const bridge = (
      window as unknown as {
        __test: {
          sequenceSelection: Record<
            string,
            {
              getSelection: () => SelectionState;
              setSelection: (selection: SelectionState) => void;
            }
          >;
        };
      }
    ).__test.sequenceSelection['bridge.gb'];

    act(() => {
      bridge.setSelection({ kind: 'cursor', position: 4 });
    });

    expect(result.current.selection).toEqual({ kind: 'cursor', position: 4 });
    expect(bridge.getSelection()).toEqual({ kind: 'cursor', position: 4 });
  });

  it('previews highlighted ranges through the minimap without committing selection', () => {
    const setSelection = vi.fn();
    const { result } = renderHook(() =>
      useSequenceSelectionState({
        sequenceViewToSource: makeProjector(),
        minimapRef: { current: { setSelection } },
      })
    );

    act(() => {
      result.current.handleSequenceHighlightedRangePreview({ start: 1, end: 3, wraps: true });
    });

    expect(setSelection).toHaveBeenCalledWith(1, 3, true);
    expect(result.current.highlightedRange).toBeNull();
    expect(observeWorkflowAction).not.toHaveBeenCalled();
  });

  it('records only a committed non-empty user range selection', () => {
    const { result } = renderHook(() =>
      useSequenceSelectionState({
        sequenceViewToSource: makeProjector(),
        minimapRef: { current: null },
      })
    );

    act(() => {
      result.current.handleSequenceHighlightedRangeChange({ start: 1, end: 3 });
    });
    act(() => {
      result.current.handleSequenceHighlightedRangeChange(null);
    });

    expect(observeWorkflowAction).toHaveBeenCalledTimes(1);
    expect(observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'selection',
      action: 'select',
      status: 'selected',
      selectedCount: 1,
    });
  });
});
