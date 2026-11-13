import type { VerificationSession, MinimapViewMode } from '../types';

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function getDefaultViewMode(session: VerificationSession): MinimapViewMode {
  return session.mode === 'multi-per-clone' ? 'single' : 'stacked';
}

export function prefsKey(documentId: string, sessionId: string): string {
  return `${documentId}::${sessionId}`;
}
