import type { MolstarPlugin } from './cache';

const drawing = new WeakMap<MolstarPlugin, symbol>();
export const extensionCaptureReason =
  'This extension style is remembered on this device. Switch to a built-in view to save a portable molecular scene.';

export function markExtensionDrawing(plugin: MolstarPlugin): () => void {
  const generation = Symbol();
  drawing.set(plugin, generation);
  return () => {
    if (drawing.get(plugin) === generation) drawing.delete(plugin);
  };
}

export function extensionOwnsDrawing(plugin: MolstarPlugin) {
  return drawing.has(plugin);
}
