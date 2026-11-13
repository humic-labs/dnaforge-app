import { useCallback } from 'react';
import type { ActiveOverlaySnapshot } from '../../ai/public/selection-descriptor/active-overlays';
import type { SlashAskSelectionSnapshot } from '../slash-ask/build-payload';
import { useSlashAsk } from './useSlashAsk';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { ColoredCutSite, ORF } from '@waypoint/sequence-utils';

type AskAiHandler = (payload: {
  range: { start: number; end: number };
  wraps?: boolean;
  overlays?: ActiveOverlaySnapshot;
  inferredWindow?: boolean;
  seedText?: string;
  anchor?: { x: number; y: number };
}) => void;

export function useWorkspaceViewerAskAi({
  isSequenceViewTransformed,
  cutSitesVisible,
  cutSites,
  orfsVisible,
  orfs,
  primersVisible,
  primers,
  askAiBoundarySelection,
  viewCursor,
  sourcePositionFromView,
  sequenceLength,
  isCircular,
  isEditMode,
  disabled,
  onAskAI,
}: {
  isSequenceViewTransformed: boolean;
  cutSitesVisible: boolean;
  cutSites: ColoredCutSite[];
  orfsVisible: boolean;
  orfs: ORF[] | undefined;
  primersVisible: boolean;
  primers: PrimerDisplay[] | undefined;
  askAiBoundarySelection: SlashAskSelectionSnapshot['sourceRange'];
  viewCursor: number | null;
  sourcePositionFromView: (viewPosition: number) => number | null;
  sequenceLength: number;
  isCircular: boolean;
  isEditMode: boolean;
  disabled: boolean;
  onAskAI?: AskAiHandler;
}): { buildAskAiOverlaysSnapshot: () => ActiveOverlaySnapshot | undefined } {
  const buildAskAiOverlaysSnapshot = useCallback((): ActiveOverlaySnapshot | undefined => {
    if (isSequenceViewTransformed) return undefined;
    return {
      restrictionSites: {
        visible: cutSitesVisible,
        sites: cutSitesVisible ? cutSites : [],
      },
      orfs: { visible: orfsVisible, items: orfs ?? [] },
      primers: { visible: primersVisible, items: primers ?? [] },
    };
  }, [
    isSequenceViewTransformed,
    cutSitesVisible,
    cutSites,
    orfsVisible,
    orfs,
    primersVisible,
    primers,
  ]);

  const getSlashAskSnapshot = useCallback((): SlashAskSelectionSnapshot => {
    const sourceRange = askAiBoundarySelection ?? null;
    let sourceCaret: number | null = null;
    if (!sourceRange && viewCursor != null) {
      const source0 = sourcePositionFromView(viewCursor);
      sourceCaret = source0 == null ? null : source0 + 1;
    }
    return {
      sourceRange,
      sourceCaret,
      sequenceLength,
      isCircular,
    };
  }, [askAiBoundarySelection, viewCursor, sourcePositionFromView, sequenceLength, isCircular]);

  useSlashAsk({
    isEditMode,
    getSelectionSnapshot: getSlashAskSnapshot,
    disabled,
    onTrigger: (payload) => {
      if (!onAskAI) return;
      onAskAI({
        range: payload.range,
        wraps: payload.range.wraps,
        overlays: buildAskAiOverlaysSnapshot(),
        inferredWindow: payload.inferredWindow,
      });
    },
  });

  return { buildAskAiOverlaysSnapshot };
}
