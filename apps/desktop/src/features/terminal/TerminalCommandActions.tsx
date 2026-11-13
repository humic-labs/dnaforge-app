import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import { useEffect, useRef, useState } from 'react';
import type { TerminalCommand } from '../../shared/terminal-ipc';
import {
  terminalGitQuickFixes,
  terminalAdditionalQuickFixes,
} from './upstream/terminal-git-quick-fixes';
import type { TerminalQuickFix } from '../../shared/terminal-quick-fix';

export type TerminalCommandAction = 'run' | 'insert' | 'copy' | 'output';

export function TerminalCommandActions({
  command,
  running,
  shellPath,
  requestOutput,
  onQuickFix,
  onAction,
  onClose,
}: {
  command: TerminalCommand;
  running: boolean;
  shellPath: string;
  requestOutput(commandId: string): Promise<string | undefined>;
  onQuickFix(fix: TerminalQuickFix): void;
  onAction(action: TerminalCommandAction): void;
  onClose(): void;
}) {
  const presentationNativeDialog = usePresentationOverlay('modal');

  const dialog = useRef<HTMLDialogElement>(null);
  const [quickFixes, setQuickFixes] = useState<{
    command: TerminalCommand;
    fixes: TerminalQuickFix[];
  } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (command.id && command.finishedAt !== null && command.exitCode !== null) {
      void requestOutput(command.id).then(
        (output) => {
          if (!cancelled)
            setQuickFixes({
              command,
              fixes:
                output === undefined
                  ? []
                  : [
                      ...terminalGitQuickFixes(command, output).map(
                        (text): TerminalQuickFix => ({ kind: 'command', command: text })
                      ),
                      ...terminalAdditionalQuickFixes(command, output, shellPath),
                    ],
            });
        },
        () => {
          if (!cancelled) setQuickFixes({ command, fixes: [] });
        }
      );
    }
    return () => {
      cancelled = true;
    };
  }, [command, requestOutput, shellPath]);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const choose = (action: TerminalCommandAction) => {
    close();
    onAction(action);
  };
  return (
    <PresentationScopeContext.Provider value={presentationNativeDialog.scope}>
      <dialog
        ref={presentationNativeDialog.bindRef(dialog, '0')}
        data-terminal-surface
        aria-label="Terminal command actions"
        className="dnaforge-terminal-command-actions bg-bg text-fg"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <h2>Command actions</h2>
        <pre>{command.command}</pre>
        <p>
          {command.finishedAt === null
            ? 'Running'
            : command.exitCode === null
              ? 'Finished'
              : `Exit code ${command.exitCode}`}
        </p>
        {quickFixes?.command === command && quickFixes.fixes.length > 0 && (
          <div role="group" aria-label="Quick fixes" className="dnaforge-terminal-toolbar">
            {quickFixes.fixes.map((fix) => (
              <button
                key={JSON.stringify(fix)}
                disabled={fix.kind !== 'link' && !running}
                onClick={() => {
                  close();
                  onQuickFix(fix);
                }}
              >
                {fix.kind === 'command'
                  ? `Run ${fix.command}`
                  : fix.kind === 'link'
                    ? 'Open GitHub pull request'
                    : `Free port ${fix.port}`}
              </button>
            ))}
          </div>
        )}
        <div className="dnaforge-terminal-toolbar">
          <button disabled={!running} onClick={() => choose('run')}>
            Run command
          </button>
          <button disabled={!running} onClick={() => choose('insert')}>
            Insert command
          </button>
          <button onClick={() => choose('copy')}>Copy command</button>
          <button
            disabled={!command.id || command.range?.endLine === undefined}
            onClick={() => choose('output')}
          >
            View command output
          </button>
          <button aria-label="Close command actions" onClick={close}>
            Close
          </button>
        </div>
      </dialog>
    </PresentationScopeContext.Provider>
  );
}
