import { ActionMenu } from '../../components/ActionMenu';

export interface TerminalMenuAction {
  id: string;
  label: string;
  disabled?: boolean;
  run(): void;
}

export function TerminalContextMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: TerminalMenuAction[];
  onClose(): void;
}) {
  return (
    <ActionMenu
      open
      label="Terminal actions"
      anchorPoint={{ x, y }}
      onClose={onClose}
      entries={actions.map(({ id, label, disabled, run }) => ({
        id,
        label,
        disabled,
        onSelect: run,
      }))}
    />
  );
}
