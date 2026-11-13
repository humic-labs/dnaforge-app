// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceEditorHandle } from '@waypoint/workspace-editor';
import { useWebglMapInteractions } from '../useWebglMapInteractions';
import { createSequenceSelectionPreviewStore } from '../sequence-selection-preview';

vi.mock('@waypoint/genome-renderer', () => ({ recordWebGLSelectionDebug: vi.fn() }));

describe('WebGL selection statistics preview', () => {
  it.each([true, false])('publishes the live range with sequence pane mounted=%s', (mounted) => {
    const store = createSequenceSelectionPreviewStore();
    const previewHighlight = vi.fn();
    const editor: WorkspaceEditorHandle = {
      previewHighlight,
      commit: vi.fn(),
      discard: vi.fn(),
      hasPendingChanges: () => false,
      scrollToBiologicalPosition: vi.fn(),
    };
    const setHighlightedRange = vi.fn();
    const { result } = renderHook(() =>
      useWebglMapInteractions({
        sequenceViewerRef: {
          current: mounted ? editor : null,
        },
        clearSelection: vi.fn(),
        setHighlightedRange,
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        scrollToBiologicalPosition: vi.fn(),
        genomeLength: 200,
        circular: true,
        onSelectionPreview: store.set,
      })
    );
    act(() => result.current.handleWebglMapSelectionPreview(190, 9, true));
    expect(store.getSnapshot()).toEqual({ start: 190, end: 9, wraps: true });
    expect(setHighlightedRange).not.toHaveBeenCalled();
    expect(previewHighlight).toHaveBeenCalledTimes(mounted ? 1 : 0);
  });
});
