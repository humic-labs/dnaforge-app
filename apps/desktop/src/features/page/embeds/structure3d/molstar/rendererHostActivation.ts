export type RendererHostActivationStatus = 'activated' | 'reused' | 'stale';

export interface RendererHostActivationResult {
  status: RendererHostActivationStatus;
  structureKey: string;
  generation: number;
}

export interface RendererHostActivationState {
  generation: number;
  requestedStructureKey: string | null;
  loadedStructureKey: string | null;
  queue: Promise<void>;
}

export interface RendererHostActivationRequest {
  structureKey: string;
  activate: (context: {
    generation: number;
    isCurrent: () => boolean;
  }) => Promise<void | { status: 'cancelled' }>;
}

export function createRendererHostActivationState(
  loadedStructureKey: string | null = null
): RendererHostActivationState {
  return {
    generation: 0,
    requestedStructureKey: loadedStructureKey,
    loadedStructureKey,
    queue: Promise.resolve(),
  };
}

export function enqueueRendererHostActivation(
  state: RendererHostActivationState,
  request: RendererHostActivationRequest
): Promise<RendererHostActivationResult> {
  const generation = state.generation + 1;
  state.generation = generation;
  state.requestedStructureKey = request.structureKey;
  const isCurrent = () =>
    state.generation === generation && state.requestedStructureKey === request.structureKey;

  const result = state.queue
    .catch(() => undefined)
    .then(async (): Promise<RendererHostActivationResult> => {
      if (!isCurrent()) {
        return { status: 'stale', structureKey: request.structureKey, generation };
      }
      if (state.loadedStructureKey === request.structureKey) {
        return { status: 'reused', structureKey: request.structureKey, generation };
      }

      state.loadedStructureKey = null;
      const activation = await request.activate({ generation, isCurrent });
      if (activation && activation.status === 'cancelled') {
        return { status: 'stale', structureKey: request.structureKey, generation };
      }
      state.loadedStructureKey = request.structureKey;

      return {
        status: isCurrent() ? 'activated' : 'stale',
        structureKey: request.structureKey,
        generation,
      };
    });

  state.queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function enqueueRendererHostSceneOperation<T>(
  state: RendererHostActivationState,
  structureKey: string,
  operation: (isCurrent: () => boolean) => Promise<T>,
  ownerIsCurrent: () => boolean = () => true
): Promise<{ status: 'applied'; value: T } | { status: 'stale' }> {
  const generation = state.generation;
  const isCurrent = () =>
    state.generation === generation &&
    state.requestedStructureKey === structureKey &&
    state.loadedStructureKey === structureKey &&
    ownerIsCurrent();
  const result = state.queue
    .catch(() => undefined)
    .then(async () => {
      if (!isCurrent()) return { status: 'stale' as const };
      try {
        const value = await operation(isCurrent);
        return isCurrent() ? { status: 'applied' as const, value } : { status: 'stale' as const };
      } catch (error) {
        if (!isCurrent()) return { status: 'stale' as const };
        throw error;
      }
    });
  state.queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function invalidateRendererHostActivations(state: RendererHostActivationState): void {
  state.generation += 1;
  state.requestedStructureKey = null;
}

export function requestRendererHostStructure(
  state: RendererHostActivationState,
  structureKey: string
): void {
  if (state.requestedStructureKey === structureKey) return;
  state.generation += 1;
  state.requestedStructureKey = structureKey;
}
