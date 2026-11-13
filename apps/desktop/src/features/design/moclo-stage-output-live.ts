import { loadAllEnzymes } from '@waypoint/sequence-utils';
import { useDesignStore } from './store';
import {
  hasMocloFactoryStageOutputWork,
  reconcileMocloFactoryStageOutputs,
} from './moclo-stage-output-sync';

let unsubscribe: (() => void) | null = null;
let running = false;
let rerunRequested = false;
let generation = 0;

export function startMocloFactoryStageOutputSync(): () => void {
  if (unsubscribe) return stopMocloFactoryStageOutputSync;
  const ownGeneration = ++generation;
  unsubscribe = useDesignStore.subscribe((state, previousState) => {
    if (state.designs !== previousState.designs) requestReconcile(ownGeneration);
  });
  requestReconcile(ownGeneration);
  return stopMocloFactoryStageOutputSync;
}

export function stopMocloFactoryStageOutputSync(): void {
  generation += 1;
  unsubscribe?.();
  unsubscribe = null;
  rerunRequested = false;
}

export async function reconcileMocloFactoryStageOutputsNow(): Promise<boolean> {
  try {
    if (!hasMocloFactoryStageOutputWork(useDesignStore.getState().designs)) return false;
    const enzymes = await loadAllEnzymes();
    const current = useDesignStore.getState().designs;
    const next = reconcileMocloFactoryStageOutputs({ designs: current, enzymes });
    if (next === current) return false;
    useDesignStore.setState({ designs: next });
    return true;
  } catch (error) {
    console.warn('[MoCloFactory] Could not update dependent stage outputs:', error);
    return false;
  }
}

function requestReconcile(expectedGeneration: number): void {
  if (expectedGeneration !== generation) return;
  rerunRequested = true;
  if (running) return;
  queueMicrotask(() => void drainReconciliations(expectedGeneration));
}

async function drainReconciliations(expectedGeneration: number): Promise<void> {
  if (running || expectedGeneration !== generation) return;
  running = true;
  try {
    if (!hasMocloFactoryStageOutputWork(useDesignStore.getState().designs)) {
      rerunRequested = false;
      return;
    }
    rerunRequested = false;
    const enzymes = await loadAllEnzymes();
    if (expectedGeneration !== generation) return;
    do {
      rerunRequested = false;
      const current = useDesignStore.getState().designs;
      const next = reconcileMocloFactoryStageOutputs({ designs: current, enzymes });
      if (next !== current) useDesignStore.setState({ designs: next });
    } while (rerunRequested && expectedGeneration === generation);
  } catch (error) {
    console.warn('[MoCloFactory] Could not update dependent stage outputs:', error);
  } finally {
    running = false;
    if (rerunRequested) {
      requestReconcile(generation);
    }
  }
}
