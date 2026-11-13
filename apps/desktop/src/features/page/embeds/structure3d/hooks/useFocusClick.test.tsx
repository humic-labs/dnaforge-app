// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { EmptyLoci } from 'molstar/lib/mol-model/loci';
import { useFocusClick } from './useFocusClick';

const runtime = vi.hoisted(() => ({ scene: undefined as string | undefined }));
vi.mock('../molstar/molViewSpec', () => ({ activeMolViewSpecScene: () => runtime.scene }));
vi.mock('../molstar/viewerSelection', () => ({ rememberViewerOverview: vi.fn() }));
beforeEach(() => {
  runtime.scene = undefined;
});
function viewer() {
  const setFromLoci = vi.fn(),
    clear = vi.fn(),
    focusLoci = vi.fn();
  return {
    plugin: { managers: { structure: { focus: { setFromLoci, clear } }, camera: { focusLoci } } },
    setFromLoci,
    clear,
    focusLoci,
  };
}

it('keeps native contextual side chains for an ordinary structure viewer', () => {
  const { plugin, setFromLoci, focusLoci } = viewer();
  const { result } = renderHook(() => useFocusClick(plugin));
  act(() => result.current(EmptyLoci));
  expect(setFromLoci).toHaveBeenCalledWith(EmptyLoci);
  expect(focusLoci).toHaveBeenCalledOnce();
});

it('focuses authored geometry without layering a differently colored native focus representation', () => {
  runtime.scene = 'authored';
  const { plugin, setFromLoci, clear, focusLoci } = viewer();
  const { result } = renderHook(() => useFocusClick(plugin));
  act(() => result.current(EmptyLoci));
  expect(setFromLoci).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalledOnce();
  expect(focusLoci).toHaveBeenCalledWith(EmptyLoci, {
    minRadius: 8,
    extraRadius: 4,
    durationMs: 250,
  });
});

it('uses the current authored-scene ownership after a cached viewer changes mode', () => {
  const { plugin, setFromLoci, clear } = viewer();
  const { result } = renderHook(() => useFocusClick(plugin));
  act(() => result.current(EmptyLoci));
  runtime.scene = 'authored-after-rehost';
  act(() => result.current(EmptyLoci));
  expect(setFromLoci).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledOnce();
});
