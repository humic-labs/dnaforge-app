import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';

import { platform } from '../../../platform';
import { isRemoteSshTarget } from '../../../shared/remote-ssh-target';
import { OPEN_REMOTE_HOSTS_EVENT } from '../../../shared/remote-hosts';

export function SshTerminalLogin({
  target,
  onManageHosts,
}: {
  readonly target: string;
  readonly onManageHosts?: () => void;
}) {
  const host = target.trim();
  const command = isRemoteSshTarget(host) ? `ssh "${host}"` : null;
  const [copying, setCopying] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setCopying(false);
    setNotice(null);
    return () => {
      generationRef.current += 1;
    };
  }, [host]);

  const copy = async (): Promise<void> => {
    if (!command || copying) return;
    const generation = ++generationRef.current;
    setCopying(true);
    setNotice(null);
    try {
      await platform().clipboard.writeText(command);
      if (generation === generationRef.current) {
        setNotice({
          kind: 'success',
          text: 'SSH command copied. Paste it in your terminal to sign in.',
        });
      }
    } catch (error) {
      if (generation === generationRef.current) {
        setNotice({ kind: 'error', text: toUserMessage(error, 'operation.failed') });
      }
    } finally {
      if (generation === generationRef.current) setCopying(false);
    }
  };

  return (
    <div
      className="space-y-2 rounded border border-border bg-bg-subtle p-3 text-xs text-fg-muted"
      data-testid="ssh-terminal-login"
    >
      <div className="font-medium text-fg">Host access</div>
      <p>
        Sign in and check SSH access in Remote hosts. Login is independent of choosing files;
        closing this picker keeps the host connection.
      </p>
      <button
        type="button"
        className="rounded border border-border bg-bg px-3 py-1.5 text-xs text-fg"
        onClick={() => {
          onManageHosts?.();
          window.dispatchEvent(
            new CustomEvent(OPEN_REMOTE_HOSTS_EVENT, { detail: { target: host } })
          );
        }}
      >
        Manage Remote hosts
      </button>
      <details>
        <summary className="cursor-pointer">Ordinary SSH command</summary>
        <div className="flex flex-wrap items-center gap-2">
          {command ? <code className="min-w-0 break-all text-fg">{command}</code> : null}
          <button
            type="button"
            disabled={!command || copying}
            onClick={() => void copy()}
            className="rounded border border-border bg-bg px-3 py-1.5 text-xs text-fg disabled:opacity-50"
          >
            {copying ? 'Copying…' : 'Copy SSH command'}
          </button>
        </div>
        <p className="text-[11px]">
          Run any institution-required setup before this ordinary SSH command. A terminal connection
          opened without sharing cannot be reused. Sign in through Remote hosts to let DNAForge
          manage connection reuse for you.
        </p>
      </details>
      {notice ? (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={notice.kind === 'error' ? 'text-danger' : ''}
        >
          {notice.text}
        </div>
      ) : null}
    </div>
  );
}
