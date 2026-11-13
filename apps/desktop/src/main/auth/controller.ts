import { UserMessagePayload, userMessage } from '@waypoint/user-messages';
import { shell } from 'electron';
import { hostname } from 'node:os';
import { reportOperationalFailure } from '../sentry';
import type { DesktopAuthState as AuthState } from '../../shared/auth-types';
import { getAuthChannel, getRedirectScheme } from './auth-config';
import {
  createPendingFlow,
  getPendingFlow,
  clearPendingFlow,
  clearAllPendingFlows,
  writeMarker,
  deleteMarker,
  gcMarkers,
  parseCallbackUrl,
} from './protocol';
import * as client from './client';
import { startLoopback, type LoopbackListener } from './loopback';
import { parseSignInUrl, type SignInUrl } from './sign-in-url';
import { materializeRendererAvatar } from './materialize-avatar';
import {
  saveSession,
  getActiveStoredSession,
  getActivePublicSession,
  updateSessionTokens,
  updateSessionProfile,
  removeSession,
  getAllStoredSessions,
  clearAllSessions,
  type StoredSession,
  type PublicSession,
} from './session-store';

type Listener = (state: AuthState) => void;

const listeners = new Set<Listener>();
let lastState: AuthState = { status: 'signed-out' };
let focusMainWindow: () => void = () => {};
type SignInPhase =
  | 'starting'
  | 'choosing'
  | 'opening-provider'
  | 'awaiting-confirmation'
  | 'sending-email'
  | 'email-sent'
  | 'exchanging'
  | 'persisting'
  | 'closed';

interface SignInAttempt {
  phase: SignInPhase;
  flowNonce: string | null;
  signInUrl: SignInUrl | null;
  browserOpenFailed: boolean;
  email: string | null;
  emailAttemptId: string | null;
  loopback: LoopbackListener | null;
  persistence: { session: StoredSession; completion: Promise<void> } | null;
}

const signInTransitions: Record<SignInPhase, readonly SignInPhase[]> = {
  starting: ['choosing'],
  choosing: ['opening-provider', 'sending-email', 'exchanging'],
  'opening-provider': ['awaiting-confirmation', 'choosing'],
  'awaiting-confirmation': ['exchanging'],
  'sending-email': ['email-sent', 'choosing'],
  'email-sent': ['sending-email', 'exchanging'],
  exchanging: ['email-sent', 'persisting'],
  persisting: [],
  closed: [],
};

let activeAttempt: SignInAttempt | null = null;
let sessionEpoch = 0;
let profileOperation: object | null = null;

function ownsAttempt(attempt: SignInAttempt | null): attempt is SignInAttempt {
  return attempt !== null && activeAttempt === attempt && attempt.phase !== 'closed';
}

function transitionAttempt(
  attempt: SignInAttempt | null,
  next: SignInPhase
): attempt is SignInAttempt {
  if (!ownsAttempt(attempt) || !signInTransitions[attempt.phase].includes(next)) return false;
  attempt.phase = next;
  return true;
}

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 20 * 1000;

const ACCESS_REFRESH_LEAD_MS = 5 * 60 * 1000;
const REFRESH_RETRY_MS = 60 * 1000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export type DesktopAuthRefreshOutcome =
  | { status: 'refreshed' }
  | {
      status: 'transient';
      code: 'NETWORK' | 'RATE_LIMITED' | 'SERVER';
      message: string;
    }
  | { status: 'signed_out' };

let refreshInFlight: Promise<DesktopAuthRefreshOutcome> | null = null;

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(accessTokenExpiresAtIso: string): void {
  clearRefreshTimer();
  const expiresAt = Date.parse(accessTokenExpiresAtIso);
  const delay = Number.isFinite(expiresAt)
    ? Math.max(0, expiresAt - Date.now() - ACCESS_REFRESH_LEAD_MS)
    : ACCESS_REFRESH_LEAD_MS;
  refreshTimer = setTimeout(() => void performRefresh(), delay);
}

