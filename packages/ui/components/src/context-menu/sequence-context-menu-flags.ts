import type { SequenceContextMenuProps } from './sequence-context-menu-props';

export type SequenceContextMenuFlags = {
  hasSelection: boolean;
  hasAnnotationActions: boolean;
  hasAddAnnotation: boolean;
  hasCreateAminoAcidAction: boolean;
  hasCopyActions: boolean;
  hasStructureAction: boolean;
  hasAskAiAction: boolean;
  hasAttachPrimersAction: boolean;
  hasPrimerCreationGroup: boolean;
  hasSaveOrfAction: boolean;
  hasAddAnnotationAction: boolean;
  hasAnnotationSection: boolean;
  hasCreationSection: boolean;
  hasPrimerCopyActions: boolean;
  hasTargetEditActions: boolean;
  hasInvertSelectionAction: boolean;
  hasReindexAction: boolean;
  hasFlipOrientationAction: boolean;
  hasResetSequenceViewAction: boolean;
  hasSequenceViewActions: boolean;
  hasPasteAction: boolean;
  hasEditSequenceAction: boolean;
  showEmptyHint: boolean;
};

function sequenceMenuHasSelection(props: SequenceContextMenuProps): boolean {
  return props.hasSelection ?? Boolean(props.selectedSequence && props.selectedSequence.length > 0);
}

function sequenceMenuHasAnnotationActions(props: SequenceContextMenuProps): boolean {
  return Boolean(props.clickedAnnotation && (props.onEditAnnotation || props.onDeleteAnnotation));
}

function sequenceMenuHasAddAnnotation(props: SequenceContextMenuProps): boolean {
  return Boolean(props.selectionRange && props.onAddAnnotation);
}

function sequenceMenuHasCreateAminoAcidAction(props: SequenceContextMenuProps): boolean {
  return Boolean(props.clickedCDS && props.onCreateAminoAcidSequence);
}

function sequenceMenuHasCopyActions(
  props: SequenceContextMenuProps,
  hasSelection: boolean,
  hasCreateAminoAcidAction: boolean
): boolean {
  return Boolean(
    (hasSelection &&
      (props.onCopySequence || props.onCopyReverseComplement || props.onCopyTranslation)) ||
    (props.clickedTranscript &&
      (props.onCopyTranscriptDna ||
        props.onCopyTranscriptRna ||
        props.onChooseTranscriptIsoform)) ||
    (props.clickedCDS && props.onCopyCDSTranslation) ||
    hasCreateAminoAcidAction
  );
}

function sequenceMenuHasStructureAction(props: SequenceContextMenuProps): boolean {
  if (props.clickedPrimer) return false;
  const target =
    props.structureAnnotation !== undefined ? props.structureAnnotation : props.clickedCDS;
  return Boolean(target && props.onViewStructure && !props.viewStructureDisabled);
}

function sequenceMenuHasAskAiAction(
  props: SequenceContextMenuProps,
  hasSelection: boolean
): boolean {
  return Boolean(hasSelection && props.onAskAI);
}

function sequenceMenuHasPrimerCreationGroup(
  props: SequenceContextMenuProps,
  hasSelection: boolean,
  hasAttachPrimersAction: boolean
): boolean {
  return Boolean(
    hasAttachPrimersAction ||
    (hasSelection && (props.onCreateForwardPrimer || props.onCreateReversePrimer))
  );
}

function sequenceMenuHasSaveOrfAction(props: SequenceContextMenuProps): boolean {
  return Boolean(props.clickedORF && props.onSaveORFAsAnnotation && !props.inAlignmentMode);
}

function sequenceMenuHasAddAnnotationAction(
  hasAddAnnotation: boolean,
  props: SequenceContextMenuProps
): boolean {
  return Boolean(hasAddAnnotation) && !props.clickedORF;
}

function sequenceMenuHasAnnotationSection(
  props: SequenceContextMenuProps,
  hasAddAnnotationAction: boolean,
  hasSaveOrfAction: boolean
): boolean {
  return Boolean(
    hasAddAnnotationAction ||
    hasSaveOrfAction ||
    (props.clickedAnnotation && (props.onEditAnnotation || props.onDeleteAnnotation))
  );
}

function sequenceMenuHasCreationSection(
  hasPrimerCreationGroup: boolean,
  hasAnnotationSection: boolean
): boolean {
  return hasPrimerCreationGroup || hasAnnotationSection;
}

function sequenceMenuHasPrimerCopyActions(props: SequenceContextMenuProps): boolean {
  return Boolean(props.onCopyPrimerBases);
}

function sequenceMenuHasTargetEditActions(
  props: SequenceContextMenuProps,
  hasPrimerCopyActions: boolean
): boolean {
  return Boolean(
    props.onReverseComplementAssemblyPart ||
    (props.clickedPrimer &&
      (props.onEditPrimer ||
        props.onEditPrimerBinding ||
        hasPrimerCopyActions ||
        props.onDetachPrimer))
  );
}

function sequenceMenuHasInvertSelectionAction(
  props: SequenceContextMenuProps,
  hasSelection: boolean
): boolean {
  return Boolean(hasSelection && props.onInvertSelection);
}

