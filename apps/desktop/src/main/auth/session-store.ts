import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { reportOperationalFailure } from '../sentry';
import type { DesktopPublicSession } from '../../shared/auth-types';
import {
  configureQualificationEphemeralAuth,
  isQualificationEphemeralAuthEnabled,
} from '../qualification-auth-state';

export { configureQualificationEphemeralAuth, isQualificationEphemeralAuthEnabled };

export const SESSIONS_SCHEMA_VERSION = 1;

export interface StoredSession {
  accountId: string;
  desktopSessionId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  email?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  channel: string;
  updatedAt: number;
  meaningfulActivityAuthority?: import('../../shared/analytics-types').MeaningfulActivityAuthority;
}

export type PublicSession = DesktopPublicSession;

interface SessionsFileV1 {
  schemaVersion: 1;
  activeAccountId: string | null;
  sessions: Record<string, string>;
}

interface EphemeralSessions {
  activeAccountId: string | null;
  sessions: Map<string, StoredSession>;
}

const ephemeralSessions: EphemeralSessions = {
  activeAccountId: null,
  sessions: new Map(),
};

let sessionAccess: Promise<unknown> = Promise.resolve();

function withSessions<T>(operation: () => Promise<T>): Promise<T> {
  const next = sessionAccess.then(operation);
  sessionAccess = next.catch(() => {});
  return next;
}

function authDir(): string {
  return join(app.getPath('userData'), 'auth');
}
function sessionsPath(): string {
  return join(authDir(), 'sessions.json');
}

export function isEncryptionAvailable(): boolean {
  if (isQualificationEphemeralAuthEnabled()) return true;
  return safeStorage.isEncryptionAvailable();
}

function emptyFile(): SessionsFileV1 {
  return { schemaVersion: 1, activeAccountId: null, sessions: {} };
}

async function readSessionsFile(): Promise<SessionsFileV1> {
  try {
    const parsed = JSON.parse(await readFile(sessionsPath(), 'utf8')) as Partial<SessionsFileV1>;
    if (
      parsed &&
      parsed.schemaVersion === 1 &&
      parsed.sessions &&
      typeof parsed.sessions === 'object'
    ) {
      return {
        schemaVersion: 1,
        activeAccountId: parsed.activeAccountId ?? null,
        sessions: parsed.sessions,
      };
    }
    return emptyFile();
  } catch {
    return emptyFile();
  }
}

async function writeSessionsFile(f: SessionsFileV1): Promise<void> {
  await mkdir(authDir(), { recursive: true });
  await writeFile(sessionsPath(), JSON.stringify(f), 'utf8');
}

function toPublic(s: StoredSession): PublicSession {
  return {
    accountId: s.accountId,
    desktopSessionId: s.desktopSessionId,
    email: s.email,
    displayName: s.displayName ?? null,
    avatarUrl: s.avatarUrl ?? null,
    channel: s.channel,
    accessTokenExpiresAt: s.accessTokenExpiresAt,
    ...(s.meaningfulActivityAuthority
      ? { meaningfulActivityAuthority: s.meaningfulActivityAuthority }
      : {}),
  };
}

export async function saveSession(
  s: StoredSession,
  makeActive = true,
  isCurrent: () => boolean = () => true
): Promise<void> {
  return withSessions(async () => {
    if (!isCurrent()) return;
    if (isQualificationEphemeralAuthEnabled()) {
      ephemeralSessions.sessions.set(s.accountId, { ...s });
      if (makeActive || !ephemeralSessions.activeAccountId) {
        ephemeralSessions.activeAccountId = s.accountId;
      }
      return;
    }
    if (!isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
    const f = await readSessionsFile();
    if (!isCurrent()) return;
    f.sessions[s.accountId] = safeStorage.encryptString(JSON.stringify(s)).toString('base64');
    if (makeActive || !f.activeAccountId) f.activeAccountId = s.accountId;
    await writeSessionsFile(f);
  });
}

async function decryptEntry(f: SessionsFileV1, accountId: string): Promise<StoredSession | null> {
  const blob = f.sessions[accountId];
  if (!blob) return null;
  if (!isEncryptionAvailable()) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64'))) as StoredSession;
  } catch {
    reportOperationalFailure('auth.session_decryption_unavailable', {
      level: 'warning',
      extra: { accountId },
    });
    return null;
  }
}

