import { ActionMenu } from '../../components/ActionMenu';
import {
  PresentationScopeContext,
  usePresentationScope,
} from '../../presentation/PresentationSurface';

export interface TerminalMenuAction {
  id: string;
  label: string;
  disabled?: boolean;
  run(): void;
}

export function TerminalContextMenu({
  x,
  y,
  presentationParentId,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  presentationParentId: string;
  actions: TerminalMenuAction[];
  onClose(): void;
}) {
  const { owner } = usePresentationScope();
  return (
    <PresentationScopeContext.Provider value={{ owner, id: presentationParentId }}>
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
    </PresentationScopeContext.Provider>
  );
}
