const pendingOperations = new Set<Promise<unknown>>();

export function retainTestBridgeOperation<T>(operation: Promise<T>): Promise<T> {
  pendingOperations.add(operation);
  void operation.then(
    () => pendingOperations.delete(operation),
    () => pendingOperations.delete(operation)
  );
  return operation;
}

export function retainTestBridgeStoreOperations<T extends object>(
  store: T,
  operationKeys: readonly (keyof T)[]
): T {
  const operations = new Set<PropertyKey>(operationKeys);
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (!operations.has(key) || typeof value !== 'function') return value;
      return (...args: unknown[]) => retainTestBridgeOperation(Reflect.apply(value, target, args));
    },
  });
}
