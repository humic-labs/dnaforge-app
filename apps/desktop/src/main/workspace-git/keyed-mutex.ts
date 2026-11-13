export function createKeyedMutex() {
  const chains = new Map<string, Promise<unknown>>();
  return async function runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(operation);
    chains.set(key, run);
    try {
      return await run;
    } finally {
      if (chains.get(key) === run) chains.delete(key);
    }
  };
}
