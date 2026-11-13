import {
  toUserMessage,
  userMessage,
  renderUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, TextField, UI_CARD_CLASS, UI_SURFACE_CLASS } from '../../components/ui';
import { platform } from '../../platform';
import type { RemoteHostAccessV1, RemoteHostV1 } from '../../shared/remote-hosts';
import { isRemoteSshTarget } from '../../shared/remote-ssh-target';

function AccessObservation({ access }: { access: RemoteHostAccessV1 }) {
  const checked = access.checkedAt ? new Date(access.checkedAt).toLocaleTimeString() : null;
  const verified = access.state === 'verified';
  return (
    <div className="space-y-1.5 text-xs sm:text-right" aria-live="polite">
      <p
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
          verified
            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
            : access.state === 'signing-in'
              ? 'bg-accent/10 text-accent'
              : 'bg-bg-muted text-fg-muted'
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full bg-current ${access.state === 'signing-in' ? 'animate-pulse' : ''}`}
        />
        {verified
          ? 'SSH access verified'
          : access.state === 'signing-in'
            ? 'Waiting for login in Terminal'
            : access.state === 'needs-authentication'
              ? 'SSH access needs authentication'
              : access.state === 'unavailable'
                ? 'SSH access unavailable'
                : 'SSH access not checked'}
      </p>
      {checked ? (
        <p
          className="text-fg-subtle"
          title="Last observed access; an expired session may need another login."
        >
          Checked at {checked}
        </p>
      ) : null}
    </div>
  );
}

interface ActionFeedback {
  readonly key: string;
  readonly action: 'terminal' | 'check' | 'end';
  readonly message: UserMessage;
  readonly failed?: boolean;
}

function HostIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-5 w-5"
    >
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </svg>
  );
}

export function RemoteHostsPanel({ initialTarget = '' }: { readonly initialTarget?: string }) {
  const api = platform().remoteHosts;
  const [hosts, setHosts] = useState<RemoteHostV1[]>([]);
  const [target, setTarget] = useState(initialTarget);
  const [name, setName] = useState('');
  const [error, setError] = useState<UserMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(Boolean(initialTarget));
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const [editing, setEditing] = useState<{ host: RemoteHostV1; name: string } | null>(null);
  const [forgetting, setForgetting] = useState<RemoteHostV1 | null>(null);
  const mounted = useRef(true);
  const readGeneration = useRef(0);
  const refresh = useCallback(async () => {
    if (!api) return;
    const generation = ++readGeneration.current;
    try {
      const next = await api.list();
      if (mounted.current && generation === readGeneration.current) {
        setHosts(next);
        setLoaded(true);
      }
    } catch (cause) {
      if (mounted.current && generation === readGeneration.current)
        setError(toUserMessage(cause, 'operation.failed'));
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2_000);
    return () => {
      mounted.current = false;
      readGeneration.current += 1;
      clearInterval(timer);
    };
  }, [refresh]);

  const perform = async <T,>(
    key: string,
    action: () => Promise<T>,
    notice?: {
      action: ActionFeedback['action'];
      pending: UserMessage;
      complete: (result: T) => UserMessage;
    }
  ) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    if (notice) setFeedback({ key, action: notice.action, message: notice.pending });
    try {
      const result = await action();
      if (mounted.current && notice)
        setFeedback({ key, action: notice.action, message: notice.complete(result) });
      if (mounted.current) await refresh();
    } catch (cause) {
      if (mounted.current) {
        if (notice)
          setFeedback({
            key,
            action: notice.action,
            message: toUserMessage(
              cause,
              notice.action === 'terminal'
                ? 'guidance.terminal-could-not-be-opened-check-that-a-supported-terminal-is-installed-then-try-again'
                : 'operation.failed'
            ),
            failed: true,
          });
        else setError(toUserMessage(cause, 'operation.failed'));
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const replace = (host: RemoteHostV1) => {
    readGeneration.current += 1;
    setHosts((current) => [
      ...current.filter((h) => h.profile.endpointId !== host.profile.endpointId),
      host,
    ]);
  };
  if (!api)
    return (
      <section className="p-8">
        <h1 className="text-2xl font-semibold">Remote hosts</h1>
        <p className="mt-3">Remote SSH hosts are available in the desktop app.</p>
      </section>
    );

  return (
    <section
      className="flex-1 overflow-auto bg-bg-subtle/30 p-5 sm:p-8"
      data-testid="remote-hosts-panel"
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-fg">Remote hosts</h1>
            <p className="mt-2 text-sm text-fg-muted">
              Sign in to your cluster or server here. Choose files and tracks later.
            </p>
          </div>
          {loaded && hosts.length > 0 ? (
            <Button disabled={Boolean(busy)} onClick={() => setAdding(!adding)}>
              {adding ? 'Cancel' : 'Add host'}
            </Button>
          ) : null}
        </header>
        <ol className={`${UI_CARD_CLASS} grid gap-4 text-sm sm:grid-cols-3`}>
          <li>
            <strong className="block text-fg">1. Save your host</strong>
            <span className="text-fg-muted">
              Use the SSH alias or user@host supplied by your institution.
            </span>
          </li>
          <li>
            <strong className="block text-fg">2. Sign in through Terminal</strong>
            <span className="text-fg-muted">
              Complete the normal password, Duo, phone approval or other required procedure there.
            </span>
          </li>
          <li>
            <strong className="block text-fg">3. Check access</strong>
            <span className="text-fg-muted">
              Return here to verify SSH. DNAForge handles reuse of this login for supported data
              actions.
            </span>
          </li>
        </ol>
        {navigator.platform.toLowerCase().startsWith('win') ? (
          <p className="rounded-lg border border-border bg-bg p-3 text-sm text-fg-muted">
            Windows sign-in uses OpenSSH in your default WSL Linux distribution. Complete your
            institution’s SSH setup there before signing in. DNAForge keeps using the selected
            distribution and account for this connection.
          </p>
        ) : null}
        {hosts.length === 0 || adding ? (
          <form
            className={`${UI_CARD_CLASS} space-y-3`}
            onSubmit={(event) => {
              event.preventDefault();
              void perform('save', async () => {
                const host = await api.save({
                  target: target.trim(),
                  displayName: name.trim() || target.trim(),
                });
                if (mounted.current) {
                  replace(host);
                  setTarget('');
                  setName('');
                  setAdding(false);
                }
              });
            }}
          >
            <h2 className="font-medium text-fg">Add a host</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-fg">
                SSH host
                <TextField
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="lab-hpc or user@login.example.edu"
                  autoComplete="off"
                  maxLength={255}
                  required
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-fg">
                Host name
                <TextField
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My lab cluster"
                  maxLength={200}
                />
              </label>
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={Boolean(busy) || !isRemoteSshTarget(target.trim())}
            >
              {busy === 'save' ? 'Saving…' : 'Save host'}
            </Button>
          </form>
        ) : null}
        {error ? (
          <div role="alert" className="rounded border border-danger/40 p-3 text-sm text-danger">
            {renderUserMessage(error)}
          </div>
        ) : null}
        {loaded && hosts.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No saved hosts yet. You can save a host before signing in.
          </p>
        ) : null}
        <div className="space-y-3">
          {hosts.length > 0 ? (
            <div className="flex items-center justify-between px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                Saved hosts
              </h2>
              <span className="text-xs text-fg-subtle">
                {hosts.length} {hosts.length === 1 ? 'host' : 'hosts'}
              </span>
            </div>
          ) : null}
          {hosts.map((host) => (
            <article
              key={host.profile.endpointId}
              className={`overflow-hidden rounded-md ${UI_SURFACE_CLASS}`}
              data-testid="remote-host-card"
              data-remote-host-id={host.profile.endpointId}
              aria-labelledby={`remote-host-name-${host.profile.endpointId}`}
            >
              <div className="space-y-4 p-4 sm:p-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-subtle text-accent">
                      <HostIcon />
                    </span>
                    <div className="min-w-0">
                      <h3
                        id={`remote-host-name-${host.profile.endpointId}`}
                        className="break-words text-base font-semibold text-fg"
                      >
                        {host.profile.displayName}
                      </h3>
                      <code className="mt-1 block break-all text-xs text-fg-muted">
                        {host.profile.target}
                      </code>
                    </div>
                  </div>
                  <AccessObservation access={host.access} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={Boolean(busy) || host.access.state === 'signing-in'}
                    onClick={() =>
                      void perform(
                        host.profile.endpointId,
                        async () => {
                          if (host.access.state === 'verified') {
                            await api.openTerminal(host.profile.target);
                          } else {
                            const access = await api.signIn(host.profile.target);
                            if (access.state === 'verified')
                              await api.openTerminal(host.profile.target);
                          }
                        },
                        {
                          action: 'terminal',
                          pending: userMessage('remote.terminalOpening'),
                          complete: () => userMessage('remote.terminalRequested'),
                        }
                      )
                    }
                  >
                    {busy === host.profile.endpointId && feedback?.action === 'terminal'
                      ? userMessage('remote.terminalOpening')
                      : host.access.state === 'signing-in'
                        ? 'Waiting for Terminal…'
                        : host.access.state === 'verified'
                          ? 'Open Terminal'
                          : 'Sign in through Terminal'}
                  </Button>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void perform(
                        host.profile.endpointId,
                        () => api.checkAccess(host.profile.target),
                        {
                          action: 'check',
                          pending: userMessage('remote.accessChecking'),
                          complete: (access) =>
                            access.state === 'verified'
                              ? userMessage('remote.accessChecked')
                              : toUserMessage(
                                  access.lastFailure?.message,
                                  'remote.signInThenCheck'
                                ),
                        }
                      )
                    }
                  >
                    {busy === host.profile.endpointId && feedback?.action === 'check'
                      ? 'Checking…'
                      : 'Check access'}
                  </Button>
                </div>
                {feedback?.key === host.profile.endpointId ? (
                  <p
                    role={feedback.failed ? 'alert' : 'status'}
                    className={`rounded-lg border px-3 py-2 text-sm ${feedback.failed ? 'border-danger/30 bg-danger/5 text-danger' : 'border-accent/20 bg-accent/5 text-fg'}`}
                  >
                    {renderUserMessage(feedback.message)}
                  </p>
                ) : null}
                {host.access.lastFailure &&
                (feedback?.key !== host.profile.endpointId ||
                  host.access.lastFailure.message !== feedback.message) ? (
                  <p className="text-sm text-fg-muted">
                    {toUserMessage(host.access.lastFailure.message, 'operation.failed')}
                  </p>
                ) : null}
                {host.access.state === 'signing-in' && feedback?.key !== host.profile.endpointId ? (
                  <p className="text-sm text-fg-muted">
                    Complete the login in Terminal, then return here and check access.
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-bg-subtle/50 px-4 py-2.5 sm:px-5">
                <p className="text-xs text-fg-subtle">
                  {host.access.activeConsumers > 0
                    ? `Used by ${host.access.activeConsumers} data connection(s)`
                    : host.access.connection === 'external'
                      ? 'Using your existing SSH connection'
                      : 'Files and computation are checked separately'}
                </p>
                <div className="flex flex-wrap items-center gap-1">
                  {host.access.connection === 'dnaforge' ? (
                    <Button
                      disabled={Boolean(busy) || host.access.activeConsumers > 0}
                      title={
                        host.access.activeConsumers > 0
                          ? 'Close file browsers and remote views before ending this connection.'
                          : undefined
                      }
                      onClick={() =>
                        void perform(
                          host.profile.endpointId,
                          () => api.endConnection(host.profile.target),
                          {
                            action: 'end',
                            pending: userMessage('remote.connectionClosing'),
                            complete: () => userMessage('remote.connectionEnded'),
                          }
                        )
                      }
                    >
                      {host.access.state === 'signing-in'
                        ? 'Cancel sign in'
                        : 'End DNAForge connection'}
                    </Button>
                  ) : null}
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setEditing({ host, name: host.profile.displayName });
                      setForgetting(null);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setForgetting(host);
                      setEditing(null);
                    }}
                  >
                    Forget
                  </Button>
                </div>
              </div>
              {editing?.host.profile.endpointId === host.profile.endpointId ? (
                <form
                  className="space-y-3 border-t border-border bg-bg-subtle p-4 sm:px-5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform('rename', async () => {
                      await api.rename(editing.host.profile.endpointId, editing.name);
                      if (mounted.current) setEditing(null);
                    });
                  }}
                >
                  <label className="flex flex-col gap-1 text-sm text-fg">
                    New host name
                    <TextField
                      autoFocus
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      required
                      maxLength={200}
                    />
                  </label>
                  <Button type="submit" disabled={Boolean(busy) || !editing.name.trim()}>
                    Save name
                  </Button>{' '}
                  <Button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : null}
              {forgetting?.profile.endpointId === host.profile.endpointId ? (
                <div className="space-y-3 border-t border-border bg-bg-subtle p-4 sm:px-5">
                  <p className="text-sm text-fg">
                    Forget {forgetting.profile.displayName}? This removes its saved name. Active
                    connections and saved tracks remain available.
                  </p>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void perform('forget', async () => {
                        await api.forget(forgetting.profile.endpointId);
                        if (mounted.current) setForgetting(null);
                      })
                    }
                  >
                    Forget saved host
                  </Button>{' '}
                  <Button onClick={() => setForgetting(null)}>Keep host</Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
        <details className="text-sm text-fg-muted">
          <summary className="cursor-pointer">
            Institution login procedures and connection reuse
          </summary>
          <p className="mt-2">
            Run institution-required setup, VPN, certificate renewal or browser sign-in before
            connecting. DNAForge uses your normal system OpenSSH configuration and opens Terminal
            for all interactive prompts. Passwords and verification codes stay there.
          </p>
          <p className="mt-2">
            This login creates a private OpenSSH connection for DNAForge. You do not need to edit
            connection-sharing settings. Closing this screen or a file picker keeps the host
            connection. After the last SSH channel closes, an idle connection may expire after ten
            minutes; institution limits can end it sooner. Quit DNAForge or use End DNAForge
            connection to close its connection. Independently owned terminal connections stay open.
          </p>
          <p className="mt-2">
            An ordinary terminal login opened without sharing cannot be borrowed afterward. Use Sign
            in through Terminal here to establish a reusable connection. If your institution forbids
            connection sharing or remote command channels, follow its supported workflow; those
            restrictions cannot be bypassed by this screen. On Windows, DNAForge uses OpenSSH in WSL
            because the built-in Windows client does not support reusable control sockets.
          </p>
        </details>
      </div>
    </section>
  );
}
