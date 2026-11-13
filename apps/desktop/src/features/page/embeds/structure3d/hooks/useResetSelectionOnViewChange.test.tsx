import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useResetSelectionOnViewChange } from './useResetSelectionOnViewChange';

describe('selection across molecular view changes', () => {
  it('retains the mutation when the initial native view becomes its first authored scene', () => {
    const clear = vi.fn();
    const hook = renderHook(
      ({ scene, index, recipe }: { scene?: string; index?: number; recipe?: string }) =>
        useResetSelectionOnViewChange(scene, index, recipe, 'same-protein', clear),
      { initialProps: { scene: undefined, index: undefined, recipe: 'cartoon' } }
    );
    hook.rerender({ scene: '{"kind":"single"}', index: 0, recipe: undefined });
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears the selection when the user changes an established scene or story step', () => {
    const clear = vi.fn();
    const hook = renderHook(
      ({ scene, index }) =>
        useResetSelectionOnViewChange(scene, index, undefined, 'same-protein', clear),
      { initialProps: { scene: '{"kind":"single","view":1}', index: 0 } }
    );
    hook.rerender({ scene: '{"kind":"single","view":2}', index: 0 });
    expect(clear).toHaveBeenCalledTimes(1);
    hook.rerender({ scene: '{"kind":"single","view":2}', index: 1 });
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('clears the selection when the coordinate source or legacy recipe changes', () => {
    const clear = vi.fn();
    const hook = renderHook(
      ({ source, recipe }) =>
        useResetSelectionOnViewChange(undefined, undefined, recipe, source, clear),
      { initialProps: { source: 'first-protein', recipe: 'cartoon' } }
    );
    hook.rerender({ source: 'first-protein', recipe: 'surface' });
    expect(clear).toHaveBeenCalledTimes(1);
    hook.rerender({ source: 'second-protein', recipe: 'surface' });
    expect(clear).toHaveBeenCalledTimes(2);
  });
});
