import type { VerificationSession, MinimapViewMode, SessionViewPreferences } from '../types';

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function getDefaultViewMode(session: VerificationSession): MinimapViewMode {
  return session.mode === 'multi-per-clone' ? 'single' : 'stacked';
}

export function prefsKey(documentId: string, sessionId: string): string {
  return `${documentId}::${sessionId}`;
}

export function resolveSessionViewPreferences(
  session: VerificationSession | undefined,
  saved?: Partial<SessionViewPreferences>
): SessionViewPreferences {
  return {
    ...saved,
    viewMode: saved?.viewMode ?? (session ? getDefaultViewMode(session) : 'single'),
    selectedTrackId: saved?.selectedTrackId ?? null,
  };
}
