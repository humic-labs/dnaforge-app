import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo } from 'react';
import { matchesShortcut } from '@waypoint/ui-components/keyboard';
import { getCDSTranslation, invertSelection } from '@waypoint/workspace-editor';
import {
  reverseComplement,
  type Annotation,
  type GeneticCodeSpec,
  type RecordGeneticCodeBasis,
  type NucleicAcid,
} from '@waypoint/sequence-utils';
import type { SelectionRange } from '../selection-state';
import {
  selectionToAnnotationBoundaryRange,
  selectionToAskAiRange,
} from '../annotation-boundaries';
import { useSequenceSelectionStatistics } from './useSequenceSelectionStatistics';
import { useToastStore } from '../../../stores/toast-store';

export type CopyOrientation = 'forward' | 'reverse-complement';

export function showCopiedSequenceToast(copiedText: string, orientation: CopyOrientation): void {
  const basePairs = copiedText.replace(/-/g, '').length;
  const strand = orientation === 'reverse-complement' ? 'reverse complement' : 'forward strand';
  useToastStore.getState().addToast(
    userMessageWithValues('notice.copied-value-bp-value', {
      value0: userMessageValue(basePairs),
      value1: userMessageValue(strand),
    }),
    {
      definition: 'use-sequence-clipboard-actions-copied-3-bp-forward',
    }
  );
}

export interface CopySelection {
  start: number;
  end: number;
  sequence: string;
  wraps?: boolean;
  orientation?: CopyOrientation;
  sourceSequence?: string;
  sourceAnnotations?: Annotation[];
}

interface SequenceSelectionProjector {
  selection(selection: SelectionRange): SelectionRange;
  selectionAsRange(selection: SelectionRange): { start: number; end: number; wraps?: boolean };
}

interface UseSequenceClipboardActionsInput {
  keyboardActive?: boolean;
  scaffoldRanges?: readonly { start: number; end: number }[];
  highlightedRange: SelectionRange | null;
  sequenceText: string;
  sequenceLength: number;
  sequenceViewToSource: SequenceSelectionProjector;
  sequenceViewCopyOrientation: (reverseComplementRequested: boolean) => CopyOrientation;
  onCopy?: (selection: CopySelection) => void;
  effectiveCDS: Annotation | null;
  sequenceGeneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: RecordGeneticCodeBasis;
  sequenceNucleicAcid?: NucleicAcid;
  setHighlightedRange: (range: SelectionRange | null) => void;
}

async function writeClipboardText(text: string, errorMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error(errorMessage, err);
  }
}

