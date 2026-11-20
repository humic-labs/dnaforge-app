// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  workspaceViewerActualWebGLMapVisible,
  workspaceViewerAskAiDisabled,
  workspaceViewerCanEditSequence,
  workspaceViewerDrawerSurfaceOpen,
  workspaceViewerEmptySequenceEntryVisible,
  workspaceViewerFallbackName,
  workspaceViewerOrLocal,
  workspaceViewerHighlightRange,
  workspaceViewerLiveAnnotations,
  workspaceViewerLiveSequence,
  workspaceViewerMaybeFrozenCenter,
  workspaceViewerRequestedSideMapPaneWidth,
  workspaceViewerSequenceEditable,
  workspaceViewerSurfaceFlags,
  workspaceViewerViewportIndicatorVisible,
} from './workspace-viewer-surface-flags';

describe('Canvas viewport indicator visibility', () => {
  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])('Canvas %s, map %s → marker %s', (canvas, map, expected) => {
    expect(workspaceViewerViewportIndicatorVisible(canvas, map)).toBe(expected);
  });
});

function flags(overrides: Partial<Parameters<typeof workspaceViewerSurfaceFlags>[0]> = {}) {
  return workspaceViewerSurfaceFlags({
    isEditMode: false,
    sourceSequenceLength: 100,
    sequenceSurfaceVisibleFromView: true,
    mapVisibleFromView: true,
    rendererVisibility: 'both',
    mapPlacement: 'bottom',
    circular: true,
    effectiveMapShape: 'circular',
    viewerLodLevel: 'detail',
    ...overrides,
  });
}

describe('workspaceViewerSurfaceFlags', () => {
  it('treats edit-mode on an empty source as empty-sequence editing and hides the map', () => {
    const emptyEdit = flags({ isEditMode: true, sourceSequenceLength: 0 });
    expect(emptyEdit.emptySequenceEditing).toBe(true);
    expect(emptyEdit.sequenceSurfaceVisible).toBe(true);
    expect(emptyEdit.mapSurfaceVisible).toBe(false);
    expect(emptyEdit.mapOnlyVisible).toBe(false);
  });

  it('marks map-only when the view is map and we are not empty-sequence editing', () => {
    expect(flags({ rendererVisibility: 'map' }).mapOnlyVisible).toBe(true);
    expect(
      flags({
        rendererVisibility: 'map',
        isEditMode: true,
        sourceSequenceLength: 0,
      }).mapOnlyVisible
    ).toBe(false);
  });

  it('places the map before the sequence for left/top and treats circular topology as circular+circular shape', () => {
    expect(flags({ mapPlacement: 'left' }).mapPlacedBeforeSequence).toBe(true);
    expect(flags({ mapPlacement: 'top' }).mapPlacedBeforeSequence).toBe(true);
    expect(flags({ mapPlacement: 'bottom' }).mapPlacedBeforeSequence).toBe(false);
    expect(flags({ circular: false }).mapTopologyCircular).toBe(false);
    expect(flags({ effectiveMapShape: 'linear' }).mapTopologyCircular).toBe(false);
  });

  it('keeps cut-site detail at feature LOD, not only nucleotide LOD', () => {
    expect(flags({ viewerLodLevel: 'feature' }).isFeatureOrDetailLod).toBe(true);
    expect(flags({ viewerLodLevel: 'density' }).isFeatureOrDetailLod).toBe(false);
  });
});

describe('workspaceViewerActualWebGLMapVisible', () => {
  it('shows a visible map and hides a collapsed map', () => {
    expect(workspaceViewerActualWebGLMapVisible(true, false)).toBe(true);
    expect(workspaceViewerActualWebGLMapVisible(false, false)).toBe(false);
  });

  it('hides the live WebGL map when the minimap is off', () => {
    expect(workspaceViewerActualWebGLMapVisible(true, true)).toBe(false);
  });
});

describe('workspaceViewerDrawerSurfaceOpen', () => {
  it('is open when either the feature drawer or the enzyme drawer is present', () => {
    expect(workspaceViewerDrawerSurfaceOpen(null, false)).toBe(false);
    expect(workspaceViewerDrawerSurfaceOpen({}, false)).toBe(true);
    expect(workspaceViewerDrawerSurfaceOpen(null, true)).toBe(true);
  });
});

describe('workspaceViewerAskAiDisabled', () => {
  it('disables Ask AI on gapped, alignment, missing handler, or inactive command scope', () => {
    const enabled = {
      isGapped: false,
      inAlignmentMode: false,
      onAskAI: () => undefined,
      sequenceCommandIsActive: true,
    };
    expect(workspaceViewerAskAiDisabled(enabled)).toBe(false);
    expect(workspaceViewerAskAiDisabled({ ...enabled, isGapped: true })).toBe(true);
    expect(workspaceViewerAskAiDisabled({ ...enabled, inAlignmentMode: true })).toBe(true);
    expect(workspaceViewerAskAiDisabled({ ...enabled, onAskAI: undefined })).toBe(true);
    expect(workspaceViewerAskAiDisabled({ ...enabled, sequenceCommandIsActive: false })).toBe(true);
  });
});

