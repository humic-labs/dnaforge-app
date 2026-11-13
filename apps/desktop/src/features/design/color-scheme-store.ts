import { create } from 'zustand';
import { isDesktopRuntime } from '../../utils/environment';
import {
  adoptAdministrationSettings,
  changeAdministrationSettings,
  subscribeAdministrationSettings,
} from '../../lib/administration-client';
import {
  ASSEMBLY_COLOR_SCHEMES,
  DEFAULT_ASSEMBLY_COLOR_SCHEME,
  resolveAssemblyColorSchemeId,
  type AssemblyColorSchemeId,
} from './color-schemes';
import type { AppearanceResult } from '../../lib/appearance-result';
import {
  beginAppearanceObservation,
  observeAppearanceDecision,
} from '../../lib/appearance-observation';

interface AssemblyColorSchemeState extends AppearanceResult {
  assemblyColorScheme: AssemblyColorSchemeId;
  hydrated: boolean;
  setAssemblyColorScheme: (scheme: AssemblyColorSchemeId) => void;
  retryPersistence: () => void;
  hydrate: (refresh?: boolean) => void;
}
const STORAGE_KEY = 'waypoint-assembly-color-scheme';
let nativePaletteSubscribed = false;
function subscribeNativePalette(): void {
  if (nativePaletteSubscribed) return;
  subscribeAdministrationSettings((snapshot) => {
    if (!snapshot.adopted.includes('assemblyColorScheme')) return;
    const state = useAssemblyColorSchemeStore.getState();
    if (
      (state.phase === 'applying' || state.phase === 'saving') &&
      state.assemblyColorScheme !== snapshot.values.assemblyColorScheme
    )
      return;
    try {
      if (!snapshot.unsavedKeys.includes('assemblyColorScheme'))
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: { assemblyColorScheme: snapshot.values.assemblyColorScheme },
            version: 2,
          })
        );
    } catch {}
    useAssemblyColorSchemeStore.setState({
      assemblyColorScheme: snapshot.values.assemblyColorScheme,
      revision: state.revision,
      hydrated: true,
      phase: !snapshot.unsavedKeys.includes('assemblyColorScheme') ? 'saved' : 'unsaved',
    });
  });
  nativePaletteSubscribed = true;
}
function readScheme(raw: string | null): { scheme: AssemblyColorSchemeId; restored: boolean } {
  const fallback = { scheme: DEFAULT_ASSEMBLY_COLOR_SCHEME, restored: false };
  if (!raw) return fallback;
  const record: unknown = JSON.parse(raw);
  if (!record || typeof record !== 'object' || !('state' in record)) return fallback;
  const state = record.state;
  const value =
    state && typeof state === 'object' && 'assemblyColorScheme' in state
      ? state.assemblyColorScheme
      : undefined;
  const valid =
    typeof value === 'string' &&
    (Object.prototype.hasOwnProperty.call(ASSEMBLY_COLOR_SCHEMES, value) ||
      value === 'vivid' ||
      value === 'soft' ||
      value === 'tableau');
  return { scheme: resolveAssemblyColorSchemeId(value), restored: valid };
}
export const useAssemblyColorSchemeStore = create<AssemblyColorSchemeState>((set, get) => {
  const save = (retry: boolean, revision: number) => {
    const state = get();
    if (state.revision !== revision) return;
    const observation = beginAppearanceObservation('appearance_palette', retry ? 'retry' : 'user');
    observation.stage('preference_accepted');
    if (isDesktopRuntime()) {
      subscribeNativePalette();
      void changeAdministrationSettings({ assemblyColorScheme: state.assemblyColorScheme }, retry)
        .then((snapshot) => {
          if (get().revision !== revision) {
            observation.end('preference_superseded');
            return;
          }
          observation.stage('preference_applied');
          if (retry && !snapshot.unsavedKeys.includes('assemblyColorScheme'))
            observation.stage('preference_persisted');
          observation.end(
            !snapshot.unsavedKeys.includes('assemblyColorScheme')
              ? retry
                ? 'preference_recovered'
                : 'preference_persisted'
              : 'preference_unsaved',
            snapshot.unsavedKeys.includes('assemblyColorScheme')
          );
        })
        .catch(() => {
          if (get().revision !== revision) {
            observation.end('preference_superseded');
            return;
          }
          set({ phase: 'unsaved' });
          observation.end('preference_unsaved', true);
        });
      return;
    }
    if (get().revision !== revision) {
      observation.end('preference_superseded');
      return;
    }
    observation.stage('preference_applied');
    try {
      if (get().revision !== revision) {
        observation.end('preference_superseded');
        return;
      }
      if (typeof localStorage === 'undefined') {
        set({ phase: 'temporary' });
        observation.end('preference_temporary');
        return;
      }
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: { assemblyColorScheme: state.assemblyColorScheme }, version: 2 })
      );
      if (get().revision !== revision) {
        observation.end('preference_superseded');
        return;
      }
      set({ phase: 'saved' });
      if (retry) observation.stage('preference_persisted');
      observation.end(retry ? 'preference_recovered' : 'preference_persisted');
    } catch {
      if (get().revision !== revision) {
        observation.end('preference_superseded');
        return;
      }
      set({ phase: 'unsaved' });
      observation.end('preference_unsaved', true);
    }
  };
  return {
    assemblyColorScheme: DEFAULT_ASSEMBLY_COLOR_SCHEME,
    revision: 0,
    phase: 'idle',
    hydrated: false,
    setAssemblyColorScheme: (scheme) => {
      if (
        typeof scheme !== 'string' ||
        !Object.prototype.hasOwnProperty.call(ASSEMBLY_COLOR_SCHEMES, scheme)
      ) {
        observeAppearanceDecision('appearance_palette', 'preference_refused');
        return;
      }
      const next = resolveAssemblyColorSchemeId(scheme);
      const state = get();
      if (state.assemblyColorScheme === next) {
        observeAppearanceDecision('appearance_palette', 'preference_noop');
        return;
      }
      const revision = state.revision + 1;
      set({ assemblyColorScheme: next, revision, phase: 'saving', hydrated: true });
      save(false, revision);
    },
    retryPersistence: () => {
      const state = get();
      if (state.phase === 'read_failed') {
        state.hydrate(true);
        return;
      }
      if (state.phase !== 'unsaved' && state.phase !== 'temporary') return;
      const revision = state.revision + 1;
      set({ revision });
      save(true, revision);
    },
    hydrate: (refresh = false) => {
      const state = get();
      if (state.hydrated && !refresh) return;
      if (state.phase === 'unsaved' || state.phase === 'saving' || state.phase === 'temporary')
        return;
      const observation = beginAppearanceObservation('appearance_palette', 'restore');
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
        const { scheme, restored } = readScheme(raw);
        if (get().revision !== state.revision) {
          observation.end('preference_superseded');
          return;
        }
        const temporary = typeof localStorage === 'undefined';
        set({
          assemblyColorScheme: scheme,
          hydrated: true,
          phase: temporary ? 'temporary' : restored ? 'saved' : 'idle',
        });
        if (isDesktopRuntime()) {
          subscribeNativePalette();
          void adoptAdministrationSettings({ assemblyColorScheme: scheme }).catch(() =>
            set({ phase: 'read_failed' })
          );
        }
        observation.end(
          temporary
            ? 'preference_temporary'
            : restored
              ? 'preference_restored'
              : 'preference_system_applied'
        );
      } catch {
        if (get().revision !== state.revision) {
          observation.end('preference_superseded');
          return;
        }
        set({ phase: 'read_failed' });
        observation.end('preference_read_failed', true);
      }
    },
  };
});
useAssemblyColorSchemeStore.getState().hydrate();
export function useAssemblyColorScheme(): AssemblyColorSchemeId {
  return useAssemblyColorSchemeStore((state) => state.assemblyColorScheme);
}
export function getActiveAssemblyColorScheme(): AssemblyColorSchemeId {
  return resolveAssemblyColorSchemeId(useAssemblyColorSchemeStore.getState().assemblyColorScheme);
}
