import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useMemo } from 'react';
import { cleanSequenceFromEditorState } from '@waypoint/workspace-editor/model';
import {
  deriveSequenceEditTransition,
  resolveSequenceGeneticCode,
  STANDARD_GENETIC_CODE_ID,
  type Annotation,
  nucleicAcidOf,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import type { BoundPrimer } from '../primers/public/types';
import { useSequenceStore } from '../sequence/store';
import { useToastStore } from '../../stores/toast-store';
import {
  buildRichSequenceFragmentFromSelection,
  inclusiveCopiedSourceCoordinates,
  richSequenceFragmentForEditor,
  type CopiedSequenceOrientation,
  type CopyablePrimerBinding,
} from './rich-sequence-clipboard';
import { resolveSequenceClipboardText, writeRichSequenceClipboard } from './clipboard-service';
import {
  planGeneticCodePaste,
  preserveInsertedGeneticCodes,
  reReadInsertedAnnotations,
} from './genetic-code-paste';

export interface SequenceClipboardSelection {
  start: number;
  end: number;
  sequence: string;
  wraps?: boolean;
  orientation?: CopiedSequenceOrientation;
  sourceSequence?: string;
  sourceAnnotations?: Annotation[];
}

interface UseRichSequenceClipboardInput {
  documentId: string;
  displayName: string;
  sequence: AnnotatedSequence | null | undefined;
  primerRecords: readonly BoundPrimer[];
  workspaceRoot?: string;
  onReReadPastedFeatures?: (rewrite: ReReadPastedFeatures) => void;
}

export type ReReadPastedFeatures = (
  annotations: readonly Annotation[],
  insertedRange: { start: number; end: number } | null
) => Annotation[] | null;

export function useRichSequenceClipboard({
  documentId,
  displayName,
  sequence,
  primerRecords,
  workspaceRoot,
  onReReadPastedFeatures,
}: UseRichSequenceClipboardInput) {
  const geneticCode = useMemo(
    () => (sequence ? resolveSequenceGeneticCode(sequence).code : STANDARD_GENETIC_CODE_ID),
    [sequence]
  );

  const copySelection = useCallback(
    async (selection: SequenceClipboardSelection) => {
      try {
        if (!sequence) {
          await navigator.clipboard.writeText(selection.sequence);
          return;
        }

        const sourceSequence = selection.sourceSequence ?? sequence.sequence;
        let sourcePrimerBindings: CopyablePrimerBinding[] = primerRecords.map((primer) => ({
          primerId: primer.id,
          bindingStart: primer.binding.bindingStart,
          bindingEnd: primer.binding.bindingEnd,
          strand: primer.binding.strand === -1 ? -1 : 1,
        }));
        const state = useSequenceStore.getState();
        const draft = state.drafts[documentId];
        if (draft) {
          const baseline = state.draftLineages[documentId]?.baseline;
          if (!baseline) throw new Error('The copied draft has no saved coordinate baseline.');
          const clean = cleanSequenceFromEditorState(draft);
          if (clean.sequence !== sourceSequence)
            throw new Error('The copied sequence no longer matches the current draft.');
          const transition = deriveSequenceEditTransition({
            baselineSequence: baseline.sequence,
            draftSequence: draft.sequence,
            cleanSequence: clean.sequence,
            insertedRanges: draft.insertedRanges,
            deletedRanges: draft.deletedRanges,
            substitutedRanges: draft.substitutedRanges,
          });
          let offset = 0;
          for (const operation of transition.operations) {
            if (operation.kind === 'substitute') continue;
            if (operation.kind === 'insert') {
              const at = operation.at + offset;
              sourcePrimerBindings = sourcePrimerBindings.flatMap((binding) => {
                if (at <= binding.bindingStart)
                  return [
                    {
                      ...binding,
                      bindingStart: binding.bindingStart + operation.length,
                      bindingEnd: binding.bindingEnd + operation.length,
                    },
                  ];
                return at < binding.bindingEnd ? [] : [binding];
              });
              offset += operation.length;
            } else {
              const start = operation.start + offset;
              const end = operation.end + offset;
              sourcePrimerBindings = sourcePrimerBindings.flatMap((binding) => {
                if (binding.bindingEnd <= start) return [binding];
                if (binding.bindingStart >= end)
                  return [
                    {
                      ...binding,
                      bindingStart: binding.bindingStart - (end - start),
                      bindingEnd: binding.bindingEnd - (end - start),
                    },
                  ];
                return [];
              });
              offset -= operation.end - operation.start;
            }
          }
          sourcePrimerBindings.push(
            ...clean.pendingPrimerBindings.map((binding) => ({
              primerId: binding.primerId,
              bindingStart: binding.start,
              bindingEnd: binding.end,
              strand: binding.strand,
              ...(binding.sourceWorkspaceRoot
                ? { sourceWorkspaceRoot: binding.sourceWorkspaceRoot }
                : {}),
            }))
          );
        }
        const copied = buildRichSequenceFragmentFromSelection({
          sourceSequence,
          sourceAnnotations: selection.sourceAnnotations ?? sequence.annotations ?? [],
          sourcePrimerBindings,
          sourceWorkspaceRoot: workspaceRoot,
          sourceId: documentId,
          sourceName: sequence.name || displayName || 'Sequence',
          sourceIsCircular: sequence.circular,
          sourceGeneticCode: geneticCode,
          sourceNucleicAcid: nucleicAcidOf(sequence),
          range: selection,
          orientation: selection.orientation ?? 'forward',
        });
        const sourceCoordinates = inclusiveCopiedSourceCoordinates(
          selection,
          (selection.sourceSequence ?? sequence.sequence).length
        );
        await writeRichSequenceClipboard(
          sourceCoordinates ? { ...copied.fragment, sourceCoordinates } : copied.fragment
        );
      } catch (error) {
        console.error('Failed to copy to clipboard:', error);
      }
    },
    [displayName, documentId, geneticCode, primerRecords, sequence, workspaceRoot]
  );

  const resolvePasteFragment = useCallback(
    (clipboardText: string) => {
      const resolved = resolveSequenceClipboardText(clipboardText);
      if (!resolved) return null;

      const editorFragment = richSequenceFragmentForEditor(resolved.fragment);
      const plan = planGeneticCodePaste(resolved.fragment, geneticCode);
      if (plan.kind === 'silent') return editorFragment;
      const preserved = preserveInsertedGeneticCodes(editorFragment, plan);

      const canReRead =
        plan.kind === 'conflict' && plan.preservable && onReReadPastedFeatures !== undefined;
      useToastStore.getState().addRichToast({
        definition: 'clipboard-paste-warning',
        message: toUserMessage(plan.message, 'operation.failed'),
        ...(canReRead
          ? {
              actions: [
                {
                  label: "Re-read under this file's code",
                  onClick: () => {
                    onReReadPastedFeatures((annotations, insertedRange) =>
                      reReadInsertedAnnotations(annotations, plan, insertedRange)
                    );
                  },
                },
              ],
            }
          : {}),
      });
      return preserved;
    },
    [geneticCode, onReReadPastedFeatures]
  );

  return { copySelection, resolvePasteFragment, geneticCode };
}
