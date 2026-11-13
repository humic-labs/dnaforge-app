import { useSyncExternalStore } from 'react';
import { parseTerminalPreferences, type TerminalPreferences } from './terminal-preferences';

export const TERMINAL_APPEARANCE_KEY = 'dnaforge.terminal.appearance.v1';
export const TERMINAL_PROFILES_CHANGED = 'dnaforge:terminal-profiles-changed';
const APPEARANCE_CHANGED = 'dnaforge:terminal-appearance-changed';
const PROFILES_REVISION_KEY = 'dnaforge.terminal.profiles-revision';
let cachedRaw: string | null | undefined;
let cachedPreferences = parseTerminalPreferences({});

function snapshot(): TerminalPreferences {
  let raw: string | null;
  try {
    raw = localStorage.getItem(TERMINAL_APPEARANCE_KEY);
  } catch {
    return cachedPreferences;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedPreferences = parseTerminalPreferences(JSON.parse(raw ?? '{}'));
    } catch {
      cachedPreferences = parseTerminalPreferences({});
    }
  }
  return cachedPreferences;
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === TERMINAL_APPEARANCE_KEY || event.key === null) listener();
  };
  window.addEventListener(APPEARANCE_CHANGED, listener);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(APPEARANCE_CHANGED, listener);
    window.removeEventListener('storage', storage);
  };
}

export function useTerminalPreferences() {
  return useSyncExternalStore(subscribe, snapshot);
}

export function saveTerminalPreferences(value: TerminalPreferences) {
  localStorage.setItem(TERMINAL_APPEARANCE_KEY, JSON.stringify(parseTerminalPreferences(value)));
  window.dispatchEvent(new Event(APPEARANCE_CHANGED));
}

export function announceTerminalProfilesChanged() {
  localStorage.setItem(PROFILES_REVISION_KEY, crypto.randomUUID());
  window.dispatchEvent(new Event(TERMINAL_PROFILES_CHANGED));
}

export function subscribeTerminalProfilesChanged(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === PROFILES_REVISION_KEY || event.key === null) listener();
  };
  window.addEventListener(TERMINAL_PROFILES_CHANGED, listener);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(TERMINAL_PROFILES_CHANGED, listener);
    window.removeEventListener('storage', storage);
  };
}
