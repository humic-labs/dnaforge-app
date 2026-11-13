import { useCallback, useRef, type RefObject } from 'react';
import type { AnnotationStateIdentity, WorkspaceEditorHandle } from '@waypoint/workspace-editor';
import { recordWebGLSelectionDebug } from '@waypoint/genome-renderer';
import type { BackboneBoundaryHandleHitPayload } from '@waypoint/genome-renderer';
import type { SelectionRange } from '../selection-state';

type WebglFeatureRange = { start: number; end: number } | null;
export type WebglPrimerRange = {
  id: string;
  start: number;
  end: number;
  direction: 'forward' | 'reverse';
  overhangLength?: number;
};
type WebglPrimerPreviewRange = WebglPrimerRange & {
  bases: string;
  tm: number;
  gc: number;
};
type WebglSelectionDragMode = 'new' | 'start' | 'end';

export interface WebglMapCrossoverRange {
  regionId: string;
  start: number;
  end: number;
}

export interface WebglMapCrossoverEditRange extends WebglMapCrossoverRange {
  editableSides: ReadonlyArray<'upstream' | 'downstream'>;
}

export type WebglPrimerPbsLengthCommit = (
  primer: WebglPrimerRange,
  length: number
) => WebglPrimerRange | null;

export type WebglPrimerPbsLengthPreview = (
  primer: WebglPrimerRange,
  length: number
) => WebglPrimerPreviewRange | null;

export function projectWebglPrimerPbsBoundary(input: {
  primer: WebglPrimerRange;
  nextPbsLength: number;
  genomeLength: number;
  circular: boolean;
}): number | null {
  const { primer, nextPbsLength, genomeLength, circular } = input;
  if (genomeLength <= 0 || !Number.isFinite(nextPbsLength)) return null;

  const currentBoundary = primer.direction === 'forward' ? primer.end : primer.start;
  const currentRange = resolveDirectPrimerPbsRange({
    primer,
    targetBp: currentBoundary,
    genomeLength,
    circular,
  });
  if (!currentRange) return null;
  const lengthDelta = Math.round(nextPbsLength) - currentRange.length;
  const rawBoundary =
    primer.direction === 'forward' ? currentBoundary + lengthDelta : currentBoundary - lengthDelta;
  if (circular) {
    return ((rawBoundary % genomeLength) + genomeLength) % genomeLength;
  }
  return Math.max(0, Math.min(genomeLength, rawBoundary));
}

export type WebglMapCrossoverBoundaryCommit = (
  range: WebglMapCrossoverRange,
  side: 'upstream' | 'downstream',
  deltaBp: number
) => WebglMapCrossoverRange | null;

interface UseWebglMapInteractionsInput {
  sequenceViewerRef: RefObject<WorkspaceEditorHandle | null>;
  clearSelection: () => void;
  setHighlightedRange: (range: SelectionRange | null) => void;
  setViewCursor: (position: number | null) => void;
  setSelectedAnnotation: (annotation: AnnotationStateIdentity | null) => void;
  scrollToBiologicalPosition: (position: number) => void;
  genomeLength: number;
  circular: boolean;
  onPositionClick?: (position: number) => void;
  onSelectionPreview?: (range: SelectionRange) => void;
  onPrimerPbsLengthPreview?: WebglPrimerPbsLengthPreview;
  onPrimerPbsLengthCommit?: WebglPrimerPbsLengthCommit;
  onMapCrossoverBoundaryCommit?: WebglMapCrossoverBoundaryCommit;
}