function sequenceMenuHasResetSequenceViewAction(props: SequenceContextMenuProps): boolean {
  return Boolean(props.isSequenceViewTransformed && props.onResetSequenceView);
}

function sequenceMenuHasSequenceViewActions(
  hasInvertSelectionAction: boolean,
  hasReindexAction: boolean,
  hasFlipOrientationAction: boolean,
  hasResetSequenceViewAction: boolean
): boolean {
  return Boolean(
    hasInvertSelectionAction ||
    hasReindexAction ||
    hasFlipOrientationAction ||
    hasResetSequenceViewAction
  );
}

function sequenceMenuHasEditSequenceAction(props: SequenceContextMenuProps): boolean {
  return Boolean(props.isOnNucleotideRow && props.onEditSequence);
}

function sequenceMenuShowEmptyHint(
  props: SequenceContextMenuProps,
  flags: {
    hasSelection: boolean;
    hasAnnotationActions: boolean;
    hasAddAnnotationAction: boolean;
    hasCopyActions: boolean;
    hasStructureAction: boolean;
    hasAttachPrimersAction: boolean;
    hasSequenceViewActions: boolean;
  }
): boolean {
  return Boolean(
    !flags.hasSelection &&
    !props.isOnNucleotideRow &&
    !props.onPaste &&
    !flags.hasAnnotationActions &&
    !flags.hasAddAnnotationAction &&
    !flags.hasCopyActions &&
    !flags.hasStructureAction &&
    !flags.hasAttachPrimersAction &&
    !flags.hasSequenceViewActions &&
    (!props.clickedORF || props.inAlignmentMode) &&
    !props.clickedPrimer
  );
}

export function sequenceContextMenuFlags(
  props: SequenceContextMenuProps
): SequenceContextMenuFlags {
  const hasSelection = sequenceMenuHasSelection(props);
  const hasAnnotationActions = sequenceMenuHasAnnotationActions(props);
  const hasAddAnnotation = sequenceMenuHasAddAnnotation(props);
  const hasCreateAminoAcidAction = sequenceMenuHasCreateAminoAcidAction(props);
  const hasCopyActions = sequenceMenuHasCopyActions(props, hasSelection, hasCreateAminoAcidAction);
  const hasStructureAction = sequenceMenuHasStructureAction(props);
  const hasAskAiAction = sequenceMenuHasAskAiAction(props, hasSelection);
  const hasAttachPrimersAction = Boolean(props.onAttachPrimers);
  const hasPrimerCreationGroup = sequenceMenuHasPrimerCreationGroup(
    props,
    hasSelection,
    hasAttachPrimersAction
  );
  const hasSaveOrfAction = sequenceMenuHasSaveOrfAction(props);
  const hasAddAnnotationAction = sequenceMenuHasAddAnnotationAction(hasAddAnnotation, props);
  const hasAnnotationSection = sequenceMenuHasAnnotationSection(
    props,
    hasAddAnnotationAction,
    hasSaveOrfAction
  );
  const hasCreationSection = sequenceMenuHasCreationSection(
    hasPrimerCreationGroup,
    hasAnnotationSection
  );
  const hasPrimerCopyActions = sequenceMenuHasPrimerCopyActions(props);
  const hasTargetEditActions = sequenceMenuHasTargetEditActions(props, hasPrimerCopyActions);
  const hasInvertSelectionAction = sequenceMenuHasInvertSelectionAction(props, hasSelection);
  const hasReindexAction = Boolean(props.onReindexHere);
  const hasFlipOrientationAction = Boolean(props.onFlipOrientation);
  const hasResetSequenceViewAction = sequenceMenuHasResetSequenceViewAction(props);
  const hasSequenceViewActions = sequenceMenuHasSequenceViewActions(
    hasInvertSelectionAction,
    hasReindexAction,
    hasFlipOrientationAction,
    hasResetSequenceViewAction
  );
  const hasPasteAction = Boolean(props.onPaste);
  const hasEditSequenceAction = sequenceMenuHasEditSequenceAction(props);
  const showEmptyHint = sequenceMenuShowEmptyHint(props, {
    hasSelection,
    hasAnnotationActions,
    hasAddAnnotationAction,
    hasCopyActions,
    hasStructureAction,
    hasAttachPrimersAction,
    hasSequenceViewActions,
  });

  return {
    hasSelection,
    hasAnnotationActions,
    hasAddAnnotation,
    hasCreateAminoAcidAction,
    hasCopyActions,
    hasStructureAction,
    hasAskAiAction,
    hasAttachPrimersAction,
    hasPrimerCreationGroup,
    hasSaveOrfAction,
    hasAddAnnotationAction,
    hasAnnotationSection,
    hasCreationSection,
    hasPrimerCopyActions,
    hasTargetEditActions,
    hasInvertSelectionAction,
    hasReindexAction,
    hasFlipOrientationAction,
    hasResetSequenceViewAction,
    hasSequenceViewActions,
    hasPasteAction,
    hasEditSequenceAction,
    showEmptyHint,
  };
}
