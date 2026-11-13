import { subscribeAdministrationSettings } from '../../lib/administration-client';
import { useEffect } from 'react';
import { create } from 'zustand';
import {
  SEQUENCE_WEBGL_PERFORMANCE_PREFERENCES,
  type SequenceWebGLPerformancePreference,
} from './view-state/sequence-view-state';
import { getSetting, setSetting } from '../../db';
import type { AppearanceResult } from '../../lib/appearance-result';
import {
  beginAppearanceObservation,
  observeAppearanceDecision,
} from '../../lib/appearance-observation';
import { isDesktopRuntime } from '../../utils/environment';

export const WEBGL_PERFORMANCE_SETTING_KEY = 'sequence_webgl_performance_preference';
export const WEBGL_PERFORMANCE_SETTING_EVENT = 'dnaforge:webgl-performance-preference';
export const DEFAULT_WEBGL_PERFORMANCE_PREFERENCE: SequenceWebGLPerformancePreference = 'auto';
export function normalizeWebGLPerformancePreference(
  value: unknown
): SequenceWebGLPerformancePreference | null {
  return typeof value === 'string' &&
    (SEQUENCE_WEBGL_PERFORMANCE_PREFERENCES as readonly string[]).includes(value)
    ? (value as SequenceWebGLPerformancePreference)
    : null;
}
interface WebGLPreferenceState extends AppearanceResult {
  value: SequenceWebGLPerformancePreference;
  hydrated: boolean;
}
export const useWebGLPreferenceStore = create<WebGLPreferenceState>(() => ({
  value: DEFAULT_WEBGL_PERFORMANCE_PREFERENCE,
  revision: 0,
  phase: 'idle',
  hydrated: false,
}));
let writes: Promise<void> = Promise.resolve();
let hydration: Promise<void> | null = null;
let nativeWebGLSubscribed = false;
function subscribeNativeWebGL(): void {
  if (nativeWebGLSubscribed) return;
  subscribeAdministrationSettings((snapshot) => {
    if (!snapshot.adopted.includes('webglPerformance')) return;
    const state = useWebGLPreferenceStore.getState();
    if (
      (state.phase === 'applying' || state.phase === 'saving') &&
      state.value !== snapshot.values.webglPerformance
    )
      return;
    const revision =
      state.phase === 'applying' || state.phase === 'saving' || state.phase === 'loading'
        ? state.revision
        : state.revision + 1;
    useWebGLPreferenceStore.setState({
      revision,
      hydrated: true,
      phase: !snapshot.unsavedKeys.includes('webglPerformance') ? 'saved' : 'unsaved',
    });
    if (state.value !== snapshot.values.webglPerformance) {
      try {
        publish(snapshot.values.webglPerformance, revision);
      } catch {
        useWebGLPreferenceStore.setState({ phase: 'apply_failed' });
      }
    }
  });
  nativeWebGLSubscribed = true;
}

