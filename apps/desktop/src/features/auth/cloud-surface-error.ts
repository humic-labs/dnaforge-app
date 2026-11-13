import {
  toUserMessage,
  userMessage,
  type UserMessage,
  type UserMessageKey,
} from '@waypoint/user-messages';

const SIGN_IN_AGAIN = 'validation.compatible.18';
const IPC_PREFIX = /^Error invoking remote method '[^']+':\s+/u;
const NAMED_ERROR = /^(?:[A-Za-z][A-Za-z0-9]*Error):\s+/u;

const CODE_COPY: Record<string, UserMessageKey> = {
  missing_token: SIGN_IN_AGAIN,
  SESSION_REVOKED: SIGN_IN_AGAIN,
  SIGNED_OUT: SIGN_IN_AGAIN,
  UNAUTHORIZED: SIGN_IN_AGAIN,
  unauthorized: SIGN_IN_AGAIN,
  NETWORK: 'sync.cloudUnreachable',
  QUOTA_EXCEEDED: 'sync.storageLimitReached',
  FEATURE_DISABLED: 'sync.backupPaused',
};

function peel(message: string): string {
  let current = message.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = current.replace(IPC_PREFIX, '').replace(NAMED_ERROR, '').trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

export function formatCloudSurfaceError(err: unknown, fallback: UserMessageKey): UserMessage {
  try {
    const code = err !== null && typeof err === 'object' && 'code' in err ? err.code : null;
    if (typeof code === 'string' && Object.hasOwn(CODE_COPY, code))
      return userMessage(CODE_COPY[code]);
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    const peeled = peel(raw);
    if (Object.hasOwn(CODE_COPY, peeled)) return userMessage(CODE_COPY[peeled]);
    const firstToken = peeled.split(/[\s:]/u)[0] ?? '';
    if (Object.hasOwn(CODE_COPY, firstToken)) return userMessage(CODE_COPY[firstToken]);
    if (/invoking remote method/iu.test(peeled) || /missing_token/iu.test(peeled))
      return userMessage(SIGN_IN_AGAIN);
  } catch {}
  return toUserMessage(err, fallback);
}
