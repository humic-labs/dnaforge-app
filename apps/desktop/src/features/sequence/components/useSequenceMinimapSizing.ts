import { useCallback, useEffect, useRef, useState } from 'react';
import type { SequenceViewState } from '../view-state/sequence-view-state';
import type { SequenceViewStatePatchFn } from '../view-state/useSequenceViewState';
import {
  clampMinimapHeightValue,
  computeMinimapSizing,
  withMinimapGeometryHeight,
  withMinimapPaneHeight,
} from './minimap-sizing';

const DEFAULT_MINIMAP_HEIGHT = 420;
const MIN_MINIMAP_PANE_HEIGHT = 180;
const MIN_MINIMAP_GEOMETRY_HEIGHT = 280;
const MAX_MINIMAP_GEOMETRY_HEIGHT = 600;
const MAX_MINIMAP_PANE_HEIGHT = 10000;

interface UseSequenceMinimapSizingArgs {
  sequenceViewportScopeKey: string;
  seqView: Pick<SequenceViewState, 'minimapHeight' | 'minimapGeometryHeight' | 'webglMorph'>;
  patchSeqView: SequenceViewStatePatchFn;
  defaultMinimapHeight?: number;
  defaultMinimapGeometryHeight?: number;
  maxPaneHeight?: number;
}

