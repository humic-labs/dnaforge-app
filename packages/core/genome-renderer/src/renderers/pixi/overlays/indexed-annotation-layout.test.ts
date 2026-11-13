import { describe, expect, it } from 'vitest';
import type { RenderState } from '../../../types';
import type { UnifiedLayout } from '../shared/track-layout';
import {
  retainedLinearTranscriptLayoutKey,
  type OverlayLayoutHost,
} from './indexed-annotation-layout';

function layoutHost(overrides: Partial<OverlayLayoutHost> = {}): OverlayLayoutHost {
  return {
    _layout: null,
    _contract: null,
    maxAnnotationLane: 0,
    maxCdsLane: 0,
    lastRenderKeyParts: null,
    genomeLength: 1000,
    hashRetainedLinearTranscriptFeatureKey: () => 'hash',
    ...overrides,
  };
}

function renderState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    ...overrides,
  };
}

describe('indexed annotation layout', () => {
  it('encodes a no-layout retained transcript key from viewport height', () => {
    expect(retainedLinearTranscriptLayoutKey(layoutHost(), renderState({ height: 240 }))).toBe(
      'no-layout|h:240'
    );
  });

  it('joins annotation and CDS layout offsets when a layout exists', () => {
    const host = layoutHost({
      _layout: {
        annotationOffset: -42,
        annotationStep: 16,
        cdsBarOffset: -8,
        cdsLaneStep: 12,
      } as UnifiedLayout,
    });
    expect(retainedLinearTranscriptLayoutKey(host, renderState({ height: 320 }))).toBe(
      'h:320|ao:-42|as:16|co:-8|cs:12'
    );
  });
});