export async function getActiveStoredSession(): Promise<StoredSession | null> {
  return withSessions(async () => {
    if (isQualificationEphemeralAuthEnabled()) {
      const accountId = ephemeralSessions.activeAccountId;
      const session = accountId ? ephemeralSessions.sessions.get(accountId) : undefined;
      return session ? { ...session } : null;
    }
    const f = await readSessionsFile();
    if (!f.activeAccountId) return null;
    return decryptEntry(f, f.activeAccountId);
  });
}

export async function getActivePublicSession(): Promise<PublicSession | null> {
  const s = await getActiveStoredSession();
  return s ? toPublic(s) : null;
}

export type SelectedAccountContext =
  | { kind: 'account'; accountId: string }
  | { kind: 'signed-out' }
  | { kind: 'unavailable'; reason: 'unreadable' | 'malformed' };

export async function getSelectedAccountContext(): Promise<SelectedAccountContext> {
  return withSessions(async () => {
    if (isQualificationEphemeralAuthEnabled()) {
      const id = ephemeralSessions.activeAccountId;
      return id === null
        ? { kind: 'signed-out' }
        : ephemeralSessions.sessions.has(id)
          ? { kind: 'account', accountId: id }
          : { kind: 'unavailable', reason: 'malformed' };
    }
    let serialized: string;
    try {
      serialized = await readFile(sessionsPath(), 'utf8');
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? { kind: 'signed-out' }
        : { kind: 'unavailable', reason: 'unreadable' };
    }
    try {
      const value: unknown = JSON.parse(serialized);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('schemaVersion' in value) ||
        value.schemaVersion !== SESSIONS_SCHEMA_VERSION ||
        !('sessions' in value) ||
        !value.sessions ||
        typeof value.sessions !== 'object' ||
        Array.isArray(value.sessions) ||
        !('activeAccountId' in value)
      )
        return { kind: 'unavailable', reason: 'malformed' };
      const entries: Array<[string, unknown]> = Object.entries(value.sessions);
      if (entries.some(([, entry]) => typeof entry !== 'string' || !entry.length))
        return { kind: 'unavailable', reason: 'malformed' };
      if (value.activeAccountId === null) return { kind: 'signed-out' };
      const id = value.activeAccountId;
      return typeof id === 'string' && id.length > 0 && entries.some(([key]) => key === id)
        ? { kind: 'account', accountId: id }
        : { kind: 'unavailable', reason: 'malformed' };
    } catch {
      return { kind: 'unavailable', reason: 'malformed' };
    }
  });
}

export async function updateSessionTokens(
  accountId: string,
  patch: {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    expectedSessionId?: string;
    expectedRefreshToken?: string;
  }
): Promise<boolean> {
  return withSessions(async () => {
    const { expectedSessionId, expectedRefreshToken, ...tokens } = patch;
    const matches = (session: StoredSession) =>
      (!expectedSessionId || session.desktopSessionId === expectedSessionId) &&
      (!expectedRefreshToken || session.refreshToken === expectedRefreshToken);
    if (isQualificationEphemeralAuthEnabled()) {
      const session = ephemeralSessions.sessions.get(accountId);
      if (!session || !matches(session)) return false;
      ephemeralSessions.sessions.set(accountId, {
        ...session,
        ...tokens,
        updatedAt: Date.now(),
      });
      return true;
    }
    const f = await readSessionsFile();
    const s = await decryptEntry(f, accountId);
    if (!s || !matches(s)) return false;
    const next: StoredSession = { ...s, ...tokens, updatedAt: Date.now() };
    f.sessions[accountId] = safeStorage.encryptString(JSON.stringify(next)).toString('base64');
    await writeSessionsFile(f);
    return true;
  });
}

export async function removeSession(accountId: string, expectedSessionId?: string): Promise<void> {
  return withSessions(async () => {
    if (isQualificationEphemeralAuthEnabled()) {
      if (
        expectedSessionId &&
        ephemeralSessions.sessions.get(accountId)?.desktopSessionId !== expectedSessionId
      )
        return;
      ephemeralSessions.sessions.delete(accountId);
      if (ephemeralSessions.activeAccountId === accountId) {
        ephemeralSessions.activeAccountId = ephemeralSessions.sessions.keys().next().value ?? null;
      }
      return;
    }
    const f = await readSessionsFile();
    if (
      expectedSessionId &&
      (await decryptEntry(f, accountId))?.desktopSessionId !== expectedSessionId
    )
      return;
    delete f.sessions[accountId];
    if (f.activeAccountId === accountId) f.activeAccountId = Object.keys(f.sessions)[0] ?? null;
    await writeSessionsFile(f);
  });
}

