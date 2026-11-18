import { ActionMenu, type ActionMenuEntry } from '../../../components/ActionMenu';

export interface ProteinSequenceContextMenuProps {
  x: number;
  y: number;
  isOpen: boolean;
  onClose: () => void;
  hasSelection: boolean;
  readOnly?: boolean;
  onCopySequence: () => void;
  onBacktranslate: () => void;
  onAskAI: () => void;
  onViewStructure: () => void;
  onPredictStructure: () => void;
}

export function ProteinSequenceContextMenu({
  x,
  y,
  isOpen,
  onClose,
  hasSelection,
  readOnly = false,
  onCopySequence,
  onBacktranslate,
  onAskAI,
  onViewStructure,
  onPredictStructure,
}: ProteinSequenceContextMenuProps) {
  const entries: ActionMenuEntry[] = [
    {
      id: 'copy-sequence',
      label: hasSelection ? 'Copy Selection' : 'Copy Sequence',
      testId: 'protein-menu-copy-sequence',
      closeReason: 'selection',
      onSelect: onCopySequence,
    },
  ];
  if (!readOnly)
    entries.push(
      {
        id: 'backtranslate',
        label: hasSelection ? 'Backtranslate selection…' : 'Backtranslate …',
        testId: 'protein-menu-backtranslate',
        onSelect: onBacktranslate,
      },
      {
        id: 'view-structure',
        label: 'View Structure',
        testId: 'protein-menu-view-structure',
        onSelect: onViewStructure,
      },
      {
        id: 'predict-structure',
        label: 'Predict Structure…',
        testId: 'protein-menu-predict-structure',
        onSelect: onPredictStructure,
      },
      { id: 'ai-separator', separator: true },
      {
        id: 'ask-ai',
        label: 'Ask AI about this protein',
        testId: 'protein-menu-ask-ai',
        onSelect: onAskAI,
      }
    );
  return (
    <ActionMenu
      open={isOpen}
      label="Protein actions"
      entries={entries}
      anchorPoint={{ x, y }}
      onClose={onClose}
      testId="protein-sequence-context-menu"
    />
  );
}