export async function performRefresh(): Promise<DesktopAuthRefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<DesktopAuthRefreshOutcome> {
  const epoch = sessionEpoch;
  const session = await getActiveStoredSession();
  if (epoch !== sessionEpoch) return { status: 'signed_out' };
  if (!session) {
    clearRefreshTimer();
    return { status: 'signed_out' };
  }

  let result;
  try {
    result = await client.refresh(session.refreshToken);
  } catch (error) {
    if (epoch !== sessionEpoch) return { status: 'signed_out' };
    clearRefreshTimer();
    refreshTimer = setTimeout(() => void performRefresh(), REFRESH_RETRY_MS);
    return {
      status: 'transient',
      code: 'NETWORK',
      message: error instanceof Error ? error.message : 'Authentication refresh is offline.',
    };
  }

  if (epoch !== sessionEpoch) return { status: 'signed_out' };
  if (result.ok) {
    const updated = await updateSessionTokens(session.accountId, {
      accessToken: result.tokens.accessToken,
      accessTokenExpiresAt: result.tokens.expiresAt,
      refreshToken: result.tokens.refreshToken,
      expectedSessionId: session.desktopSessionId,
      expectedRefreshToken: session.refreshToken,
    });
    if (updated === false || epoch !== sessionEpoch) return { status: 'signed_out' };
    const pub = await getActivePublicSession();
    if (epoch !== sessionEpoch) return { status: 'signed_out' };
    if (pub) emit({ status: 'signed-in', session: pub });
    scheduleRefresh(result.tokens.expiresAt);
    return { status: 'refreshed' };
  }

  if (result.status >= 500 || result.status === 429 || result.status === 0) {
    clearRefreshTimer();
    refreshTimer = setTimeout(() => void performRefresh(), REFRESH_RETRY_MS);
    return {
      status: 'transient',
      code: result.status === 429 ? 'RATE_LIMITED' : result.status === 0 ? 'NETWORK' : 'SERVER',
      message: result.error,
    };
  }

  const reason = result.error.toLowerCase();
  if (reason.includes('revoked') || reason.includes('reuse')) {
    await endSession(session, 'Signed out elsewhere — sign in again.');
  } else if (reason.includes('expired')) {
    await endSession(session, 'Your session expired — sign in again.');
  } else {
    await endSession(session, 'Signed out — please sign in again.');
  }
  return { status: 'signed_out' };
}

async function endSession(session: StoredSession, message: string): Promise<void> {
  const epoch = ++sessionEpoch;
  profileOperation = null;
  clearRefreshTimer();
  await removeSession(session.accountId, session.desktopSessionId);
  if (epoch !== sessionEpoch || activeAttempt) return;
  emit({ status: 'error', reason: 'session_ended', message });
  const pub = await getActivePublicSession();
  if (epoch !== sessionEpoch || activeAttempt) return;
  emit(pub ? { status: 'signed-in', session: pub } : { status: 'signed-out' });
}

export function subscribeAuthState(cb: Listener): () => void {
  listeners.add(cb);
  cb(lastState);
  return () => listeners.delete(cb);
}

export function setMainWindowFocuser(fn: () => void): void {
  focusMainWindow = fn;
}

function emit(state: AuthState): void {
  lastState = state;
  for (const l of listeners) {
    try {
      l(state);
    } catch {}
  }
}

export function getAuthState(): AuthState {
  return lastState;
}

async function openValidatedSignInUrl(attempt: SignInAttempt, url: SignInUrl): Promise<void> {
  attempt.signInUrl = url;
  attempt.browserOpenFailed = false;
  try {
    await shell.openExternal(url);
  } catch {
    attempt.browserOpenFailed = true;
  }
}

async function cleanupFlow(preserveSession = false): Promise<void> {
  const attempt = activeAttempt;
  if (!attempt) return;
  activeAttempt = null;
  attempt.phase = 'closed';
  attempt.loopback?.close();
  attempt.loopback = null;
  if (attempt.flowNonce) {
    clearPendingFlow(attempt.flowNonce);
    void deleteMarker(attempt.flowNonce);
  }
  if (!preserveSession && attempt.persistence) {
    await attempt.persistence.completion.catch(() => {});
    await removeSession(
      attempt.persistence.session.accountId,
      attempt.persistence.session.desktopSessionId
    );
  }
}

export interface StartResult {
  ok: boolean;
  reason?: string;
}