export function useWebglMapInteractions({
  sequenceViewerRef,
  clearSelection,
  setHighlightedRange,
  setViewCursor,
  setSelectedAnnotation,
  scrollToBiologicalPosition,
  genomeLength,
  circular,
  onPositionClick,
  onSelectionPreview,
  onPrimerPbsLengthPreview,
  onPrimerPbsLengthCommit,
  onMapCrossoverBoundaryCommit,
}: UseWebglMapInteractionsInput) {
  const selectionDragModeRef = useRef<WebglSelectionDragMode | null>(null);

  const clearMapEdit = useCallback(() => {
    selectionDragModeRef.current = null;
  }, []);

  const handleWebglMapFeatureSelect = useCallback(
    (feature: WebglFeatureRange) => {
      clearMapEdit();
      if (feature) {
        setHighlightedRange({ start: feature.start, end: feature.end });
      } else {
        clearSelection();
      }
    },
    [clearMapEdit, clearSelection, setHighlightedRange]
  );

  const handleWebglMapSelectionChange = useCallback(
    (start: number, end: number, wraps: boolean) => {
      selectionDragModeRef.current = null;
      clearMapEdit();
      setHighlightedRange({ start, end, wraps });
      setViewCursor(null);
      setSelectedAnnotation(null);
    },
    [clearMapEdit, setHighlightedRange, setSelectedAnnotation, setViewCursor]
  );

  const handleWebglMapSelectionPreview = useCallback(
    (start: number, end: number, wraps: boolean) => {
      sequenceViewerRef.current?.previewHighlight({ start, end, wraps });
      onSelectionPreview?.({ start, end, wraps });
    },
    [sequenceViewerRef, onSelectionPreview]
  );

  const handleWebglMapSelectionStart = useCallback(
    (mode: WebglSelectionDragMode) => {
      selectionDragModeRef.current = mode;
      recordWebGLSelectionDebug('WorkspaceViewer.selectionStart', {
        mode,
      });
      setViewCursor(null);
      setSelectedAnnotation(null);
    },
    [setSelectedAnnotation, setViewCursor]
  );

  const handleWebglMapCrossoverBoundaryCommit = useCallback(
    (handle: BackboneBoundaryHandleHitPayload, targetBp: number) => {
      if (!onMapCrossoverBoundaryCommit) return;
      const crossoverDelta = resolveCrossoverBoundaryDelta({
        currentBoundary: handle.boundaryBp,
        targetBoundary: targetBp,
        genomeLength,
        circular,
      });
      if (crossoverDelta === null) return;
      const range = {
        regionId: handle.regionId,
        start: handle.rangeStart,
        end: handle.rangeEnd,
      };
      const committedRange = onMapCrossoverBoundaryCommit(range, handle.side, crossoverDelta);
      recordWebGLSelectionDebug('WorkspaceViewer.crossoverCommitResult', {
        handle,
        targetBp,
        crossoverDelta,
        committedRange,
      });
      setSelectedAnnotation(null);
    },
    [circular, genomeLength, onMapCrossoverBoundaryCommit, setSelectedAnnotation]
  );

  const handleWebglMapPositionClick = useCallback(
    (position: number) => {
      clearMapEdit();
      setHighlightedRange(null);
      setViewCursor(position);
      setSelectedAnnotation(null);
      onPositionClick?.(position);
    },
    [clearMapEdit, onPositionClick, setHighlightedRange, setSelectedAnnotation, setViewCursor]
  );

  const handleWebglMapPositionDoubleClick = useCallback(
    (position: number) => {
      clearMapEdit();
      setViewCursor(position);
      setSelectedAnnotation(null);
      scrollToBiologicalPosition(position + 1);
    },
    [clearMapEdit, scrollToBiologicalPosition, setSelectedAnnotation, setViewCursor]
  );

  const handleWebglMapPrimerClick = useCallback(
    (primer: WebglPrimerRange) => {
      clearMapEdit();
      setViewCursor(primer.start);
      setSelectedAnnotation(null);
      scrollToBiologicalPosition(primer.start + 1);
      setHighlightedRange(
        onPrimerPbsLengthCommit ? null : { start: primer.start, end: primer.end - 1 }
      );
    },
    [
      clearMapEdit,
      onPrimerPbsLengthCommit,
      scrollToBiologicalPosition,
      setHighlightedRange,
      setSelectedAnnotation,
      setViewCursor,
    ]
  );

  const handleWebglMapPrimerPbsEndpointCommit = useCallback(
    (primer: WebglPrimerRange, targetBp: number) => {
      if (!onPrimerPbsLengthCommit) return;
      const editablePrimerRange = resolveDirectPrimerPbsRange({
        primer,
        targetBp,
        genomeLength,
        circular,
      });
      if (!editablePrimerRange) return;
      const committedPrimer = onPrimerPbsLengthCommit(primer, editablePrimerRange.length);
      const canonicalPrimer = committedPrimer ?? primer;
      recordWebGLSelectionDebug('WorkspaceViewer.primerPbsHandleCommit', {
        primerId: primer.id,
        targetBp,
        requestedPbsLength: editablePrimerRange.length,
        committedPrimer,
      });
      setHighlightedRange(null);
      setViewCursor(
        canonicalPrimer.direction === 'forward' ? canonicalPrimer.end : canonicalPrimer.start
      );
      setSelectedAnnotation(null);
    },
    [
      circular,
      genomeLength,
      onPrimerPbsLengthCommit,
      setHighlightedRange,
      setSelectedAnnotation,
      setViewCursor,
    ]
  );

  const handleWebglMapPrimerPbsEndpointPreview = useCallback(
    (primer: WebglPrimerRange, targetBp: number) => {
      if (!onPrimerPbsLengthPreview) return null;
      const editablePrimerRange = resolveDirectPrimerPbsRange({
        primer,
        targetBp,
        genomeLength,
        circular,
      });
      if (!editablePrimerRange) return null;
      return onPrimerPbsLengthPreview(primer, editablePrimerRange.length);
    },
    [circular, genomeLength, onPrimerPbsLengthPreview]
  );

  return {
    handleWebglMapFeatureSelect,
    handleWebglMapSelectionChange,
    handleWebglMapSelectionPreview,
    handleWebglMapSelectionStart,
    handleWebglMapPositionClick,
    handleWebglMapPositionDoubleClick,
    handleWebglMapPrimerClick,
    handleWebglMapPrimerPbsEndpointPreview:
      onPrimerPbsLengthCommit && onPrimerPbsLengthPreview
        ? handleWebglMapPrimerPbsEndpointPreview
        : undefined,
    handleWebglMapPrimerPbsEndpointCommit: onPrimerPbsLengthCommit
      ? handleWebglMapPrimerPbsEndpointCommit
      : undefined,
    handleWebglMapCrossoverBoundaryCommit,
  };
}