function publish(value: SequenceWebGLPerformancePreference, revision: number): boolean {
  if (useWebGLPreferenceStore.getState().revision !== revision) return false;
  useWebGLPreferenceStore.setState({ value });
  if (useWebGLPreferenceStore.getState().revision !== revision) return false;
  window.dispatchEvent(
    new CustomEvent(WEBGL_PERFORMANCE_SETTING_EVENT, { detail: { value, revision } })
  );
  return useWebGLPreferenceStore.getState().revision === revision;
}
function save(value: SequenceWebGLPerformancePreference, retry: boolean): Promise<void> {
  if (isDesktopRuntime()) subscribeNativeWebGL();
  const previous = useWebGLPreferenceStore.getState();
  const revision = previous.revision + 1;
  const apply = !retry || previous.phase === 'apply_failed';
  const current = () => useWebGLPreferenceStore.getState().revision === revision;
  useWebGLPreferenceStore.setState({ revision, phase: 'saving', hydrated: true });
  const observation = beginAppearanceObservation('appearance_webgl', retry ? 'retry' : 'user');
  observation.stage('preference_accepted');
  try {
    if (!current() || (apply && !publish(value, revision))) {
      observation.end('preference_superseded');
      return Promise.resolve();
    }
    observation.stage('preference_applied');
  } catch {
    if (current()) {
      useWebGLPreferenceStore.setState({ phase: 'apply_failed' });
      observation.end('preference_apply_failed', true);
    } else observation.end('preference_superseded');
    return Promise.resolve();
  }
  const perform = async () => {
    if (!current()) {
      observation.end('preference_superseded');
      return;
    }
    try {
      await setSetting(WEBGL_PERFORMANCE_SETTING_KEY, value);
      if (!current()) {
        observation.end('preference_superseded');
        return;
      }
      const durable = isDesktopRuntime();
      useWebGLPreferenceStore.setState({ phase: durable ? 'saved' : 'temporary' });
      if (durable && retry) observation.stage('preference_persisted');
      observation.end(
        durable ? (retry ? 'preference_recovered' : 'preference_persisted') : 'preference_temporary'
      );
    } catch {
      if (!current()) {
        observation.end('preference_superseded');
        return;
      }
      useWebGLPreferenceStore.setState({ phase: 'unsaved' });
      observation.end('preference_unsaved', true);
    }
  };
  writes = writes.then(perform, perform);
  return writes;
}
export function setWebGLPerformancePreference(value: unknown): Promise<void> {
  const next = normalizeWebGLPerformancePreference(value);
  if (!next) {
    observeAppearanceDecision('appearance_webgl', 'preference_refused');
    return Promise.resolve();
  }
  if (next === useWebGLPreferenceStore.getState().value) {
    observeAppearanceDecision('appearance_webgl', 'preference_noop');
    return Promise.resolve();
  }
  return save(next, false);
}
export function retryWebGLPerformancePreference(): Promise<void> {
  const state = useWebGLPreferenceStore.getState();
  if (state.phase === 'read_failed') return hydrateWebGLPerformancePreference(true);
  if (state.phase !== 'unsaved' && state.phase !== 'apply_failed') return Promise.resolve();
  return save(state.value, true);
}
export function hydrateWebGLPerformancePreference(refresh = false): Promise<void> {
  if (isDesktopRuntime()) subscribeNativeWebGL();
  const state = useWebGLPreferenceStore.getState();
  if (
    state.phase === 'unsaved' ||
    state.phase === 'saving' ||
    state.phase === 'apply_failed' ||
    state.phase === 'temporary'
  )
    return writes;
  if (hydration) return hydration;
  if (state.hydrated && !refresh) return Promise.resolve();
  const revision = state.revision;
  const observation = beginAppearanceObservation('appearance_webgl', 'restore');
  if (useWebGLPreferenceStore.getState().revision !== revision) {
    observation.end('preference_superseded');
    return Promise.resolve();
  }
  useWebGLPreferenceStore.setState({ phase: 'loading' });
  const work = async () => {
    try {
      const stored = await getSetting(WEBGL_PERFORMANCE_SETTING_KEY);
      if (useWebGLPreferenceStore.getState().revision !== revision) {
        observation.end('preference_superseded');
        return;
      }
      const durable = normalizeWebGLPerformancePreference(stored);
      if (!publish(durable ?? DEFAULT_WEBGL_PERFORMANCE_PREFERENCE, revision)) {
        observation.end('preference_superseded');
        return;
      }
      const persisted = durable !== null && isDesktopRuntime();
      useWebGLPreferenceStore.setState({
        hydrated: true,
        phase: durable === null ? 'idle' : persisted ? 'saved' : 'temporary',
      });
      observation.end(
        durable === null
          ? 'preference_system_applied'
          : persisted
            ? 'preference_restored'
            : 'preference_temporary'
      );
    } catch {
      if (useWebGLPreferenceStore.getState().revision !== revision) {
        observation.end('preference_superseded');
        return;
      }
      useWebGLPreferenceStore.setState({ phase: 'read_failed' });
      observation.end('preference_read_failed', true);
    }
  };
  const pending = work();
  hydration = pending;
  void pending.finally(() => {
    if (hydration === pending) hydration = null;
  });
  return pending;
}
export async function readStoredWebGLPerformancePreference(): Promise<SequenceWebGLPerformancePreference> {
  await hydrateWebGLPerformancePreference();
  return useWebGLPreferenceStore.getState().value;
}
export function useWebGLPerformancePreference(): SequenceWebGLPerformancePreference {
  const value = useWebGLPreferenceStore((state) => state.value);
  useEffect(() => {
    const onPreference = (event: Event) => {
      const detail = (event as CustomEvent<{ value?: unknown; revision?: unknown }>).detail;
      if (typeof detail?.revision === 'number') return;
      void setWebGLPerformancePreference(detail?.value);
    };
    window.addEventListener(WEBGL_PERFORMANCE_SETTING_EVENT, onPreference);
    void hydrateWebGLPerformancePreference(true);
    return () => window.removeEventListener(WEBGL_PERFORMANCE_SETTING_EVENT, onPreference);
  }, []);
  return value;
}
