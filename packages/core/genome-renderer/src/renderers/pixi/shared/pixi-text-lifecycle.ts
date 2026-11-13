import type { Text } from 'pixi.js';

export function destroyPixiText(text: Text): void {
  if (text.destroyed) return;
  text.style.off('update', text.onViewUpdate, text);
  text.destroy();
}
