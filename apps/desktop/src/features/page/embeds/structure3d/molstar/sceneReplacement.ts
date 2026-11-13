const listeners = new WeakMap<object, Set<() => void>>();

export function onStructureSceneReplaced(plugin: object, listener: () => void): () => void {
  let subscriptions = listeners.get(plugin);
  if (!subscriptions) listeners.set(plugin, (subscriptions = new Set()));
  subscriptions.add(listener);
  return () => {
    subscriptions.delete(listener);
    if (subscriptions.size === 0) listeners.delete(plugin);
  };
}

export function notifyStructureSceneReplaced(plugin: object): void {
  for (const listener of listeners.get(plugin) ?? []) listener();
}
