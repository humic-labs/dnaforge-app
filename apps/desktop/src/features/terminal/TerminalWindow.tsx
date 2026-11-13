import { Providers } from '../../shared/context';
import { CommandScopeProvider } from '../../commands';
import { ConfirmDialogHost } from '../../components/ConfirmDialogHost';
import { TerminalDock } from './TerminalDock';

export function TerminalWindow({ groupId }: { groupId: string }) {
  return (
    <Providers>
      <CommandScopeProvider>
        <div className="dnaforge-terminal-window bg-bg text-fg">
          <TerminalDock floatingGroupId={groupId} />
        </div>
        <ConfirmDialogHost />
      </CommandScopeProvider>
    </Providers>
  );
}