function resolveCrossoverBoundaryDelta(input: {
  currentBoundary: number;
  targetBoundary: number;
  genomeLength: number;
  circular: boolean;
}): number | null {
  const { currentBoundary, targetBoundary, genomeLength, circular } = input;
  if (genomeLength <= 0) return null;
  const rawDelta = targetBoundary - (currentBoundary % genomeLength);
  if (!circular) return rawDelta === 0 ? null : rawDelta;
  const halfGenome = Math.floor(genomeLength / 2);
  const wrappedDelta =
    ((((rawDelta + halfGenome) % genomeLength) + genomeLength) % genomeLength) - halfGenome;
  return wrappedDelta === 0 ? null : wrappedDelta;
}

function resolveDirectPrimerPbsRange(input: {
  primer: WebglPrimerRange;
  targetBp: number;
  genomeLength: number;
  circular: boolean;
}): { length: number } | null {
  const { primer, targetBp, genomeLength, circular } = input;
  if (genomeLength <= 0 || targetBp < 0 || targetBp > genomeLength) return null;
  const rawFixedBp = primer.direction === 'forward' ? primer.start : primer.end;
  const fixedBp = circular
    ? ((rawFixedBp % genomeLength) + genomeLength) % genomeLength
    : rawFixedBp;
  if (!circular && (fixedBp < 0 || fixedBp > genomeLength)) return null;
  const normalizedTargetBp = circular ? targetBp % genomeLength : targetBp;
  const fullPrimerLength = circular
    ? primer.direction === 'forward'
      ? (normalizedTargetBp - fixedBp + genomeLength) % genomeLength
      : (fixedBp - normalizedTargetBp + genomeLength) % genomeLength
    : primer.direction === 'forward'
      ? normalizedTargetBp - fixedBp
      : fixedBp - normalizedTargetBp;
  const pbsLength = fullPrimerLength - (primer.overhangLength ?? 0);
  return pbsLength > 0 ? { length: pbsLength } : null;
}
