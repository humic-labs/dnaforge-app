import { useCallback, useMemo } from 'react';
import { assemblyScaffoldSelectionLength } from '@waypoint/sequence-utils';
import type { SelectionRange } from '../selection-state';
import { localTmRangeForModel } from '../../design/public/algorithms/local-tm';
import { resolveTmModel } from '../../design/public/algorithms/tm-model';
import { useSettingsStore } from '../../junction-workbench/public/settings';

export interface SequenceSelectionStatisticsInput {
  scaffoldRanges?: readonly { start: number; end: number }[];
  highlightedRange: SelectionRange | null;
  sequenceText: string;
  sequenceLength: number;
}

function getSelectionLength(range: SelectionRange | null, sequenceLength: number): number {
  if (!range || sequenceLength <= 0) return 0;
  const start = Math.max(0, Math.min(sequenceLength - 1, range.start));
  const end = Math.max(0, Math.min(sequenceLength - 1, range.end));
  if (range.wraps || end < start) return sequenceLength - start + end + 1;
  return end - start + 1;
}

function getSelectionText(sequenceText: string, range: SelectionRange): string {
  const sequenceLength = sequenceText.length;
  if (sequenceLength <= 0) return '';
  const start = Math.max(0, Math.min(sequenceLength - 1, range.start));
  const end = Math.max(0, Math.min(sequenceLength - 1, range.end));
  if (range.wraps || end < start) return sequenceText.slice(start) + sequenceText.slice(0, end + 1);
  return sequenceText.slice(start, end + 1);
}

export function useSequenceSelectionStatistics({
  scaffoldRanges,
  highlightedRange,
  sequenceText,
  sequenceLength,
}: SequenceSelectionStatisticsInput) {
  const hasAssemblyScaffolds = !!scaffoldRanges?.length;
  const selectionLength = useMemo(
    () =>
      hasAssemblyScaffolds
        ? assemblyScaffoldSelectionLength(sequenceLength, scaffoldRanges!, highlightedRange)
        : getSelectionLength(highlightedRange, sequenceLength),
    [highlightedRange, sequenceLength, hasAssemblyScaffolds, scaffoldRanges]
  );
  const getSelectedSequenceText = useCallback(() => {
    if (!highlightedRange || selectionLength <= 0) return '';
    const text = getSelectionText(sequenceText, highlightedRange);
    return hasAssemblyScaffolds ? text.replace(/\./g, '') : text;
  }, [highlightedRange, selectionLength, sequenceText, hasAssemblyScaffolds]);
  const tmModel = useSettingsStore((s) => s.tmModel);
  const tmConditions = useSettingsStore((s) => s.tmConditions);
  const primerConcNm = useSettingsStore((s) => s.primerConcNm);
  const resolvedTmModel = useMemo(() => resolveTmModel({ userChoice: tmModel }), [tmModel]);
  const selectionTmReadout = useMemo(() => {
    if (selectionLength < 6 || selectionLength > 100) return null;
    return localTmRangeForModel(
      getSelectedSequenceText(),
      resolvedTmModel,
      tmConditions,
      primerConcNm
    );
  }, [getSelectedSequenceText, selectionLength, resolvedTmModel, tmConditions, primerConcNm]);
  const selectionTm = useMemo(() => {
    if (!selectionTmReadout) return null;
    if (selectionTmReadout.kind === 'value') return selectionTmReadout.tm;
    if (selectionTmReadout.kind === 'range') return selectionTmReadout.meanTm;
    return null;
  }, [selectionTmReadout]);
  return { selectionLength, selectionTmReadout, selectionTm, getSelectedSequenceText };
}
