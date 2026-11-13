import { usePresentationListener } from '../../presentation/PresentationSurface';
('use client');
import { createContext, useContext, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { create } from 'zustand';
import { matchesAppShortcut } from '../../keyboard/shortcutRegistry';
import { isDesktopRuntime } from '../../utils/environment';
import {
  adoptAdministrationSettings,
  changeAdministrationSettings,
  subscribeAdministrationSettings,
} from '../../lib/administration-client';
import type { AppearanceResult } from '../../lib/appearance-result';
import {
  beginAppearanceObservation,
  observeAppearanceDecision,
} from '../../lib/appearance-observation';

export type ThemeMode = 'system' | 'light' | 'dark';
interface ThemeState extends AppearanceResult {
  themeMode: ThemeMode;
  darkMode: boolean;
  hydrated: boolean;
}
const themeStore = create<ThemeState>(() => ({
  themeMode: 'light',
  darkMode: false,
  phase: 'idle',
  revision: 0,
  hydrated: false,
}));
const STORAGE_KEY = 'waypoint-theme-mode';
let nativeThemeSubscribed = false;
function subscribeNativeTheme(): void {
  if (nativeThemeSubscribed) return;
  subscribeAdministrationSettings((snapshot) => {
    if (!snapshot.adopted.includes('theme')) return;
    const current = themeStore.getState();
    try {
      const darkMode = apply(snapshot.values.theme);
      if (
        (current.phase === 'applying' || current.phase === 'saving') &&
        current.themeMode !== snapshot.values.theme
      ) {
        themeStore.setState({ darkMode });
        return;
      }
      try {
        if (!snapshot.unsavedKeys.includes('theme'))
          localStorage.setItem(STORAGE_KEY, snapshot.values.theme);
      } catch {}
      themeStore.setState({
        themeMode: snapshot.values.theme,
        darkMode,
        hydrated: true,
        revision: current.revision,
        phase: !snapshot.unsavedKeys.includes('theme') ? 'saved' : 'unsaved',
      });
    } catch {
      themeStore.setState({ phase: 'apply_failed' });
    }
  });
  nativeThemeSubscribed = true;
}
function validMode(mode: unknown): mode is ThemeMode {
  return mode === 'system' || mode === 'light' || mode === 'dark';
}
function systemDark(): boolean {
  try {
    return (
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    );
  } catch {
    return false;
  }
}
function apply(mode: ThemeMode, prefersDark = systemDark()): boolean {
  const dark = mode === 'dark' || (mode === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
  return dark;
}
function saveTheme(retry: boolean, revision: number): void {
  const state = themeStore.getState();
  if (state.revision !== revision) return;
  const observation = beginAppearanceObservation('appearance_theme', retry ? 'retry' : 'user');
  observation.stage('preference_accepted');
  if (isDesktopRuntime()) {
    subscribeNativeTheme();
    void changeAdministrationSettings({ theme: state.themeMode }, retry)
      .then((snapshot) => {
        if (themeStore.getState().revision !== revision) {
          observation.end('preference_superseded');
          return;
        }
        observation.stage('preference_applied');
        if (retry && !snapshot.unsavedKeys.includes('theme'))
          observation.stage('preference_persisted');
        observation.end(
          !snapshot.unsavedKeys.includes('theme')
            ? retry
              ? 'preference_recovered'
              : 'preference_persisted'
            : 'preference_unsaved',
          snapshot.unsavedKeys.includes('theme')
        );
      })
      .catch(() => {
        if (themeStore.getState().revision !== revision) {
          observation.end('preference_superseded');
          return;
        }
        themeStore.setState({ phase: 'unsaved' });
        observation.end('preference_unsaved', true);
      });
    return;
  }
  if (themeStore.getState().revision !== revision) {
    observation.end('preference_superseded');
    return;
  }
  try {
    const darkMode = apply(state.themeMode);
    if (themeStore.getState().revision !== revision) {
      observation.end('preference_superseded');
      return;
    }
    themeStore.setState({ darkMode, phase: 'saving' });
    observation.stage('preference_applied');
    if (themeStore.getState().revision !== revision) {
      observation.end('preference_superseded');
      return;
    }
    if (typeof localStorage === 'undefined') {
      themeStore.setState({ phase: 'temporary' });
      observation.end('preference_temporary');
      return;
    }
    localStorage.setItem(STORAGE_KEY, state.themeMode);
    if (themeStore.getState().revision !== revision) {
      observation.end('preference_superseded');
      return;
    }
    themeStore.setState({ phase: 'saved' });
    if (retry) observation.stage('preference_persisted');
    observation.end(retry ? 'preference_recovered' : 'preference_persisted');
  } catch {
    if (themeStore.getState().revision !== revision) {
      observation.end('preference_superseded');
      return;
    }
    const darkMode = document.documentElement.classList.contains('dark');
    const expected = state.themeMode === 'dark' || (state.themeMode === 'system' && systemDark());
    const applied = darkMode === expected;
    themeStore.setState({ darkMode, phase: applied ? 'unsaved' : 'apply_failed' });
    observation.end(applied ? 'preference_unsaved' : 'preference_apply_failed', true);
  }
}
export function setThemeMode(mode: ThemeMode): void {
  if (!validMode(mode)) {
    observeAppearanceDecision('appearance_theme', 'preference_refused');
    return;
  }
  const state = themeStore.getState();
  if (state.themeMode === mode) {
    observeAppearanceDecision('appearance_theme', 'preference_noop');
    return;
  }
  const revision = state.revision + 1;
  themeStore.setState({ themeMode: mode, revision, hydrated: true, phase: 'applying' });
  saveTheme(false, revision);
}
export function retryThemePreference(): void {
  const state = themeStore.getState();
  if (state.phase === 'read_failed') {
    hydrateTheme(true);
    return;
  }
  if (state.phase !== 'unsaved' && state.phase !== 'temporary' && state.phase !== 'apply_failed')
    return;
  const revision = state.revision + 1;
  themeStore.setState({ revision });
  saveTheme(true, revision);
}
function hydrateTheme(refresh = false): void {
  const state = themeStore.getState();
  if (
    state.phase === 'unsaved' ||
    state.phase === 'temporary' ||
    state.phase === 'apply_failed' ||
    state.phase === 'saving'
  ) {
    apply(state.themeMode);
    return;
  }
  if (state.hydrated && !refresh) {
    apply(state.themeMode);
    return;
  }
  const observation = beginAppearanceObservation('appearance_theme', 'restore');
  try {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    const themeMode = validMode(saved) ? saved : 'light';
    const darkMode = apply(themeMode);
    if (themeStore.getState().revision !== state.revision) {
      observation.end('preference_superseded');
      return;
    }
    const temporary = typeof localStorage === 'undefined';
    themeStore.setState({
      themeMode,
      darkMode,
      hydrated: true,
      phase: temporary ? 'temporary' : validMode(saved) ? 'saved' : 'idle',
    });
    if (isDesktopRuntime()) {
      subscribeNativeTheme();
      void adoptAdministrationSettings({ theme: themeMode }).catch(() =>
        themeStore.setState({ phase: 'read_failed' })
      );
    }
    observation.end(
      temporary
        ? 'preference_temporary'
        : validMode(saved)
          ? 'preference_restored'
          : 'preference_system_applied'
    );
  } catch {
    if (themeStore.getState().revision !== state.revision) {
      observation.end('preference_superseded');
      return;
    }
    try {
      const darkMode = apply(state.themeMode);
      themeStore.setState({ darkMode, phase: 'read_failed' });
      observation.end('preference_read_failed', true);
    } catch {
      themeStore.setState({ phase: 'apply_failed' });
      observation.end('preference_apply_failed', true);
    }
  }
}
interface DarkModeContextValue {
  darkMode: boolean;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  toggleDarkMode: () => void;
  persistence: AppearanceResult;
  retryPersistence: () => void;
}
const DarkModeContext = createContext<DarkModeContextValue>({
  darkMode: false,
  themeMode: 'light',
  setThemeMode: () => {},
  toggleDarkMode: () => {},
  persistence: { revision: 0, phase: 'idle' },
  retryPersistence: () => {},
});
export function useDarkMode() {
  return useContext(DarkModeContext);
}
export function resetThemePreferenceForTests(): void {
  themeStore.setState({
    themeMode: 'light',
    darkMode: false,
    phase: 'idle',
    revision: 0,
    hydrated: false,
  });
}
function toggleDarkMode(): void {
  setThemeMode(themeStore.getState().darkMode ? 'light' : 'dark');
}
export function DarkModeProvider({ children }: { children: ReactNode }) {
  const presentationEvents = usePresentationListener();

  const state = themeStore();
  useLayoutEffect(() => {
    hydrateTheme(true);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = (event: MediaQueryListEvent) => {
      const current = themeStore.getState();
      if (current.themeMode !== 'system') return;
      const observation = beginAppearanceObservation('appearance_theme', 'system');
      try {
        const darkMode = apply('system', event.matches);
        themeStore.setState({ darkMode });
        observation.end('preference_system_applied');
      } catch {
        themeStore.setState({ phase: 'apply_failed' });
        observation.end('preference_apply_failed', true);
      }
    };
    media.addEventListener('change', change);
    const keyDown = (event: KeyboardEvent) => {
      if (!matchesAppShortcut(event, 'app.dark-mode')) return;
      event.preventDefault();
      toggleDarkMode();
    };
    presentationEvents.add(window, 'keydown', keyDown);
    return () => {
      media.removeEventListener('change', change);
      presentationEvents.remove(window, 'keydown', keyDown);
    };
  }, [presentationEvents]);
  return (
    <DarkModeContext.Provider
      value={{
        darkMode: state.darkMode,
        themeMode: state.themeMode,
        setThemeMode,
        toggleDarkMode,
        persistence: state,
        retryPersistence: retryThemePreference,
      }}
    >
      {children}
    </DarkModeContext.Provider>
  );
}
