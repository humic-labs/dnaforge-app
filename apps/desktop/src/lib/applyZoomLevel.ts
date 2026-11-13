import { subscribeAdministrationSettings } from './administration-client';
import { create } from 'zustand';
import { isDesktopRuntime } from '../utils/environment';
import { getSetting, setSetting } from '../db';
import { platform } from '../platform';
import { isWindowZoomFactor, parseWindowZoomFactor } from '../shared/window-zoom';
import type { AppearanceResult } from './appearance-result';
import {
  beginAppearanceObservation,
  observeAppearanceDecision,
  type AppearanceOrigin,
} from './appearance-observation';

interface DisplayZoomState extends AppearanceResult {
  factor: number | null;
  selectedFactor: number;
  hydrated: boolean;
}
export const useDisplayZoomStore = create<DisplayZoomState>(() => ({
  factor: null,
  selectedFactor: 1,
  phase: 'idle',
  revision: 0,
  hydrated: false,
}));
let writes: Promise<void> = Promise.resolve();
let hydration: Promise<void> | null = null;
let nativeZoomSubscribed = false;
function subscribeNativeZoom(): void {
  if (nativeZoomSubscribed) return;
  subscribeAdministrationSettings((snapshot) => {
    if (!snapshot.adopted.includes('displayZoom')) return;
    const state = useDisplayZoomStore.getState();
    const actual =
      snapshot.zoom &&
      (snapshot.zoom.status === 'applied' || snapshot.zoom.status === 'failed') &&
      isWindowZoomFactor(snapshot.zoom.factor)
        ? snapshot.zoom.factor
        : state.factor;
    if (
      (state.phase === 'applying' || state.phase === 'saving') &&
      state.selectedFactor !== snapshot.values.displayZoom
    ) {
      useDisplayZoomStore.setState({ factor: actual });
      return;
    }
    useDisplayZoomStore.setState({
      factor: actual,
      selectedFactor: snapshot.values.displayZoom,
      revision:
        state.phase === 'applying' || state.phase === 'saving' || state.phase === 'loading'
          ? state.revision
          : state.revision + 1,
      hydrated: actual !== null,
      phase:
        snapshot.zoom?.status === 'failed' ||
        snapshot.zoom?.status === 'refused' ||
        snapshot.message?.includes('display application is unconfirmed')
          ? 'apply_failed'
          : !snapshot.unsavedKeys.includes('displayZoom')
            ? 'saved'
            : 'unsaved',
    });
  });
  nativeZoomSubscribed = true;
}

function changeDisplayZoom(
  factor: number,
  origin: AppearanceOrigin,
  persist: boolean,
  restored = false,
  inheritedObservation?: ReturnType<typeof beginAppearanceObservation>
): Promise<void> {
  const revision = useDisplayZoomStore.getState().revision + 1;
  useDisplayZoomStore.setState({
    revision,
    selectedFactor: factor,
    phase: 'applying',
    hydrated: true,
  });
  const observation =
    inheritedObservation ?? beginAppearanceObservation('appearance_display', origin);
  observation.stage('preference_accepted');
  const current = () => useDisplayZoomStore.getState().revision === revision;
  const perform = async () => {
    if (!current()) {
      observation.end('preference_superseded');
      return;
    }
    let applied = false;
    try {
      if (!isDesktopRuntime()) throw new Error('Native zoom unavailable');
      subscribeNativeZoom();
      const result = await platform().window.setZoomLevel(factor);
      if (
        (result.status === 'applied' || result.status === 'failed') &&
        isWindowZoomFactor(result.factor)
      )
        useDisplayZoomStore.setState({ factor: result.factor });
      if (!current()) {
        observation.end('preference_superseded');
        return;
      }
      if (
        result.status !== 'applied' ||
        !isWindowZoomFactor(result.factor) ||
        Math.abs(result.factor - factor) > 1e-6
      ) {
        if (result.status === 'failed' && isWindowZoomFactor(result.factor))
          useDisplayZoomStore.setState({ factor: result.factor });
        throw new Error('Native zoom not confirmed');
      }
      applied = true;
      useDisplayZoomStore.setState({
        factor: result.factor,
        phase: persist ? 'saving' : restored ? 'saved' : 'idle',
      });
      observation.stage('preference_applied');
      if (origin === 'system') observation.stage('preference_system_applied');
      if (!current()) {
        observation.end('preference_superseded');
        return;
      }
      if (persist) await setSetting('display_zoom', String(result.factor));
      if (!current()) {
        observation.end('preference_superseded');
        return;
      }
      if (persist) useDisplayZoomStore.setState({ phase: 'saved' });
      if (persist && origin === 'retry') observation.stage('preference_persisted');
      observation.end(
        persist
          ? origin === 'retry'
            ? 'preference_recovered'
            : 'preference_persisted'
          : restored
            ? 'preference_restored'
            : 'preference_system_applied'
      );
    } catch {
      if (!current()) {
        observation.end('preference_superseded');
        return;
      }
      useDisplayZoomStore.setState({ phase: applied ? 'unsaved' : 'apply_failed' });
      observation.end(applied ? 'preference_unsaved' : 'preference_apply_failed', true);
    }
  };
  writes = writes.then(perform, perform);
  return writes;
}

export function setDisplayZoom(factor: number): Promise<void> {
  if (!isWindowZoomFactor(factor)) {
    observeAppearanceDecision('appearance_display', 'preference_refused');
    return Promise.resolve();
  }
  if (factor === useDisplayZoomStore.getState().selectedFactor) {
    observeAppearanceDecision('appearance_display', 'preference_noop');
    return Promise.resolve();
  }
  return changeDisplayZoom(factor, 'user', true);
}
export function retryDisplayZoom(): Promise<void> {
  const state = useDisplayZoomStore.getState();
  if (state.phase === 'read_failed') return applyZoomLevel(true);
  if (state.phase !== 'unsaved' && state.phase !== 'apply_failed') return Promise.resolve();
  return changeDisplayZoom(state.selectedFactor, 'retry', true);
}

export function applyZoomLevel(refresh = false): Promise<void> {
  if (isDesktopRuntime()) subscribeNativeZoom();
  const state = useDisplayZoomStore.getState();
  if (!isDesktopRuntime()) return Promise.resolve();
  if (
    state.phase === 'unsaved' ||
    state.phase === 'applying' ||
    state.phase === 'saving' ||
    state.phase === 'apply_failed'
  )
    return writes;
  if (hydration) return hydration;
  if (state.hydrated && !refresh) return Promise.resolve();
  const revision = state.revision;
  const observation = beginAppearanceObservation('appearance_display', 'restore');
  if (useDisplayZoomStore.getState().revision !== revision) {
    observation.end('preference_superseded');
    return Promise.resolve();
  }
  useDisplayZoomStore.setState({ phase: 'loading' });
  const work = async () => {
    try {
      const stored = await getSetting('display_zoom');
      if (useDisplayZoomStore.getState().revision !== revision) {
        observation.end('preference_superseded');
        return;
      }
      const factor = parseWindowZoomFactor(stored);
      if (factor !== null) await changeDisplayZoom(factor, 'restore', false, true, observation);
      else {
        const automatic = screen.height >= 2160 && window.devicePixelRatio <= 1.25;
        await changeDisplayZoom(automatic ? 2 : 1, 'system', automatic, false, observation);
      }
    } catch {
      if (useDisplayZoomStore.getState().revision !== revision) {
        observation.end('preference_superseded');
        return;
      }
      useDisplayZoomStore.setState({ phase: 'read_failed' });
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