export async function startSignIn(): Promise<StartResult> {
  const previous = cleanupFlow();
  const attempt: SignInAttempt = {
    phase: 'starting',
    flowNonce: null,
    signInUrl: null,
    browserOpenFailed: false,
    email: null,
    emailAttemptId: null,
    loopback: null,
    persistence: null,
  };
  activeAttempt = attempt;
  clearAllPendingFlows();
  await previous;
  await gcMarkers();
  if (!ownsAttempt(attempt)) return { ok: false, reason: 'cancelled' };
  emit({ status: 'starting' });

  const channel = getAuthChannel();
  const flow = createPendingFlow(channel);
  attempt.flowNonce = flow.flowNonce;
  await writeMarker(flow);
  if (!ownsAttempt(attempt)) {
    await deleteMarker(flow.flowNonce);
    return { ok: false, reason: 'cancelled' };
  }

  let started;
  try {
    started = await client.startFlow({
      flowNonce: flow.flowNonce,
      challenge: flow.challenge,
      pollSecretHash: flow.pollSecretHash,
      deviceName: safeHostname(),
      devicePlatform: process.platform,
      installChannel: channel,
      redirectScheme: getRedirectScheme(channel),
    });
  } catch (err) {
    if (!ownsAttempt(attempt)) return { ok: false, reason: 'cancelled' };
    void cleanupFlow();
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      (typeof err === 'object' &&
        err !== null &&
        'name' in err &&
        (err as { name?: unknown }).name === 'AbortError');
    emit({
      status: 'error',
      reason: 'network',
      message: aborted ? 'Sign-in timed out. Try again.' : 'Could not reach the sign-in service.',
    });
    return { ok: false, reason: 'network' };
  }
  if (!ownsAttempt(attempt)) return { ok: false, reason: 'cancelled' };
  if (!started.ok) {
    cleanupFlow();
    const flagOff = started.status === 404;
    if (flagOff) {
      console.warn(
        '[Auth] Sign-in disabled by the web server (the desktop-signin feature gate is off). ' +
          'Enable it in the analytics feature flags; in local dev, run the web app without ' +
          'the analytics key so the gate fails open.'
      );
    }
    emit({
      status: 'error',
      reason: 'start_failed',
      message: flagOff
        ? 'Sign-in is temporarily unavailable. Please try again in a little while.'
        : 'Could not start sign-in. Try again.',
    });
    return { ok: false, reason: 'start_failed' };
  }

  if (!transitionAttempt(attempt, 'choosing')) return { ok: false, reason: 'cancelled' };
  emit({ status: 'choosing' });
  return { ok: true };
}

export async function chooseOAuth(provider?: string): Promise<void> {
  const attempt = activeAttempt;
  if (provider !== 'google' && provider !== 'github') {
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: 'Unsupported sign-in provider.',
    });
    return;
  }
  if (!ownsAttempt(attempt) || !attempt.flowNonce) {
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: 'Sign-in expired. Start again.',
    });
    return;
  }
  if (attempt.phase !== 'choosing') {
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: 'A sign-in is already in progress. Cancel and try again.',
    });
    return;
  }
  const flowNonce = attempt.flowNonce;
  const flow = getPendingFlow(flowNonce);
  if (!flow) {
    emit({ status: 'error', reason: 'oauth_failed', message: 'Sign-in expired. Start again.' });
    return;
  }

  if (!transitionAttempt(attempt, 'opening-provider')) return;
  let lb;
  try {
    lb = await startLoopback(flowNonce);
  } catch {
    if (!ownsAttempt(attempt)) return;
    transitionAttempt(attempt, 'choosing');
    emit({
      status: 'error',
      reason: 'loopback_failed',
      message: 'Could not start sign-in. Try again.',
    });
    return;
  }
  if (!ownsAttempt(attempt)) {
    lb.close();
    return;
  }
  attempt.loopback = lb;

  let res;
  try {
    res = await client.oauthUrl(flowNonce, provider, lb.redirectUri, flow.pollSecret);
  } catch {
    lb.close();
    if (!ownsAttempt(attempt)) return;
    transitionAttempt(attempt, 'choosing');
    attempt.loopback = null;
    emit({ status: 'error', reason: 'network', message: 'Could not reach the sign-in service.' });
    return;
  }
  if (!ownsAttempt(attempt)) {
    lb.close();
    return;
  }
  if (!res.ok || !res.url) {
    transitionAttempt(attempt, 'choosing');
    lb.close();
    attempt.loopback = null;
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: userMessage('auth.guidance.13'),
    });
    return;
  }

  const signInUrl = parseSignInUrl(res.url);
  if (!signInUrl) {
    transitionAttempt(attempt, 'choosing');
    lb.close();
    attempt.loopback = null;
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: 'The sign-in service returned an unsafe destination. Try again.',
    });
    return;
  }
  await openValidatedSignInUrl(attempt, signInUrl);
  if (!transitionAttempt(attempt, 'awaiting-confirmation')) return;
  emit({
    status: 'awaiting-confirmation',
    browserOpenFailed: attempt.browserOpenFailed,
    providerUrl: signInUrl,
  });

  const timeout = setTimeout(() => {
    if (ownsAttempt(attempt) && attempt.loopback === lb) {
      cleanupFlow();
      emit({ status: 'error', reason: 'timeout', message: 'Sign-in timed out. Start again.' });
    }
  }, FLOW_TIMEOUT_MS);

  void lb.waitForCallback.then((cb) => {
    clearTimeout(timeout);
    lb.close();
    if (
      !ownsAttempt(attempt) ||
      attempt.loopback !== lb ||
      attempt.phase !== 'awaiting-confirmation'
    )
      return;
    attempt.loopback = null;
    if (cb.error || !cb.code) {
      cleanupFlow();
      emit({ status: 'error', reason: 'oauth_failed', message: oauthErrorMessage(cb.error) });
      return;
    }
    return completeAuthCode(cb.code, cb.flowNonce);
  });
}