export function useSequenceMinimapSizing({
  sequenceViewportScopeKey,
  seqView,
  patchSeqView,
  defaultMinimapHeight,
  defaultMinimapGeometryHeight,
  maxPaneHeight,
}: UseSequenceMinimapSizingArgs) {
  const sequenceContainerRef = useRef<HTMLDivElement>(null);

  const clampMinimapHeight = useCallback(
    (height: number) =>
      clampMinimapHeightValue(height, MIN_MINIMAP_PANE_HEIGHT, MAX_MINIMAP_PANE_HEIGHT),
    []
  );
  const resolvedDefaultMinimapHeight = clampMinimapHeight(
    Number.isFinite(defaultMinimapHeight)
      ? (defaultMinimapHeight as number)
      : DEFAULT_MINIMAP_HEIGHT
  );
  const resolvedDefaultMinimapGeometryHeight =
    defaultMinimapGeometryHeight ?? resolvedDefaultMinimapHeight;

  const [minimapRawSizing, setMinimapRawSizing] = useState(() => ({
    paneHeightRaw: seqView.minimapHeight ?? resolvedDefaultMinimapHeight,
    geometryHeightRaw: seqView.minimapGeometryHeight ?? resolvedDefaultMinimapGeometryHeight,
  }));

  const minimapSizingScopeRef = useRef(sequenceViewportScopeKey);
  const lastPersistedMinimapSizingRef = useRef(minimapRawSizing);
  if (minimapSizingScopeRef.current !== sequenceViewportScopeKey) {
    minimapSizingScopeRef.current = sequenceViewportScopeKey;
    const seeded = {
      paneHeightRaw: seqView.minimapHeight ?? resolvedDefaultMinimapHeight,
      geometryHeightRaw: seqView.minimapGeometryHeight ?? resolvedDefaultMinimapGeometryHeight,
    };
    setMinimapRawSizing(seeded);
    lastPersistedMinimapSizingRef.current = seeded;
  }

  useEffect(() => {
    if (seqView.minimapHeight != null) return;
    setMinimapRawSizing((state) => {
      if (
        state.paneHeightRaw === resolvedDefaultMinimapHeight &&
        (seqView.minimapGeometryHeight != null ||
          state.geometryHeightRaw === resolvedDefaultMinimapGeometryHeight)
      ) {
        return state;
      }
      return {
        paneHeightRaw: resolvedDefaultMinimapHeight,
        geometryHeightRaw:
          seqView.minimapGeometryHeight == null
            ? resolvedDefaultMinimapGeometryHeight
            : state.geometryHeightRaw,
      };
    });
  }, [
    resolvedDefaultMinimapHeight,
    resolvedDefaultMinimapGeometryHeight,
    seqView.minimapGeometryHeight,
    seqView.minimapHeight,
  ]);

  useEffect(() => {
    if (minimapRawSizing === lastPersistedMinimapSizingRef.current) return;
    lastPersistedMinimapSizingRef.current = minimapRawSizing;
    patchSeqView(
      {
        minimapHeight: minimapRawSizing.paneHeightRaw,
        minimapGeometryHeight: minimapRawSizing.geometryHeightRaw,
      },
      { debounce: true }
    );
  }, [minimapRawSizing, patchSeqView]);

  const minimapRawSizingRef = useRef(minimapRawSizing);
  minimapRawSizingRef.current = minimapRawSizing;

  const minimapSizing = computeMinimapSizing({
    paneHeightRaw: minimapRawSizing.paneHeightRaw,
    geometryHeightRaw: minimapRawSizing.geometryHeightRaw,
    minHeight: MIN_MINIMAP_PANE_HEIGHT,
    geometryMinHeight: MIN_MINIMAP_GEOMETRY_HEIGHT,
    maxHeight: MAX_MINIMAP_GEOMETRY_HEIGHT,
    paneMaxHeight: Number.isFinite(maxPaneHeight)
      ? Math.max(MIN_MINIMAP_PANE_HEIGHT, Math.min(MAX_MINIMAP_PANE_HEIGHT, maxPaneHeight!))
      : MAX_MINIMAP_PANE_HEIGHT,
  });
  const minimapGeometryHeight = minimapSizing.geometryHeight;
  const minimapHeight = minimapSizing.paneHeight;

  const [morphToCircle, setMorphToCircle] = useState<number>(() => seqView.webglMorph ?? 0);
  const effectiveMorphToCircle = morphToCircle;
  const morphScopeRef = useRef(sequenceViewportScopeKey);
  if (morphScopeRef.current !== sequenceViewportScopeKey) {
    morphScopeRef.current = sequenceViewportScopeKey;
    setMorphToCircle(seqView.webglMorph ?? 0);
  }

  const handleMorphToCircleChange = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(1, next));
      setMorphToCircle(clamped);
      patchSeqView({ webglMorph: clamped }, { debounce: true });
    },
    [patchSeqView]
  );

  const handleMinimapGeometryHeightChange = useCallback((nextHeight: number) => {
    setMinimapRawSizing((state) => withMinimapGeometryHeight(state, nextHeight));
  }, []);
  const handleMinimapPaneHeightChange = useCallback(
    (nextHeight: number) => {
      const clamped = clampMinimapHeight(nextHeight);
      setMinimapRawSizing((state) => withMinimapPaneHeight(state, clamped));
    },
    [clampMinimapHeight]
  );
  const setMinimapHeights = useCallback((heights: { pane?: number; geometry?: number }) => {
    setMinimapRawSizing((state) => ({
      paneHeightRaw: heights.pane ?? state.paneHeightRaw,
      geometryHeightRaw: heights.geometry ?? state.geometryHeightRaw,
    }));
  }, []);

  const morphToCircleRef = useRef(morphToCircle);
  morphToCircleRef.current = morphToCircle;
  const handleMorphToCircleChangeRef = useRef(handleMorphToCircleChange);
  handleMorphToCircleChangeRef.current = handleMorphToCircleChange;

  return {
    minMinimapHeight: MIN_MINIMAP_PANE_HEIGHT,
    minMinimapGeometryHeight: MIN_MINIMAP_GEOMETRY_HEIGHT,
    maxMinimapHeight: MAX_MINIMAP_GEOMETRY_HEIGHT,
    minimapHeight,
    minimapGeometryHeight,
    effectiveMorphToCircle,
    sequenceContainerRef,
    minimapRawSizingRef,
    morphToCircleRef,
    handleMorphToCircleChangeRef,
    handleMorphToCircleChange,
    handleMinimapGeometryHeightChange,
    handleMinimapPaneHeightChange,
    setMinimapHeights,
  };
}
