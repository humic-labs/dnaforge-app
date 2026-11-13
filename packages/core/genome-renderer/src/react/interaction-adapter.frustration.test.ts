import { describe, expect, it, vi } from 'vitest';
import { attachPixiInteractionAdapter } from './interaction-adapter';

describe('canvas frustration attribution', () => {
  it('emits ui_frustration with a component after triple-clicking a hit-tested canvas control', () => {
    const canvasEl = document.createElement('canvas');
    const capture = vi.fn();
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: { width: 800, height: 220 } } as never,
      optionsRef: { current: { onUiFrustration: (properties: unknown) => capture('ui_frustration', properties) } } as never,
      renderer: {} as never,
      activeGenome: { length: 1000 } as never,
      circular: false,
    });
    interaction.hitTestFn = () => ({ kind: 'feature', payload: { id: 17, start: 100, end: 200 } });
    for (let i = 0; i < 3; i++) canvasEl.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 50 }));
    expect(capture).toHaveBeenCalledExactlyOnceWith('ui_frustration', { component: 'sequence-viewer.feature', action: 'click' });
    interaction.cleanup();
    for (let i = 0; i < 3; i++) canvasEl.dispatchEvent(new MouseEvent('click'));
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