export async function chooseSso(email?: string): Promise<void> {
  const attempt = activeAttempt;
  const trimmed = typeof email === 'string' ? email.trim() : '';
  if (!trimmed || !trimmed.includes('@')) {
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: 'Enter your organization email to continue with SSO.',
    });
    return;
  }
  if (!ownsAttempt(attempt) || !attempt.flowNonce) {
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: 'Sign-in expired. Start again.',
    });
    return;
  }
  if (attempt.phase !== 'choosing') {
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: 'A sign-in is already in progress. Cancel and try again.',
    });
    return;
  }
  const flowNonce = attempt.flowNonce;
  const flow = getPendingFlow(flowNonce);
  if (!flow) {
    emit({ status: 'error', reason: 'oauth_failed', message: 'Sign-in expired. Start again.' });
    return;
  }

  if (!transitionAttempt(attempt, 'opening-provider')) return;
  let lb;
  try {
    lb = await startLoopback(flowNonce);
  } catch {
    if (!ownsAttempt(attempt)) return;
    transitionAttempt(attempt, 'choosing');
    emit({
      status: 'error',
      reason: 'loopback_failed',
      message: 'Could not start sign-in. Try again.',
    });
    return;
  }
  if (!ownsAttempt(attempt)) {
    lb.close();
    return;
  }
  attempt.loopback = lb;

  let res;
  try {
    res = await client.ssoUrl(flowNonce, trimmed, lb.redirectUri, flow.pollSecret);
  } catch {
    lb.close();
    if (!ownsAttempt(attempt)) return;
    transitionAttempt(attempt, 'choosing');
    attempt.loopback = null;
    emit({ status: 'error', reason: 'network', message: 'Could not reach the sign-in service.' });
    return;
  }
  if (!ownsAttempt(attempt)) {
    lb.close();
    return;
  }
  if (!res.ok || !res.url) {
    transitionAttempt(attempt, 'choosing');
    lb.close();
    attempt.loopback = null;
    const msg =
      res.error === 'SSO_DOMAIN_UNKNOWN'
        ? 'No SSO is configured for that email domain. Try Google or GitHub.'
        : `Could not start organization SSO (HTTP ${res.status}). Try again.`;
    emit({ status: 'error', reason: 'oauth_failed', message: msg });
    return;
  }

  const signInUrl = parseSignInUrl(res.url);
  if (!signInUrl) {
    transitionAttempt(attempt, 'choosing');
    lb.close();
    attempt.loopback = null;
    emit({
      status: 'error',
      reason: 'oauth_failed',
      message: 'The sign-in service returned an unsafe destination. Try again.',
    });
    return;
  }
  await openValidatedSignInUrl(attempt, signInUrl);
  if (!transitionAttempt(attempt, 'awaiting-confirmation')) return;
  emit({
    status: 'awaiting-confirmation',
    browserOpenFailed: attempt.browserOpenFailed,
    providerUrl: signInUrl,
  });

  const timeout = setTimeout(() => {
    if (ownsAttempt(attempt) && attempt.loopback === lb) {
      cleanupFlow();
      emit({ status: 'error', reason: 'timeout', message: 'Sign-in timed out. Start again.' });
    }
  }, FLOW_TIMEOUT_MS);

  void lb.waitForCallback.then((cb) => {
    clearTimeout(timeout);
    lb.close();
    if (
      !ownsAttempt(attempt) ||
      attempt.loopback !== lb ||
      attempt.phase !== 'awaiting-confirmation'
    )
      return;
    attempt.loopback = null;
    if (cb.error || !cb.code) {
      cleanupFlow();
      emit({ status: 'error', reason: 'oauth_failed', message: oauthErrorMessage(cb.error) });
      return;
    }
    return completeAuthCode(cb.code, cb.flowNonce);
  });
}

