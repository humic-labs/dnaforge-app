import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  watch: vi.fn<() => Promise<void>>(),
  unwatch: vi.fn<() => Promise<void>>(),
  unsubscribe: vi.fn(),
  listener: null as null | ((...args: unknown[]) => void),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    on: (_event: string, listener: (...args: unknown[]) => void) => {
      state.listener = listener;
      return state.unsubscribe;
    },
    fs: { watchFile: state.watch, unwatchFile: state.unwatch },
  }),
}));
import { usePdfSourceWatcher } from './usePdfSourceWatcher';
function Mounted({
  changed = () => {},
  unavailable = () => {},
}: {
  changed?: () => void;
  unavailable?: () => void;
}) {
  usePdfSourceWatcher('/controlled.pdf', changed, unavailable);
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.watch.mockResolvedValue();
  state.unwatch.mockResolvedValue();
});
describe('PDF source watch ownership', () => {
  it('releases a late native acquisition after component cleanup, without an early unwatch', async () => {
    let release!: () => void;
    state.watch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const view = render(<Mounted />);
    view.unmount();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
    expect(state.unwatch).not.toHaveBeenCalled();
    await act(async () => release());
    expect(state.unwatch).toHaveBeenCalledWith('/controlled.pdf');
  });
  it('reloads only matching source changes and exposes unavailable watch recovery', async () => {
    const changed = vi.fn();
    const unavailable = vi.fn();
    state.watch.mockRejectedValue(new Error('controlled refusal'));
    render(<Mounted changed={changed} unavailable={unavailable} />);
    act(() => state.listener?.('/other.pdf'));
    expect(changed).not.toHaveBeenCalled();
    act(() => state.listener?.('/controlled.pdf'));
    expect(changed).toHaveBeenCalledOnce();
    await act(async () => {});
    expect(unavailable).toHaveBeenCalledOnce();
  });
});
