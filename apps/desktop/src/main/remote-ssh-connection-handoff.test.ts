import { describe, expect, it, vi } from 'vitest';

import { RemoteSshConnectionHandoff } from './remote-ssh-connection-handoff';

describe('tested SSH connection ownership transfer', () => {
  const createLease = () => ({
    target: 'lab-hpc',
    controlPath: '/tmp/dfs-ctrl-fixture/control',
    release: vi.fn(async () => undefined),
  });

  it('transfers a borrow once and leaves release to the transport', async () => {
    const handoff = new RemoteSshConnectionHandoff();
    const lease = createLease();
    handoff.offer('request-1', lease);
    expect(handoff.take('request-1', 'lab-hpc')).toBe(lease);
    expect(handoff.take('request-1', 'lab-hpc')).toBeNull();
    await handoff.discard('request-1');
    expect(lease.release).not.toHaveBeenCalled();
    await lease.release();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('releases an unused borrow once when a pooled transport or cancellation bypasses admission', async () => {
    const handoff = new RemoteSshConnectionHandoff();
    const lease = createLease();
    handoff.offer('request-1', lease);
    await handoff.discard('request-1');
    await handoff.discard('request-1');
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(handoff.take('request-1', 'lab-hpc')).toBeNull();
  });

  it('rejects another target and duplicate offers without losing the original borrow', async () => {
    const handoff = new RemoteSshConnectionHandoff();
    const lease = createLease();
    handoff.offer('request-1', lease);
    expect(() => handoff.take('request-1', 'other-hpc')).toThrow('no longer matches');
    expect(() => handoff.offer('request-1', createLease())).toThrow('already in use');
    await handoff.discard('request-1');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});
