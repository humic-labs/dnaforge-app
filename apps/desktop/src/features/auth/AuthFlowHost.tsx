import { toUserMessage, userMessage, renderUserMessagePayload } from '@waypoint/user-messages';
import { Button, TextField } from '../../components/ui';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { SpinnerIcon } from '../../components/icons/glyphs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthFlowHost() {
  const state = useAuthStore((s) => s.state);
  const cancelSignIn = useAuthStore((s) => s.cancelSignIn);
  const reopenSignIn = useAuthStore((s) => s.reopenSignIn);
  const chooseOAuth = useAuthStore((s) => s.chooseOAuth);
  const chooseSso = useAuthStore((s) => s.chooseSso);
  const startEmailSignIn = useAuthStore((s) => s.startEmailSignIn);
  const submitEmailCode = useAuthStore((s) => s.submitEmailCode);

  const [email, setEmail] = useState('');
  const [ssoEmail, setSsoEmail] = useState('');
  const [ssoMode, setSsoMode] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState<'google' | 'github' | 'sso' | null>(null);

  useEffect(() => {
    if (state.status === 'choosing') {
      setEmail('');
      setSsoEmail('');
      setSsoMode(false);
      setSsoError(null);
      setCode('');
      setSending(false);
      setConnecting(null);
    }
    if (state.status === 'email-sent') setSending(false);
    if (state.status !== 'choosing') setConnecting(null);
  }, [state.status]);

  const pickProvider = (provider: 'google' | 'github') => {
    setConnecting(provider);
    void Promise.resolve(chooseOAuth(provider)).finally(() => {
      if (useAuthStore.getState().state.status === 'choosing') setConnecting(null);
    });
  };

  const startSso = () => {
    const trimmed = ssoEmail.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setSsoError(userMessage('failure.enter-a-valid-organization-email'));
      return;
    }
    setSsoError(null);
    setConnecting('sso');
    void Promise.resolve(chooseSso(trimmed)).finally(() => {
      if (useAuthStore.getState().state.status === 'choosing') setConnecting(null);
    });
  };

  const inFlow =
    state.status === 'starting' ||
    state.status === 'choosing' ||
    state.status === 'email-sent' ||
    state.status === 'awaiting-confirmation' ||
    state.status === 'exchanging';
  if (!inFlow) return null;

  const heading =
    state.status === 'exchanging'
      ? 'Completing…'
      : state.status === 'email-sent'
        ? 'Check your email'
        : 'Continue to DNAForge';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      data-testid="auth-flow-host"
    >
      <div className="flex max-h-[min(90vh,640px)] min-h-[400px] w-[360px] flex-col overflow-y-auto rounded-xl border border-border bg-bg p-6 shadow-xl">
        <h2 className="text-base font-semibold text-fg">{heading}</h2>

        <div className="mt-4 flex flex-1 flex-col">
          {state.status === 'starting' && (
            <div className="flex flex-1 items-center justify-center" data-testid="auth-starting">
              <SpinnerIcon className="h-6 w-6" />
            </div>
          )}

          {state.status === 'choosing' && connecting && (
            <div className="flex flex-1 items-center justify-center" data-testid="auth-connecting">
              <div className="flex flex-col items-center gap-3 text-sm text-fg-muted">
                <SpinnerIcon className="h-6 w-6" />
                <span>
                  Opening{' '}
                  {connecting === 'google'
                    ? 'Google'
                    : connecting === 'github'
                      ? 'GitHub'
                      : "your organization's login page"}{' '}
                  in your browser…
                </span>
              </div>
            </div>
          )}

          {state.status === 'choosing' && !connecting && (
            <div className="flex flex-col gap-3">
              <Button
                type="button"
                onClick={() => void pickProvider('google')}
                data-testid="auth-google"
                aria-label="Continue with Google"
              >
                <span className="flex items-center justify-center gap-2.5">
                  <GoogleMark className="h-4 w-4 shrink-0" />
                  Continue with Google
                </span>
              </Button>
              <Button
                type="button"
                onClick={() => void pickProvider('github')}
                data-testid="auth-github"
                aria-label="Continue with GitHub"
              >
                <span className="flex items-center justify-center gap-2.5">
                  <GitHubMark className="h-4 w-4 shrink-0" />
                  Continue with GitHub
                </span>
              </Button>

              {!ssoMode ? (
                <Button type="button" onClick={() => setSsoMode(true)} data-testid="auth-sso">
                  Continue with organization SSO
                </Button>
              ) : (
                <div className="flex flex-col gap-2" data-testid="auth-sso-input">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs uppercase tracking-wide text-fg-muted">
                      Organization email
                    </span>
                    <TextField
                      type="email"
                      value={ssoEmail}
                      onChange={(e) => setSsoEmail(e.target.value)}
                      placeholder="you@example.com"
                      data-testid="auth-sso-email"
                    />
                  </label>
                  {ssoError && (
                    <p className="text-xs text-error" role="alert" data-testid="auth-sso-error">
                      {toUserMessage(ssoError, 'account.failed')}
                    </p>
                  )}
                  <Button
                    variant="primary"
                    type="button"
                    disabled={!EMAIL_RE.test(ssoEmail.trim())}
                    onClick={() => startSso()}
                    data-testid="auth-sso-submit"
                  >
                    Continue with SSO
                  </Button>
                </div>
              )}

              <div className="my-1 flex items-center gap-3 text-[10px] uppercase tracking-wide text-fg-muted">
                <span className="h-px flex-1 bg-border" /> or{' '}
                <span className="h-px flex-1 bg-border" />
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-wide text-fg-muted">
                  Email me a code
                </span>
                <TextField
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  data-testid="auth-email-input"
                />
              </label>
              <Button
                type="button"
                disabled={sending || !EMAIL_RE.test(email.trim())}
                onClick={() => {
                  setSending(true);
                  void Promise.resolve(startEmailSignIn(email.trim())).finally(() => {
                    if (useAuthStore.getState().state.status === 'choosing') setSending(false);
                  });
                }}
                data-testid="auth-email-submit"
              >
                {sending ? 'Sending…' : 'Email me a code'}
              </Button>
              {state.error && !sending && (
                <p className="text-xs text-error" role="alert" data-testid="auth-email-start-error">
                  {state.errorMessagePayload
                    ? renderUserMessagePayload(state.errorMessagePayload)
                    : toUserMessage(state.error, 'account.failed')}
                </p>
              )}
            </div>
          )}

          {state.status === 'email-sent' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg-muted">
                Enter the 6-digit code we emailed to{' '}
                <span className="font-medium text-fg">{state.email}</span>.
              </p>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                name="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="— — — — — —"
                data-testid="auth-code-input"
                className="rounded-md border border-border bg-bg-muted px-3 py-2 text-center font-mono text-2xl tracking-[0.3em] text-fg placeholder:text-fg-muted placeholder:tracking-normal focus:border-accent focus:outline-none"
              />
              {state.error && (
                <p className="text-xs text-error" role="alert" data-testid="auth-email-error">
                  {state.errorMessagePayload
                    ? renderUserMessagePayload(state.errorMessagePayload)
                    : toUserMessage(state.error, 'account.failed')}
                </p>
              )}
              <Button
                variant="primary"
                type="button"
                disabled={code.length !== 6}
                onClick={() => void submitEmailCode(code)}
                data-testid="auth-code-submit"
              >
                Verify
              </Button>
              <p className="text-xs text-fg-muted" data-testid="auth-resend-hint">
                Didn&apos;t get it? You can request a new code 60 seconds after the last one.{' '}
                <button
                  type="button"
                  onClick={() => void startEmailSignIn(state.email)}
                  data-testid="auth-resend"
                  className="text-fg-muted underline underline-offset-2 hover:text-fg"
                >
                  Resend code
                </button>
              </p>
            </div>
          )}

          {state.status === 'awaiting-confirmation' && (
            <div className="flex flex-col" data-testid="auth-awaiting-confirmation">
              <p className="text-sm text-fg-muted">
                Continue in your web browser — this window will update automatically once you
                finish. Keep DNAForge open and do not click Cancel until the browser returns.
              </p>
              {state.browserOpenFailed && (
                <p className="mt-3 text-xs text-warning" data-testid="auth-browser-open-failed">
                  We couldn&apos;t open your browser automatically. Click &ldquo;Open browser
                  again&rdquo;.
                </p>
              )}
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => void reopenSignIn()}
                  data-testid="auth-open-browser"
                  className="text-sm text-fg-muted hover:text-fg"
                >
                  Open browser again
                </button>
              </div>
            </div>
          )}

          {state.status === 'exchanging' && (
            <p className="text-sm text-fg-muted">Finishing up — one moment.</p>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <Button type="button" onClick={() => void cancelSignIn()} data-testid="auth-cancel">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M15.68 8.18c0-.57-.05-1.12-.15-1.64H8v3.1h4.31a3.68 3.68 0 01-1.6 2.42v2.01h2.59c1.51-1.4 2.38-3.45 2.38-5.89z"
        fill="#4285F4"
      />
      <path
        d="M8 16c2.16 0 3.97-.72 5.3-1.94l-2.59-2.01c-.72.48-1.63.76-2.71.76-2.09 0-3.86-1.41-4.49-3.31H.84v2.07A8 8 0 008 16z"
        fill="#34A853"
      />
      <path
        d="M3.51 9.5c-.16-.48-.25-.99-.25-1.5s.09-1.02.25-1.5V4.43H.84A8 8 0 000 8c0 1.29.31 2.51.84 3.57L3.51 9.5z"
        fill="#FBBC05"
      />
      <path
        d="M8 3.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3C11.97.79 10.16 0 8 0A8 8 0 00.84 4.43L3.51 6.5C4.14 4.59 5.91 3.18 8 3.18z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
