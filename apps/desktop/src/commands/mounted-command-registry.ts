import type { CommandRegistryContextValue } from './types';

const registries = new Set<CommandRegistryContextValue>();
export function registerMountedCommandRegistry(registry: CommandRegistryContextValue) {
  registries.add(registry);
  return () => {
    registries.delete(registry);
  };
}
export function getMountedCommandRegistry() {
  if (registries.size > 1) throw new Error('Multiple app command owners are mounted.');
  return registries.values().next().value ?? null;
}
