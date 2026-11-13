import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec';

export type ServiceFixture<T> = T extends (...args: infer _Arguments) => infer _Result
  ? T
  : T extends readonly (infer Item)[]
    ? readonly ServiceFixture<Item>[]
    : T extends object
      ? { [Key in keyof T]?: ServiceFixture<T[Key]> }
      : T;

export function molstarPluginFixture(services: ServiceFixture<PluginContext>): PluginContext {
  const plugin = new PluginContext(DefaultPluginSpec());
  for (const [key, value] of Object.entries(services)) {
    Object.defineProperty(plugin, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  return plugin;
}