function oauthErrorMessage(reason?: string): string {
  switch (reason) {
    case 'provider_denied':
    case 'sso_idp_denied':
      return 'Sign-in was cancelled or denied. Try again.';
    case 'disabled':
    case 'sso_disabled':
      return 'Sign-in is not available right now.';
    case 'sso_collision':
      return 'This email is already used with another sign-in method. Try Google, GitHub, or email.';
    case 'sso_org_mismatch':
      return 'Your organization could not be verified. Try another sign-in method.';
    case 'sso_flow_gone':
    case 'sso_state_replay':
      return 'Sign-in expired. Start again.';
    case 'sso_upstream':
    case 'sso_unavailable':
      return 'Organization sign-in is temporarily unavailable. Try Google, GitHub, or email.';
    case 'no_code':
    case 'no_pending':
    case 'exchange_failed':
      return 'Sign-in could not be completed. Please try again.';
    case 'link_failed':
    case 'confirm_failed':
      return 'Could not finish signing in. Please try again.';
    default:
      return 'Sign-in did not complete. Please try again.';
  }
}

export async function startEmailSignIn(email: string): Promise<void> {
  const attempt = activeAttempt;
  if (!ownsAttempt(attempt) || !attempt.flowNonce) return;
  if (!transitionAttempt(attempt, 'sending-email')) return;
  const resending = lastState.status === 'email-sent' && lastState.email === email;
  const showSendFailure = (message: string, errorMessagePayload?: UserMessagePayload) => {
    if (!transitionAttempt(attempt, resending ? 'email-sent' : 'choosing')) return;
    emit(
      resending
        ? {
            status: 'email-sent',
            email,
            error: message,
            ...(errorMessagePayload ? { errorMessagePayload } : {}),
          }
        : {
            status: 'choosing',
            error: message,
            ...(errorMessagePayload ? { errorMessagePayload } : {}),
          }
    );
  };
  let res;
  try {
    res = await client.emailStart(attempt.flowNonce, email);
  } catch {
    showSendFailure('Could not reach the sign-in service. Try again.');
    return;
  }
  if (!ownsAttempt(attempt)) return;
  if (!res.ok) {
    if (res.error === 'FLOW_INVALID') {
      cleanupFlow();
      emit({
        status: 'error',
        reason: 'expired',
        message: 'Sign-in request expired. Start again.',
      });
      return;
    }
    showSendFailure(client.emailStartFailureMessage(res), client.emailStartFailurePayload(res));
    return;
  }
  if (!transitionAttempt(attempt, 'email-sent')) return;
  attempt.email = email;
  attempt.emailAttemptId = res.attemptId ?? null;
  emit({ status: 'email-sent', email });
}

export async function submitEmailCode(code: string): Promise<void> {
  const attempt = activeAttempt;
  if (!ownsAttempt(attempt) || !attempt.flowNonce || !attempt.email) return;
  if (!transitionAttempt(attempt, 'exchanging')) return;
  const flow = getPendingFlow(attempt.flowNonce);
  if (!flow) {
    emit({ status: 'error', reason: 'expired', message: 'Sign-in request expired. Start again.' });
    return;
  }
  const email = attempt.email;
  emit({ status: 'exchanging' });
  let result;
  try {
    result = await client.emailVerify({
      flowNonce: flow.flowNonce,
      email,
      code,
      verifier: flow.verifier,
      ...(attempt.emailAttemptId ? { attemptId: attempt.emailAttemptId } : {}),
    });
  } catch {
    if (!transitionAttempt(attempt, 'email-sent')) return;
    emit({ status: 'email-sent', email, error: 'Network error. Try again.' });
    return;
  }
  if (!ownsAttempt(attempt)) return;
  if (!result.ok) {
    if (!transitionAttempt(attempt, 'email-sent')) return;
    emit({ status: 'email-sent', email, error: 'That code is invalid or expired. Try again.' });
    return;
  }
  await completeWithTokens(attempt, result.tokens, flow.channel);
}

