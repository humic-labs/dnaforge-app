// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import type { AnnotationSearchFocus, Feature } from '@waypoint/genome-renderer';
import { describe, expect, it } from 'vitest';
import { usePixiMap } from './use-pixi-map';

describe('usePixiMap annotation search focus bridge', () => {
  it('syncs exact focus props into Pixi render state and clears them without mounting Pixi', () => {
    const initialFocus: AnnotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-TX1',
    };
    const initialFeature: Feature = {
      id: 11,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      annotationTrackLane: 0,
      start: 100,
      end: 200,
      direction: 'forward',
      displayName: 'TX1',
      color: 0x8b5cf6,
      lane: 0,
      cds: [{ start: 121, end: 180 }],
      canonicalIdentity: initialFocus.canonicalIdentity,
    };
    const { result, rerender } = renderHook<
      ReturnType<typeof usePixiMap>,
      { focus: AnnotationSearchFocus | null; feature: Feature | null }
    >(
      ({ focus, feature }) =>
        usePixiMap({
          genome: null,
          circular: false,
          width: 800,
          height: 220,
          annotationSearchFocus: focus,
          annotationSearchFocusFeature: feature,
        }),
      {
        initialProps: { focus: initialFocus, feature: initialFeature },
      }
    );

    expect(result.current.handle.getState()?.annotationSearchFocus).toEqual(initialFocus);
    expect(result.current.handle.getState()?.annotationSearchFocus).not.toBe(initialFocus);
    expect(result.current.handle.getState()?.annotationSearchFocusFeature).toEqual(initialFeature);
    expect(result.current.handle.getState()?.annotationSearchFocusFeature).not.toBe(initialFeature);
    expect(result.current.handle.getState()?.annotationSearchFocusFeature?.cds).not.toBe(
      initialFeature.cds
    );

    const movedFeature: Feature = {
      ...initialFeature,
      annotationTrackLane: 1,
      lane: 1,
      cds: [{ start: 124, end: 183 }],
    };
    rerender({ focus: initialFocus, feature: movedFeature });
    expect(result.current.handle.getState()?.annotationSearchFocusFeature).toMatchObject({
      canonicalIdentity: initialFocus.canonicalIdentity,
      annotationTrackLane: 1,
      lane: 1,
      cds: [{ start: 124, end: 183 }],
    });

    const nextFocus: AnnotationSearchFocus = {
      trackId: 'lnc_RNA',
      canonicalIdentity: 'canonical-LNC1',
    };
    const nextFeature: Feature = {
      ...initialFeature,
      id: 12,
      type: 'ncRNA',
      annotationTrackId: 'lnc_RNA',
      displayName: 'LNC1',
      canonicalIdentity: nextFocus.canonicalIdentity,
      cds: [],
    };
    rerender({ focus: nextFocus, feature: nextFeature });
    expect(result.current.handle.getState()?.annotationSearchFocus).toEqual(nextFocus);
    expect(result.current.handle.getState()?.annotationSearchFocus).not.toBe(nextFocus);
    expect(result.current.handle.getState()?.annotationSearchFocusFeature).toEqual(nextFeature);
    expect(result.current.handle.getState()?.annotationSearchFocusFeature).not.toBe(nextFeature);

    rerender({ focus: null, feature: null });
    expect(result.current.handle.getState()?.annotationSearchFocus).toBeNull();
    expect(result.current.handle.getState()?.annotationSearchFocusFeature).toBeNull();
  });
});
