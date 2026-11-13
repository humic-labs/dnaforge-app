type VerificationStateMap = Record<string, unknown>;

type VerificationStore = {
  subscribe: (
    selector: (state: {
      verificationState: VerificationStateMap;
      staleReferences: Record<string, boolean | undefined>;
    }) => VerificationStateMap,
    listener: (value: VerificationStateMap, previous: VerificationStateMap) => void,
    options?: { equalityFn: (a: VerificationStateMap, b: VerificationStateMap) => boolean }
  ) => () => void;
  getState: () => {
    staleReferences: Record<string, boolean | undefined>;
    saveSidecar: (documentId: string, options?: { onlyIfCurrent?: boolean }) => void;
    verificationState: Record<string, unknown>;
  };
};

const SIDECAR_SAVE_DEBOUNCE_MS = 2000;

let unsubscribe: (() => void) | null = null;
const sidecarSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const loadedStates = new WeakSet<object>();

export function markLoadedVerificationState(state: object): void {
  loadedStates.add(state);
}

export function startVerificationAutosave(
  store: VerificationStore,
  hasUnsettledReferenceEdits: (documentId: string) => boolean = () => false
): () => void {
  if (unsubscribe) return stopVerificationAutosave;

  const schedule = (documentId: string) => {
    sidecarSaveTimers.set(
      documentId,
      setTimeout(() => {
        sidecarSaveTimers.delete(documentId);
        if (store.getState().staleReferences[documentId]) return;
        if (hasUnsettledReferenceEdits(documentId)) {
          schedule(documentId);
          return;
        }
        store.getState().saveSidecar(documentId, { onlyIfCurrent: true });
      }, SIDECAR_SAVE_DEBOUNCE_MS)
    );
  };

  unsubscribe = store.subscribe(
    (state) => state.verificationState,
    (verificationState, prevVerificationState) => {
      for (const documentId of Object.keys(verificationState)) {
        if (verificationState[documentId] !== prevVerificationState[documentId]) {
          const existing = sidecarSaveTimers.get(documentId);
          if (existing) {
            clearTimeout(existing);
            sidecarSaveTimers.delete(documentId);
          }
          if (store.getState().staleReferences[documentId]) continue;
          const next = verificationState[documentId];
          if (typeof next === 'object' && next !== null && loadedStates.has(next)) continue;

          schedule(documentId);
        }
      }
    },
    { equalityFn: Object.is }
  );

  return stopVerificationAutosave;
}

export function stopVerificationAutosave(): void {
  unsubscribe?.();
  unsubscribe = null;
  for (const timer of sidecarSaveTimers.values()) clearTimeout(timer);
  sidecarSaveTimers.clear();
}
