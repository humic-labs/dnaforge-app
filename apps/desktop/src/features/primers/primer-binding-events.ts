type PrimerBindingsChangedListener = (sequenceId: number) => void;

const listeners = new Set<PrimerBindingsChangedListener>();

export function notifyPrimerBindingsChanged(sequenceId: number): void {
  for (const listener of listeners) listener(sequenceId);
}

export function subscribePrimerBindingsChanged(
  listener: PrimerBindingsChangedListener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
