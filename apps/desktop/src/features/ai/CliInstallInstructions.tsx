import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from '../../components/icons/glyphs';
import type { AgentTransport } from '../../platform';
import { getCliInstallCommands, type InstallCommand } from './cli-install-commands';

const COPY_CONFIRM_RESET_MS = 1500;

interface CliInstallInstructionsProps {
  transport: AgentTransport;
  os: string;
  searchedDirs?: string[];
  onRecheck: () => Promise<unknown> | void;
}

function CommandRow({
  cmd,
  commandTestId,
  copyTestId,
  copied,
  onCopy,
}: {
  cmd: InstallCommand;
  commandTestId: string;
  copyTestId: string;
  copied: boolean;
  onCopy: (command: string) => void;
}) {
  return (
    <div className="flex items-stretch gap-1.5">
      <code
        className="min-w-0 flex-1 truncate rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] leading-5 text-fg"
        data-testid={commandTestId}
        title={cmd.command}
      >
        {cmd.command}
      </code>
      <button
        type="button"
        onClick={() => onCopy(cmd.command)}
        className="flex flex-shrink-0 items-center gap-1 rounded border border-border px-2 text-[11px] font-medium text-fg-muted transition-colors wp-interactive "
        aria-label={`Copy ${cmd.label} install command`}
        data-testid={copyTestId}
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function CliInstallInstructions({
  transport,
  os,
  searchedDirs,
  onRecheck,
}: CliInstallInstructionsProps) {
  const info = getCliInstallCommands(transport, os);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [recheckedStillMissing, setRecheckedStillMissing] = useState(false);
  const [recheckErrored, setRecheckErrored] = useState(false);
  const [showSearched, setShowSearched] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    []
  );

  const handleCopy = useCallback((command: string) => {
    const confirm = () => {
      setCopiedCommand(command);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(
        () => setCopiedCommand((current) => (current === command ? null : current)),
        COPY_CONFIRM_RESET_MS
      );
    };
    const writeText = navigator.clipboard?.writeText;
    if (writeText) {
      writeText.call(navigator.clipboard, command).then(confirm, () => {});
    } else {
      confirm();
    }
  }, []);

  const handleRecheck = useCallback(async () => {
    setRechecking(true);
    setRecheckErrored(false);
    try {
      const result = await onRecheck();
      if (result == null) setRecheckErrored(true);
      else setRecheckedStillMissing(true);
    } catch {
      setRecheckErrored(true);
    } finally {
      setRechecking(false);
    }
  }, [onRecheck]);

  return (
    <div
      className="mt-1.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2"
      data-testid={`cli-install-instructions-${transport}`}
    >
      <div className="text-[11px] font-medium leading-4 text-warning">
        {info.cliLabel} not found. Install it, then re-check:
      </div>

      <div className="mt-1.5 space-y-1">
        <CommandRow
          cmd={info.primary}
          commandTestId={`cli-install-command-${transport}`}
          copyTestId={`cli-install-copy-${transport}`}
          copied={copiedCommand === info.primary.command}
          onCopy={handleCopy}
        />
      </div>

      {info.alternatives.length > 0 && (
        <div className="mt-1.5 space-y-1">
          <div className="text-[10px] uppercase tracking-[0.08em] text-fg-subtle">Or</div>
          {info.alternatives.map((alt, index) => (
            <CommandRow
              key={alt.command}
              cmd={alt}
              commandTestId={`cli-install-alt-command-${transport}-${index}`}
              copyTestId={`cli-install-alt-copy-${transport}-${index}`}
              copied={copiedCommand === alt.command}
              onCopy={handleCopy}
            />
          ))}
        </div>
      )}

      {info.note && <div className="mt-1.5 text-[10px] leading-4 text-fg-subtle">{info.note}</div>}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleRecheck()}
          disabled={rechecking}
          className="rounded border border-border px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors wp-interactive disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`cli-install-recheck-${transport}`}
        >
          {rechecking ? 'Checking…' : 'Re-check'}
        </button>
        <a
          href={info.docUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] font-medium text-accent hover:underline"
          data-testid={`cli-install-docs-${transport}`}
        >
          Install docs
        </a>
      </div>

      {recheckedStillMissing && !rechecking && (
        <div
          className="mt-2 text-[11px] leading-4 text-fg-muted"
          data-testid={`cli-install-still-missing-${transport}`}
        >
          Still not found. If you just installed it, open a <strong>new</strong> terminal (or
          restart the app) so the updated PATH is picked up, then Re-check.
          {searchedDirs && searchedDirs.length > 0 && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => setShowSearched((value) => !value)}
                className="text-accent hover:underline"
                data-testid={`cli-install-diagnostic-toggle-${transport}`}
              >
                {showSearched ? 'Hide where we looked' : 'Where did we look?'}
              </button>
              {showSearched && (
                <div
                  className="mt-1 max-h-24 overflow-auto rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] leading-4 text-fg-subtle"
                  data-testid={`cli-install-searched-dirs-${transport}`}
                >
                  {searchedDirs.map((dir) => (
                    <div key={dir} className="truncate" title={dir}>
                      {dir}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {recheckErrored && !rechecking && (
        <div
          className="mt-2 text-[11px] leading-4 text-fg-muted"
          data-testid={`cli-install-recheck-error-${transport}`}
        >
          Couldn&apos;t re-check just now — see the error above, then try again.
        </div>
      )}
    </div>
  );
}