async function completeWithTokens(
  attempt: SignInAttempt,
  tokens: client.TokenBundle,
  channel: string
): Promise<void> {
  if (!transitionAttempt(attempt, 'persisting')) return;
  const session: StoredSession = {
    accountId: tokens.accountId,
    desktopSessionId: tokens.desktopSessionId,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt,
    refreshToken: tokens.refreshToken,
    email: tokens.email,
    displayName: tokens.displayName ?? null,
    avatarUrl: await materializeRendererAvatar(tokens.avatarUrl),
    meaningfulActivityAuthority: tokens.meaningfulActivityAuthority,
    channel,
    updatedAt: Date.now(),
  };
  if (!ownsAttempt(attempt)) return;
  try {
    attempt.persistence = {
      session,
      completion: saveSession(session, true, () => ownsAttempt(attempt)),
    };
    await attempt.persistence.completion;
  } catch {
    if (!ownsAttempt(attempt)) return;
    void cleanupFlow();
    emit({ status: 'unavailable', reason: 'encryption_unavailable' });
    return;
  }
  if (!ownsAttempt(attempt)) return;
  const pub = await getActivePublicSession();
  if (!ownsAttempt(attempt)) return;
  sessionEpoch += 1;
  void cleanupFlow(true);
  if (pub) emit({ status: 'signed-in', session: pub, justSignedIn: true });
  scheduleRefresh(session.accessTokenExpiresAt);
}

export async function reopenSignIn(): Promise<void> {
  const attempt = activeAttempt;
  if (!ownsAttempt(attempt) || attempt.phase !== 'awaiting-confirmation' || !attempt.signInUrl)
    return;
  await openValidatedSignInUrl(attempt, attempt.signInUrl);
  if (ownsAttempt(attempt) && lastState.status === 'awaiting-confirmation') {
    emit({ ...lastState, browserOpenFailed: attempt.browserOpenFailed });
  }
}

async function completeAuthCode(code: string, flowNonce: string): Promise<void> {
  const attempt = activeAttempt;
  const flow = getPendingFlow(flowNonce);
  if (!flow || !ownsAttempt(attempt) || attempt.flowNonce !== flowNonce) {
    reportOperationalFailure('auth.suspicious_cold_link', {
      level: 'warning',
      extra: { channel: getAuthChannel() },
    });
    return;
  }

  if (!transitionAttempt(attempt, 'exchanging')) return;
  focusMainWindow();
  emit({ status: 'exchanging' });

  const channel = flow.channel;
  let result;
  let exchangeTimer: ReturnType<typeof setTimeout> | undefined;
  const exchangePromise = client.exchange({ code, verifier: flow.verifier, flowNonce });
  exchangePromise.catch(() => {});
  try {
    result = await Promise.race([
      exchangePromise,
      new Promise<never>((_resolve, reject) => {
        exchangeTimer = setTimeout(
          () => reject(new Error('exchange_timeout')),
          EXCHANGE_TIMEOUT_MS
        );
      }),
    ]);
  } catch {
    if (!ownsAttempt(attempt)) return;
    void cleanupFlow();
    emit({ status: 'error', reason: 'network', message: 'Could not complete sign-in (network).' });
    return;
  } finally {
    if (exchangeTimer) clearTimeout(exchangeTimer);
  }

  if (!ownsAttempt(attempt)) return;
  if (!result.ok) {
    void cleanupFlow();
    emit({ status: 'error', reason: result.error, message: 'Sign-in could not be completed.' });
    return;
  }
  await completeWithTokens(attempt, result.tokens, channel);
}

export async function handleCallback(url: string): Promise<void> {
  const parsed = parseCallbackUrl(url);
  if (!parsed) return;
  await completeAuthCode(parsed.code, parsed.flowNonce);
}

export async function cancelSignIn(): Promise<void> {
  const attempt = activeAttempt;
  const cleanup = cleanupFlow();
  clearAllPendingFlows();
  await cleanup;
  await gcMarkers();
  const pub = await getActivePublicSession();
  if (activeAttempt && activeAttempt !== attempt) return;
  emit(pub ? { status: 'signed-in', session: pub } : { status: 'signed-out' });
}