export async function getAllStoredSessions(): Promise<StoredSession[]> {
  return withSessions(async () => {
    if (isQualificationEphemeralAuthEnabled()) {
      return [...ephemeralSessions.sessions.values()].map((session) => ({ ...session }));
    }
    const f = await readSessionsFile();
    const out: StoredSession[] = [];
    for (const accountId of Object.keys(f.sessions)) {
      const s = await decryptEntry(f, accountId);
      if (s) out.push(s);
    }
    return out;
  });
}

export async function clearAllSessions(
  expected?: readonly Pick<StoredSession, 'accountId' | 'desktopSessionId'>[]
): Promise<void> {
  return withSessions(async () => {
    if (isQualificationEphemeralAuthEnabled()) {
      if (!expected) {
        ephemeralSessions.sessions.clear();
      } else {
        for (const session of expected) {
          if (
            ephemeralSessions.sessions.get(session.accountId)?.desktopSessionId ===
            session.desktopSessionId
          ) {
            ephemeralSessions.sessions.delete(session.accountId);
          }
        }
      }
      if (
        !ephemeralSessions.activeAccountId ||
        !ephemeralSessions.sessions.has(ephemeralSessions.activeAccountId)
      ) {
        ephemeralSessions.activeAccountId = ephemeralSessions.sessions.keys().next().value ?? null;
      }
      return;
    }
    if (!expected) {
      await writeSessionsFile(emptyFile());
      return;
    }
    const file = await readSessionsFile();
    for (const session of expected) {
      if (
        (await decryptEntry(file, session.accountId))?.desktopSessionId === session.desktopSessionId
      ) {
        delete file.sessions[session.accountId];
      }
    }
    if (!file.activeAccountId || !file.sessions[file.activeAccountId]) {
      file.activeAccountId = Object.keys(file.sessions)[0] ?? null;
    }
    await writeSessionsFile(file);
  });
}

export async function setActiveAccount(accountId: string): Promise<void> {
  return withSessions(async () => {
    if (isQualificationEphemeralAuthEnabled()) {
      if (ephemeralSessions.sessions.has(accountId)) ephemeralSessions.activeAccountId = accountId;
      return;
    }
    const f = await readSessionsFile();
    if (f.sessions[accountId]) {
      f.activeAccountId = accountId;
      await writeSessionsFile(f);
    }
  });
}

export async function listPublicSessions(): Promise<PublicSession[]> {
  return withSessions(async () => {
    if (isQualificationEphemeralAuthEnabled()) {
      return [...ephemeralSessions.sessions.values()].map(toPublic);
    }
    const f = await readSessionsFile();
    const out: PublicSession[] = [];
    for (const accountId of Object.keys(f.sessions)) {
      const s = await decryptEntry(f, accountId);
      if (s) out.push(toPublic(s));
    }
    return out;
  });
}

export async function updateSessionProfile(
  expected: Pick<StoredSession, 'accountId' | 'desktopSessionId'>,
  patch: Pick<StoredSession, 'displayName' | 'avatarUrl'>,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  return withSessions(async () => {
    if (!isCurrent()) return false;
    if (isQualificationEphemeralAuthEnabled()) {
      const session = ephemeralSessions.sessions.get(expected.accountId);
      if (session?.desktopSessionId !== expected.desktopSessionId) return false;
      ephemeralSessions.sessions.set(expected.accountId, {
        ...session,
        ...patch,
        updatedAt: Date.now(),
      });
      return true;
    }
    const file = await readSessionsFile();
    const session = await decryptEntry(file, expected.accountId);
    if (!session || session.desktopSessionId !== expected.desktopSessionId || !isCurrent())
      return false;
    file.sessions[expected.accountId] = safeStorage
      .encryptString(JSON.stringify({ ...session, ...patch, updatedAt: Date.now() }))
      .toString('base64');
    await writeSessionsFile(file);
    return true;
  });
}