export function useSequenceClipboardActions({
  keyboardActive = true,
  scaffoldRanges,
  highlightedRange,
  sequenceText,
  sequenceLength,
  sequenceViewToSource,
  sequenceViewCopyOrientation,
  onCopy,
  effectiveCDS,
  sequenceGeneticCode,
  geneticCodeBasis,
  sequenceNucleicAcid,
  setHighlightedRange,
}: UseSequenceClipboardActionsInput) {
  const presentationEvents = usePresentationListener();

  const { selectionLength, selectionTmReadout, selectionTm, getSelectedSequenceText } =
    useSequenceSelectionStatistics({
      scaffoldRanges,
      highlightedRange,
      sequenceText,
      sequenceLength,
    });

  const annotationBoundarySelection = useMemo(() => {
    if (!highlightedRange || selectionLength === 0) return null;
    const sourceSelection = sequenceViewToSource.selection({
      start: highlightedRange.start,
      end: highlightedRange.end,
      wraps: highlightedRange.wraps,
    });
    return selectionToAnnotationBoundaryRange(sourceSelection);
  }, [highlightedRange, sequenceViewToSource, selectionLength]);

  const askAiBoundarySelection = useMemo(() => {
    if (!highlightedRange || selectionLength === 0) return null;
    const sourceSelection = sequenceViewToSource.selection({
      start: highlightedRange.start,
      end: highlightedRange.end,
      wraps: highlightedRange.wraps,
    });
    return selectionToAskAiRange(sourceSelection);
  }, [highlightedRange, sequenceViewToSource, selectionLength]);

  const getSelectedReverseComplementText = useCallback(() => {
    const selectedSequenceText = getSelectedSequenceText();
    return selectedSequenceText ? reverseComplement(selectedSequenceText, sequenceNucleicAcid) : '';
  }, [getSelectedSequenceText, sequenceNucleicAcid]);

  const getCopyRange = useCallback(() => {
    if (!highlightedRange || selectionLength <= 0) return null;
    return sequenceViewToSource.selectionAsRange({
      start: highlightedRange.start,
      end: highlightedRange.end,
      wraps: highlightedRange.wraps || highlightedRange.end < highlightedRange.start,
    });
  }, [highlightedRange, selectionLength, sequenceViewToSource]);

  const handleCopySequence = useCallback(async () => {
    if (!highlightedRange || selectionLength <= 0) return;
    const selectedSequenceText = getSelectedSequenceText();
    if (!selectedSequenceText) return;
    const range = getCopyRange();
    if (!range) return;

    const orientation = sequenceViewCopyOrientation(false);
    if (onCopy) {
      onCopy({ ...range, sequence: selectedSequenceText, orientation });
    } else {
      await writeClipboardText(selectedSequenceText, 'Failed to copy to clipboard:');
    }
    showCopiedSequenceToast(selectedSequenceText, orientation);
  }, [
    getCopyRange,
    getSelectedSequenceText,
    highlightedRange,
    onCopy,
    selectionLength,
    sequenceViewCopyOrientation,
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!keyboardActive || e.defaultPrevented) return;
      if (!matchesShortcut(e, ['cmd', 'c']) || selectionLength <= 0) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const nativeSelection = window.getSelection();
      if (
        nativeSelection &&
        !nativeSelection.isCollapsed &&
        nativeSelection.toString().length > 0
      ) {
        return;
      }
      e.preventDefault();
      handleCopySequence();
    };
    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => presentationEvents.remove(document, 'keydown', handleKeyDown);
  }, [handleCopySequence, selectionLength, keyboardActive, presentationEvents]);

  const handleCopyReverseComplement = useCallback(async () => {
    const rc = getSelectedReverseComplementText();
    if (!rc) return;

    const orientation = sequenceViewCopyOrientation(true);
    const range = getCopyRange();
    if (onCopy && range) {
      onCopy({ ...range, sequence: rc, orientation });
    } else {
      await writeClipboardText(rc, 'Failed to copy reverse complement to clipboard:');
    }
    showCopiedSequenceToast(rc, orientation);
  }, [getCopyRange, getSelectedReverseComplementText, onCopy, sequenceViewCopyOrientation]);

  const handleCopyCDSTranslation = useCallback(async () => {
    if (!effectiveCDS) return;
    const protein = getCDSTranslation(
      effectiveCDS,
      sequenceText,
      sequenceGeneticCode,
      geneticCodeBasis
    );
    await writeClipboardText(protein, 'Failed to copy CDS translation to clipboard:');
  }, [effectiveCDS, sequenceText, sequenceGeneticCode, geneticCodeBasis]);

  const handleInvertSelection = useCallback(() => {
    if (!highlightedRange) return;
    const inverted = invertSelection(highlightedRange, sequenceLength);
    if (inverted) {
      setHighlightedRange(inverted);
    }
  }, [highlightedRange, sequenceLength, setHighlightedRange]);

  return {
    selectionLength,
    annotationBoundarySelection,
    askAiBoundarySelection,
    selectionTm,
    selectionTmReadout,
    getSelectedSequenceText,
    getSelectedReverseComplementText,
    handleCopySequence,
    handleCopyReverseComplement,
    handleCopyCDSTranslation,
    handleInvertSelection,
  };
}
