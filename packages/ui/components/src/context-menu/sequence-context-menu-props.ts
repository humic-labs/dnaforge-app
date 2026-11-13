import type { Annotation } from '@waypoint/sequence-utils';

export interface SequenceContextMenuProps {
  x: number;
  y: number;
  isOpen: boolean;
  onClose: () => void;
  shortcutHints?: Partial<
    Record<
      | 'copySequence'
      | 'copyReverseComplement'
      | 'copyTranslation'
      | 'addAnnotation'
      | 'invertSelection'
      | 'paste',
      string
    >
  >;
  selectedSequence?: string;
  hasSelection?: boolean;
  onAttachPrimers?: () => void;
  onCreateForwardPrimer?: () => void;
  onCreateReversePrimer?: () => void;
  onCopySequence?: () => void;
  onCopyReverseComplement?: () => void;
  onCopyTranslation?: () => void;
  onCopyCDSTranslation?: () => void;
  clickedTranscript?: { name: string } | null;
  onCopyTranscriptDna?: () => void;
  onCopyTranscriptRna?: () => void;
  onChooseTranscriptIsoform?: () => void;
  clickedCDS?: Annotation | null;
  onCreateAminoAcidSequence?: () => void;
  createAminoAcidSequenceDisabled?: boolean;
  structureAnnotation?: Annotation | null;
  onEditSequence?: () => void;
  onPaste?: () => void;
  pasteTargetLabel?: string;
  isOnNucleotideRow?: boolean;
  clickedAnnotation?: Annotation | null;
  selectionRange?: { start: number; end: number } | null;
  onAddAnnotation?: (range: { start: number; end: number }) => void;
  onEditAnnotation?: (annotation: Annotation) => void;
  onDeleteAnnotation?: (annotation: Annotation) => void;

  onCommitCdsExtension?: () => void;
  clickedAnnotationIsCdsExtensionPreview?: boolean;
  clickedORF?: {
    start: number;
    end: number;
    strand: '+' | '-';
    frame: number;
    length: number;
  } | null;
  onSaveORFAsAnnotation?: (orf: {
    start: number;
    end: number;
    strand: '+' | '-';
    frame: number;
    length: number;
  }) => void;
  inAlignmentMode?: boolean;
  clickedPrimer?: {
    id: string;
    name: string;
    start: number;
    end: number;
    direction: string;
  } | null;
  onEditPrimer?: () => void;
  onEditPrimerBinding?: () => void;
  onCopyPrimerBases?: () => void;
  onDetachPrimer?: () => void;
  onReverseComplementAssemblyPart?: () => void;
  onInvertSelection?: () => void;
  onReindexHere?: () => void;
  onFlipOrientation?: () => void;
  onResetSequenceView?: () => void;
  isSequenceViewTransformed?: boolean;
  onPreviewCDS?: (previewing: boolean) => void;
  onViewStructure?: () => void;
  viewStructureDisabled?: boolean;
  onAskAI?: () => void;
  askAiShortcut?: string;
}
