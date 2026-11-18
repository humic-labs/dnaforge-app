'use client';

import { ActionMenu } from '@/components/ActionMenu';
import type { ResidueLocation } from '../types';

export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

interface ContextMenuProps {
  position: { x: number; y: number } | null;
  onClose: () => void;
  targetResidue: ResidueLocation | null;
  selectedResidues: ResidueLocation[];
  onCenterSelection: () => void;
  onAskAI?: () => void;
}

export function ContextMenu({
  position,
  onClose,
  targetResidue,
  selectedResidues,
  onCenterSelection,
  onAskAI,
}: ContextMenuProps) {
  if (!position) return null;

  const hasSelection = selectedResidues.length > 0;
  const askLabel = askAiSelectionLabel(selectedResidues);

  const actions: ContextMenuAction[] = [
    {
      id: 'center',
      label: hasSelection ? 'Center on selection' : 'Center on residue',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"
          />
        </svg>
      ),
      onClick: () => {
        onCenterSelection();
      },
      disabled: !hasSelection && !targetResidue,
    },
    {
      id: 'ask-ai',
      label: askLabel,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      ),
      onClick: () => {
        onAskAI?.();
      },
      disabled: !hasSelection || !onAskAI,
    },
  ];

  return (
    <ActionMenu
      open
      label="Structure actions"
      anchorPoint={position}
      onClose={onClose}
      testId="structure-context-menu"
      entries={actions.map(({ id, label, icon, disabled, onClick }) => ({
        id,
        label,
        icon,
        disabled,
        onSelect: onClick,
      }))}
    />
  );
}

function askAiSelectionLabel(selectedResidues: ReadonlyArray<ResidueLocation>): string {
  if (selectedResidues.length === 0) return 'Select residues to ask AI';
  if (selectedResidues.length > 1) {
    return `Ask AI about ${selectedResidues.length} selected residues`;
  }

  const residue = selectedResidues[0];
  const identity = residue.labelCompId ?? residue.compId;
  const coordinate = identity
    ? `${residue.chain}:${identity} ${residue.position}`
    : `${residue.chain}:${residue.position}`;
  return `Ask AI about selected residue ${coordinate}`;
}
