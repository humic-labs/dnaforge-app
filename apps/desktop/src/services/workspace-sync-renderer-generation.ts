import { normalizePathForBoundary } from '../shared/path-boundary';

interface WorkspaceReadGenerationState {
  generation: number;
  activeDeliveryId: string | null;
  idleWaiters: Set<() => void>;
}

const workspaceReadGenerations = new Map<string, WorkspaceReadGenerationState>();

function generationKey(workspaceRoot: string): string {
  return normalizePathForBoundary(workspaceRoot);
}

function stateFor(workspaceRoot: string): WorkspaceReadGenerationState {
  const key = generationKey(workspaceRoot);
  const existing = workspaceReadGenerations.get(key);
  if (existing) return existing;
  const created: WorkspaceReadGenerationState = {
    generation: 0,
    activeDeliveryId: null,
    idleWaiters: new Set(),
  };
  workspaceReadGenerations.set(key, created);
  return created;
}

export function beginWorkspaceSyncRendererGeneration(
  workspaceRoot: string,
  deliveryId: string
): void {
  const state = stateFor(workspaceRoot);
  if (state.activeDeliveryId === deliveryId) return;
  if (state.activeDeliveryId) {
    throw new Error(`Workspace ${workspaceRoot} already has a renderer generation in progress.`);
  }
  state.generation += 1;
  state.activeDeliveryId = deliveryId;
}

export function finishWorkspaceSyncRendererGeneration(
  workspaceRoot: string,
  deliveryId: string
): void {
  const state = stateFor(workspaceRoot);
  if (state.activeDeliveryId !== deliveryId) return;
  state.activeDeliveryId = null;
  state.generation += 1;
  const waiters = [...state.idleWaiters];
  state.idleWaiters.clear();
  for (const resolve of waiters) resolve();
}

function waitForWorkspaceGenerationIdle(state: WorkspaceReadGenerationState): Promise<void> {
  if (!state.activeDeliveryId) return Promise.resolve();
  return new Promise((resolve) => state.idleWaiters.add(resolve));
}

export async function readStableWorkspaceGeneration<T>(
  workspaceRoot: string | null | undefined,
  read: () => Promise<T>
): Promise<T> {
  const root = workspaceRoot?.trim();
  if (!root) return read();
  const state = stateFor(root);

  for (;;) {
    await waitForWorkspaceGenerationIdle(state);
    const generation = state.generation;
    try {
      const value = await read();
      if (!state.activeDeliveryId && state.generation === generation) return value;
    } catch (error) {
      if (!state.activeDeliveryId && state.generation === generation) throw error;
    }
  }
}

export function resetWorkspaceSyncRendererGenerationsForTest(): void {
  for (const state of workspaceReadGenerations.values()) {
    state.activeDeliveryId = null;
    state.generation += 1;
    for (const resolve of state.idleWaiters) resolve();
    state.idleWaiters.clear();
  }
  workspaceReadGenerations.clear();
}
