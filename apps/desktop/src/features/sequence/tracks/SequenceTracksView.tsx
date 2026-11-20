import { useMemo } from 'react';
import {
  SequenceViewer1D,
  type AnnotatedSequence,
  type SequenceExtraLane,
  type SequenceViewer1DProps,
} from '@waypoint/workspace-editor';
import { getTraceData } from '../../trace/public';
import { computeGcContent } from './gc-content';
import { gcContentLane } from './lane-plugins';
import { chromatogramLane } from './chromatogram-lane';
import { useAttachedReadsStore } from './attached-reads-store';
import { recordExtraLanes, recordSequence } from './trace-probe';
import { useResidueLinkOverlays } from '../../structure-drawer/public/hooks/useResidueLinkOverlays';

const GC_WINDOW = 100;

export function useTracksExtraLanes(sequence: AnnotatedSequence): readonly SequenceExtraLane[] {
  const trace = getTraceData(sequence);
  const attachedReads = useAttachedReadsStore(
    (s) => s.attachedBySequenceId[sequence.id ?? ''] ?? EMPTY_ATTACHED
  );
  recordSequence({
    documentId: sequence.id ?? null,
    metadata: sequence.metadata as Record<string, unknown> | undefined,
    sequenceLength: sequence.sequence.length,
  });
  const gcValues = useMemo(
    () => computeGcContent(sequence.sequence, GC_WINDOW),
    [sequence.sequence]
  );
  const lanes = useMemo(() => {
    const arr: SequenceExtraLane[] = [];
    if (trace) {
      arr.push(
        chromatogramLane({
          trace,
          sequence: sequence.sequence,
          quality: sequence.quality,
          laneId: `sanger-direct-${sequence.id ?? 'unknown'}`,
        })
      );
    }
    for (const read of attachedReads) {
      arr.push(
        chromatogramLane({
          ...read.laneOptions,
          laneId: `sanger-attached-${read.id}`,
        })
      );
    }
    arr.push(gcContentLane({ values: gcValues, windowSize: GC_WINDOW }));
    return arr;
  }, [trace, sequence.sequence, sequence.quality, attachedReads, gcValues]);
  recordExtraLanes(lanes);
  return lanes;
}

const EMPTY_ATTACHED: never[] = [];

export function useSequenceHasSangerTrace(sequence: AnnotatedSequence): boolean {
  const attachedCount = useAttachedReadsStore(
    (state) => state.attachedBySequenceId[sequence.id ?? '']?.length ?? 0
  );
  return getTraceData(sequence) !== null || attachedCount > 0;
}

export interface SequenceViewer1DWithTracksProps extends Omit<SequenceViewer1DProps, 'extraLanes'> {
  tracksMode: boolean;
  cutSitesState: {
    isVisible: boolean;
    cutSites: SequenceViewer1DProps['cutSites'];
    scannedCutSites: SequenceViewer1DProps['scannedCutSites'];
  };
  internalCutSites?: SequenceViewer1DProps['cutSites'];
}

export const RESIDUE_LINK_LANE_ID = 'residue-link-overlay';
const NOOP_DRAW = () => {};

export function buildResidueLinkLane(
  overlays: ReadonlyArray<import('@waypoint/workspace-editor').ReferenceColumnOverlay>
): SequenceExtraLane {
  return {
    id: RESIDUE_LINK_LANE_ID,
    height: 0,
    draw: NOOP_DRAW,
    referenceColumnOverlays: overlays,
  };
}

export function composeExtraLanes(
  tracksMode: boolean,
  trackLanes: ReadonlyArray<SequenceExtraLane>,
  residueOverlays: ReadonlyArray<import('@waypoint/workspace-editor').ReferenceColumnOverlay> | null
): readonly SequenceExtraLane[] | undefined {
  const arr: SequenceExtraLane[] = [];
  if (tracksMode) arr.push(...trackLanes);
  if (residueOverlays && residueOverlays.length > 0) {
    arr.push(buildResidueLinkLane(residueOverlays));
  }
  return arr.length > 0 ? arr : undefined;
}

export function SequenceViewer1DWithTracks({
  tracksMode,
  cutSitesState,
  internalCutSites,
  ...rest
}: SequenceViewer1DWithTracksProps): JSX.Element {
  const tracksLanes = useTracksExtraLanes(rest.sequence);
  const residueOverlays = useResidueLinkOverlays(rest.sequence.id ?? null);
  const extraLanes = useMemo<readonly SequenceExtraLane[] | undefined>(
    () => composeExtraLanes(tracksMode, tracksLanes, residueOverlays),
    [tracksMode, tracksLanes, residueOverlays]
  );
  const mergedCutSites = useMemo(() => {
    const base = (cutSitesState.isVisible ? cutSitesState.cutSites : []) ?? [];
    if (!internalCutSites || internalCutSites.length === 0) return base;
    return [...base, ...internalCutSites];
  }, [cutSitesState.isVisible, cutSitesState.cutSites, internalCutSites]);
  return (
    <SequenceViewer1D
      {...rest}
      cutSites={mergedCutSites}
      scannedCutSites={cutSitesState.isVisible ? cutSitesState.scannedCutSites : []}
      showCutSites={cutSitesState.isVisible || (internalCutSites?.length ?? 0) > 0}
      extraLanes={extraLanes}
      style={{ height: '100%', width: '100%' }}
    />
  );
}
