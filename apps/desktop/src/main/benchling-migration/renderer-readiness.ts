export function createMigrationRendererReadiness<T extends object>(getOwner: () => T | null) {
  let readyOwner: T | null = null;
  const waiters = new Set<() => void>();
  return {
    setReady(owner: T, ready: boolean): void {
      if (owner !== getOwner()) return;
      readyOwner = ready ? owner : null;
      for (const wake of waiters) wake();
    },
    wait(timeoutMs: number): Promise<T> {
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        const check = () => {
          const owner = getOwner();
          if (owner && readyOwner === owner) {
            finish();
            resolve(owner);
          }
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error('The product renderer did not become ready for validation.'));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}
