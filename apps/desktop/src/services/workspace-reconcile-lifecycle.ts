const inFlightByRoot = new Map<string, Set<Promise<unknown>>>();
const tailByRoot = new Map<string, Promise<unknown>>();

export interface TrackedWorkspaceReconcileOptions {
  ordered?: boolean;
}

export async function runTrackedWorkspaceReconcile<T>(
  workspaceRoot: string,
  operation: () => Promise<T>,
  options: TrackedWorkspaceReconcileOptions = {}
): Promise<T> {
  const inFlight = inFlightByRoot.get(workspaceRoot) ?? new Set<Promise<unknown>>();
  inFlightByRoot.set(workspaceRoot, inFlight);

  const ordered = options.ordered ?? true;
  const predecessor = ordered ? (tailByRoot.get(workspaceRoot) ?? Promise.resolve()) : null;
  const promise = predecessor
    ? predecessor.catch(() => undefined).then(operation)
    : Promise.resolve().then(operation);
  if (ordered) tailByRoot.set(workspaceRoot, promise);
  inFlight.add(promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(promise);
    if (inFlight.size === 0) inFlightByRoot.delete(workspaceRoot);
    if (tailByRoot.get(workspaceRoot) === promise) tailByRoot.delete(workspaceRoot);
  }
}

export async function waitForWorkspaceReconcileIdle(workspaceRoot: string): Promise<void> {
  let inFlight = inFlightByRoot.get(workspaceRoot);
  while (inFlight && inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
    inFlight = inFlightByRoot.get(workspaceRoot);
  }
}
