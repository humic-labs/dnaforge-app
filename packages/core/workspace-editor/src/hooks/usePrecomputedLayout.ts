import { useMemo, useEffect, useRef } from 'react';
import type {
  LayoutSnapshot2D,
  WorkspaceEditorConfig,
  PrimerDisplay,
  CoordinateSpace,
  MutationMarker,
  LinePositions,
} from '../types';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { CodonInfo, AlignmentCodonInfo } from '../translation-drawing';
import { calculateLinePositions } from '../line-positions';
export { primerOverlapsLine } from '../primer-layout';

export interface PrecomputedLinePosition extends LinePositions {}

interface UsePrecomputedLayoutParams {
  layout: LayoutSnapshot2D;
  partialConfig: Partial<WorkspaceEditorConfig>;
  fullSequence: string;
  primers: PrimerDisplay[];
  coordinateSpace?: CoordinateSpace;
  mutations: MutationMarker[];
}

interface UsePrecomputedLayoutResult {
  config: WorkspaceEditorConfig;
  precomputedLinePositions: PrecomputedLinePosition[];
  linePrimerFlagsMap: Map<
    LayoutSnapshot2D['lines'][0],
    { hasForwardPrimers: boolean; hasReversePrimers: boolean }
  >;
  mutationCacheRef: React.MutableRefObject<{
    mutations: MutationMarker[];
    map: Map<number, MutationMarker>;
  }>;
  alignmentCodonsCacheRef: React.MutableRefObject<{
    alignedRef: string;
    alignedQuery: string;
    codonsMap: Map<string, AlignmentCodonInfo[]>;
  }>;
  lineCodonsCacheRef: React.MutableRefObject<Map<number, CodonInfo[]>>;
}

export function usePrecomputedLayout({
  layout,
  partialConfig,
  fullSequence,
  primers,
  coordinateSpace,
  mutations,
}: UsePrecomputedLayoutParams): UsePrecomputedLayoutResult {
  const mutationCacheRef = useRef<{
    mutations: MutationMarker[];
    map: Map<number, MutationMarker>;
  }>({ mutations: [], map: new Map() });

  if (mutations !== mutationCacheRef.current.mutations) {
    const newMap = new Map<number, MutationMarker>();
    for (const m of mutations) {
      const endCol = m.endColumn ?? m.column;
      for (let col = m.column; col <= endCol; col++) {
        newMap.set(col, m);
      }
    }
    mutationCacheRef.current = { mutations, map: newMap };
  }

  const config = useMemo(
    () => ({ ...DEFAULT_EDITOR_CONFIG, ...partialConfig }),
    [
      partialConfig.charsPerLine,
      partialConfig.linearWrapPhase,
      partialConfig.wrapCapacity,
      partialConfig.predictedTopBp,
      partialConfig.wrapAnchorBp,
      partialConfig.rowBackgroundOffset,
      partialConfig.charWidth,
      partialConfig.rowHeight,
      partialConfig.marginLeft,
      partialConfig.fontFamily,
      partialConfig.fontSize,
      partialConfig.rulerInterval,
      partialConfig.showTranslation,
      partialConfig.showAnnotations,
      partialConfig.showReverseComplement,
      partialConfig.showPrimers,
      partialConfig.colorPalette,
      partialConfig.annotationColorMode,
      partialConfig.aaColorScheme,
      partialConfig.showResidueNumbers,
      partialConfig.lodLevel,
      partialConfig.overviewLod,
    ]
  );

  const alignmentCodonsCacheRef = useRef<{
    alignedRef: string;
    alignedQuery: string;
    codonsMap: Map<string, AlignmentCodonInfo[]>;
  }>({ alignedRef: '', alignedQuery: '', codonsMap: new Map() });

  const lineCodonsCacheRef = useRef<Map<number, CodonInfo[]>>(new Map());
  useEffect(() => {
    if (!config.showTranslation) {
      lineCodonsCacheRef.current.clear();
    }
  }, [config.showTranslation]);

  const precomputedLinePositions = useMemo(() => {
    const seqLen = fullSequence.length;
    const densityLod = config.overviewLod === true || config.lodLevel === 'density';
    const hasMutTrackGlobal =
      !densityLod && (mutations.length > 0 || !!coordinateSpace?.alignedQuery);

    return layout.lines.map((line) =>
      calculateLinePositions(line, config, primers, seqLen, hasMutTrackGlobal)
    );
  }, [layout, config, primers, mutations, coordinateSpace, fullSequence]);

  const linePrimerFlagsMap = useMemo(() => {
    const map = new Map<
      (typeof layout.lines)[0],
      { hasForwardPrimers: boolean; hasReversePrimers: boolean }
    >();
    for (const lp of precomputedLinePositions) {
      map.set(lp.line, {
        hasForwardPrimers: lp.hasForwardPrimers,
        hasReversePrimers: lp.hasReversePrimers,
      });
    }
    return map;
  }, [precomputedLinePositions, layout.lines]);

  return {
    config,
    precomputedLinePositions,
    linePrimerFlagsMap,
    mutationCacheRef,
    alignmentCodonsCacheRef,
    lineCodonsCacheRef,
  };
}