export async function signOut(accountId?: string): Promise<void> {
  const epoch = ++sessionEpoch;
  profileOperation = null;
  await cleanupFlow();
  clearRefreshTimer();
  if (accountId) {
    const active = await getActiveStoredSession();
    await removeSession(
      accountId,
      active?.accountId === accountId ? active.desktopSessionId : undefined
    );
    if (active && accountId === active.accountId) {
      await client.revoke(active.accessToken, active.desktopSessionId).catch(() => false);
    }
  } else {
    const all = await getAllStoredSessions();
    await clearAllSessions(all);
    await Promise.all(
      all.map((s) => client.revoke(s.accessToken, s.desktopSessionId).catch(() => false))
    );
  }
  const pub = await getActivePublicSession();
  if (epoch !== sessionEpoch || activeAttempt) return;
  emit(pub ? { status: 'signed-in', session: pub } : { status: 'signed-out' });
}

export async function getActiveSession(): Promise<PublicSession | null> {
  return getActivePublicSession();
}

export interface UpdateProfileInput {
  displayName?: string | null;
  avatarBase64?: string;
  avatarContentType?: string;
  clearAvatar?: boolean;
}

export async function updateProfile(
  input: UpdateProfileInput
): Promise<{ ok: boolean; message?: string }> {
  const operation = {};
  profileOperation = operation;
  const epoch = sessionEpoch;
  const isCurrent = () => profileOperation === operation && sessionEpoch === epoch;
  const active = await getActiveStoredSession();
  if (!active || !isCurrent()) return { ok: false, message: 'Sign in required.' };

  const result = await client.updateProfile(active.accessToken, {
    displayName: input.displayName,
    avatarBase64: input.avatarBase64,
    avatarContentType: input.avatarContentType,
    clearAvatar: input.clearAvatar,
  });
  if (!result.ok) {
    return { ok: false, message: result.error ?? 'Could not update profile.' };
  }

  const patch = {
    displayName: result.displayName ?? null,
    avatarUrl: await materializeRendererAvatar(result.avatarUrl),
  };
  if (!isCurrent()) return { ok: false, message: 'The active session changed.' };
  try {
    if (!(await updateSessionProfile(active, patch, isCurrent))) {
      return { ok: false, message: 'The active session changed.' };
    }
  } catch {
    return { ok: false, message: 'Could not save profile locally.' };
  }
  const pub = await getActivePublicSession();
  if (!isCurrent()) return { ok: false, message: 'The active session changed.' };
  if (pub) emit({ status: 'signed-in', session: pub });
  return { ok: true };
}

export function getActiveLoopbackRedirectUriForTest(): string | null {
  return activeAttempt?.loopback?.redirectUri ?? null;
}

export function getActiveFlowNonceForTest(): string | null {
  return activeAttempt?.flowNonce ?? null;
}

export async function hydrateOnLaunch(): Promise<void> {
  const epoch = sessionEpoch;
  const isCurrent = () => epoch === sessionEpoch && !activeAttempt;
  clearAllPendingFlows();
  await gcMarkers();
  const stored = await getActiveStoredSession();
  if (!isCurrent()) return;
  if (stored?.avatarUrl && !stored.avatarUrl.startsWith('data:image/')) {
    const avatarUrl = await materializeRendererAvatar(stored.avatarUrl);
    if (avatarUrl && avatarUrl !== stored.avatarUrl) {
      try {
        await updateSessionProfile(
          stored,
          { displayName: stored.displayName, avatarUrl },
          isCurrent
        );
      } catch {
        const pub = await getActivePublicSession();
        if (!isCurrent()) return;
        if (pub && pub.desktopSessionId === stored.desktopSessionId) {
          emit({ status: 'signed-in', session: { ...pub, avatarUrl } });
          scheduleRefresh(pub.accessTokenExpiresAt);
          return;
        }
      }
    }
  }
  const pub = await getActivePublicSession();
  if (!isCurrent()) return;
  if (pub) {
    emit({ status: 'signed-in', session: pub });
    scheduleRefresh(pub.accessTokenExpiresAt);
  } else {
    emit({ status: 'signed-out' });
  }
}

function safeHostname(): string {
  try {
    return hostname() || 'Unknown device';
  } catch {
    return 'Unknown device';
  }
}