describe('workspaceViewerCanEditSequence', () => {
  it('requires a document editing session, a save handler and a writable tab', () => {
    const session = {};
    const commit = () => undefined;
    expect(workspaceViewerCanEditSequence(false, session, commit)).toBe(true);
    expect(workspaceViewerCanEditSequence(true, session, commit)).toBe(false);
    expect(workspaceViewerCanEditSequence(false, undefined, commit)).toBe(false);
    expect(workspaceViewerCanEditSequence(false, session, undefined)).toBe(false);
  });
});

describe('workspaceViewerEmptySequenceEntryVisible', () => {
  it('shows the empty-entry cue only while the working document is still empty', () => {
    expect(workspaceViewerEmptySequenceEntryVisible(true, '')).toBe(true);
    expect(workspaceViewerEmptySequenceEntryVisible(true, 'ATG')).toBe(false);
    expect(workspaceViewerEmptySequenceEntryVisible(false, '')).toBe(false);
  });
});

describe('workspaceViewerFallbackName', () => {
  it('falls back when the plasmid name is missing or empty', () => {
    expect(workspaceViewerFallbackName('pUC19', 'Sequence')).toBe('pUC19');
    expect(workspaceViewerFallbackName('', 'Sequence')).toBe('Sequence');
    expect(workspaceViewerFallbackName(undefined, 'unknown')).toBe('unknown');
  });
});

describe('workspaceViewerOrLocal', () => {
  it('prefers the controlled value when the parent supplied one', () => {
    expect(workspaceViewerOrLocal(true, false)).toBe(true);
    expect(workspaceViewerOrLocal(undefined, false)).toBe(false);
    expect(workspaceViewerOrLocal(420, 350)).toBe(420);
  });
});

describe('workspaceViewerSequenceEditable', () => {
  it('is editable only in edit mode on a writable tab', () => {
    expect(workspaceViewerSequenceEditable(false, true)).toBe(true);
    expect(workspaceViewerSequenceEditable(true, true)).toBe(false);
    expect(workspaceViewerSequenceEditable(false, false)).toBe(false);
  });
});

describe('workspaceViewerHighlightRange', () => {
  it('clears the highlight in edit mode and preserves null outside it', () => {
    const range = { start: 1, end: 4 };
    expect(workspaceViewerHighlightRange(true, range)).toBeNull();
    expect(workspaceViewerHighlightRange(false, range)).toEqual(range);
    expect(workspaceViewerHighlightRange(false, null)).toBeNull();
    expect(workspaceViewerHighlightRange(false, undefined)).toBeNull();
  });
});

describe('workspaceViewerRequestedSideMapPaneWidth', () => {
  it('prefers a live draft, then the persisted width, then the split fallback', () => {
    expect(workspaceViewerRequestedSideMapPaneWidth(120, 280, 520)).toBe(120);
    expect(workspaceViewerRequestedSideMapPaneWidth(null, 280, 520)).toBe(280);
    expect(workspaceViewerRequestedSideMapPaneWidth(null, undefined, 520)).toBe(520);
  });
});

describe('workspaceViewerMaybeFrozenCenter', () => {
  it('snapshots the outgoing center only when the canvas mode actually changes', () => {
    expect(workspaceViewerMaybeFrozenCenter('2d', 'tracks', 400, null)).toBe(400);
    expect(workspaceViewerMaybeFrozenCenter('2d', '2d', 400, 1)).toBe(1);
  });
  it('retains the outgoing center through incoming mount callbacks before the handoff is consumed', () => {
    expect(workspaceViewerMaybeFrozenCenter('tracks', '2d', 150, 9001)).toBe(9001);
    expect(workspaceViewerMaybeFrozenCenter('tracks', '2d', 150, 0)).toBe(0);
  });
});

describe('workspaceViewerLiveSequence / workspaceViewerLiveAnnotations', () => {
  const draft = { sequence: 'AAAACCCCGGGG', annotations: [{ name: 'draft', start: 5, end: 8 }] };
  const working = { sequence: 'AACCCCGGGG', annotations: [{ name: 'cc', start: 3, end: 6 }] };

  it('reads the draft the editor shows while in edit mode', () => {
    expect(workspaceViewerLiveSequence(true, draft, working.sequence)).toBe(draft.sequence);
    expect(workspaceViewerLiveAnnotations(true, draft, working.annotations)).toBe(
      draft.annotations
    );
  });

  it('reads the working document outside edit mode or without an owner draft', () => {
    expect(workspaceViewerLiveSequence(false, draft, working.sequence)).toBe(working.sequence);
    expect(workspaceViewerLiveSequence(true, null, working.sequence)).toBe(working.sequence);
    expect(workspaceViewerLiveAnnotations(false, draft, working.annotations)).toBe(
      working.annotations
    );
    expect(workspaceViewerLiveAnnotations(true, null, undefined)).toEqual([]);
  });
});
