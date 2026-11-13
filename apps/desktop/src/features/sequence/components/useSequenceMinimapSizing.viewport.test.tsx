// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSequenceMinimapSizing } from './useSequenceMinimapSizing';

describe('alignment pane space during window resize', () => {
  it('caps the displayed map without replacing its saved size', () => {
    const patchSeqView = vi.fn();
    const { result, rerender } = renderHook(
      ({ maxPaneHeight }) =>
        useSequenceMinimapSizing({
          sequenceViewportScopeKey: 'existing-gallery',
          seqView: { minimapHeight: 352, minimapGeometryHeight: 280, webglMorph: 0 },
          patchSeqView,
          maxPaneHeight,
        }),
      { initialProps: { maxPaneHeight: 297 } }
    );
    expect(result.current.minimapHeight).toBe(297);
    expect(result.current.minimapGeometryHeight).toBe(280);
    expect(patchSeqView).not.toHaveBeenCalled();
    rerender({ maxPaneHeight: 404 });
    expect(result.current.minimapHeight).toBe(352);
    expect(patchSeqView).not.toHaveBeenCalled();
  });
});
