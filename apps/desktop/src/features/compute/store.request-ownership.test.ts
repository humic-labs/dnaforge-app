import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useComputeStore } from './store';

const { listProviders } = vi.hoisted(() => ({ listProviders: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ compute: { listProviders } }) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe('compute refresh ownership', () => {
  beforeEach(() => {
    listProviders.mockReset();
    useComputeStore.setState({ providers: [], loading: false, loadError: null });
  });
  it('keeps the newest catalog when an older refresh finishes last', async () => {
    const older = deferred<never[]>();
    listProviders.mockReturnValueOnce(older.promise).mockResolvedValueOnce([{ id: 'newest' }]);
    const first = useComputeStore.getState().refresh();
    await useComputeStore.getState().refresh();
    older.resolve([]);
    await first;
    expect(useComputeStore.getState().providers).toEqual([{ id: 'newest' }]);
    expect(useComputeStore.getState().loading).toBe(false);
  });
  it('ignores an old failure while the replacement refresh is pending', async () => {
    const older = deferred<never[]>();
    const newer = deferred<never[]>();
    listProviders.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = useComputeStore.getState().refresh();
    const second = useComputeStore.getState().refresh();
    older.reject(new Error('retired failure'));
    await first;
    expect(useComputeStore.getState().loading).toBe(true);
    expect(useComputeStore.getState().loadError).toBeNull();
    newer.resolve([]);
    await second;
  });
});
