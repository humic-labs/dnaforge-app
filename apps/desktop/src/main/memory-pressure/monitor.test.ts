import { describe, expect, it, vi } from 'vitest';
import { MemoryPressureMonitor, type MemoryPressureReaders } from './monitor';

function readers(overrides: Partial<MemoryPressureReaders>): MemoryPressureReaders {
  return {
    platform: 'darwin',
    darwinPressureLevel: async () => '1\n',
    linuxPressureStall: async () => '',
    windowsMemory: () => ({ availableBytes: 8, totalBytes: 16 }),
    now: () => 1_000,
    ...overrides,
  };
}

describe('MemoryPressureMonitor', () => {
  it('samples the platform signal and notifies only on a change', async () => {
    let raw = '1\n';
    const monitor = new MemoryPressureMonitor(readers({ darwinPressureLevel: async () => raw }));
    const listener = vi.fn();
    monitor.onChange(listener);

    expect(await monitor.sample()).toMatchObject({ level: 'normal', source: 'darwin-sysctl' });
    await monitor.sample();
    raw = '4\n';
    expect((await monitor.sample()).level).toBe('critical');

    expect(listener.mock.calls.map(([sample]) => sample.level)).toEqual(['normal', 'critical']);
  });

  it('degrades a failed read to unknown instead of throwing', async () => {
    const monitor = new MemoryPressureMonitor(
      readers({
        darwinPressureLevel: async () => {
          throw new Error('sysctl missing');
        },
      })
    );
    expect(await monitor.sample()).toMatchObject({ level: 'unknown', source: 'unavailable' });
  });

  it('reads Linux PSI and Windows available memory', async () => {
    const linux = new MemoryPressureMonitor(
      readers({
        platform: 'linux',
        linuxPressureStall: async () =>
          'some avg10=15.00 avg60=0 avg300=0 total=1\nfull avg10=0.50 avg60=0 avg300=0 total=1\n',
      })
    );
    expect(await linux.sample()).toMatchObject({ level: 'moderate', source: 'linux-psi' });

    const windows = new MemoryPressureMonitor(
      readers({
        platform: 'win32',
        windowsMemory: () => ({ availableBytes: 32 * 1024 * 1024, totalBytes: 8 * 1024 ** 3 }),
      })
    );
    expect(await windows.sample()).toMatchObject({
      level: 'critical',
      source: 'windows-available-memory',
    });
  });

  it('shares one read between concurrent callers', async () => {
    const darwinPressureLevel = vi.fn(async () => '2\n');
    const monitor = new MemoryPressureMonitor(readers({ darwinPressureLevel }));
    await Promise.all([monitor.sample(), monitor.sample(), monitor.sample()]);
    expect(darwinPressureLevel).toHaveBeenCalledTimes(1);
  });

  it('can be forced to a level and released back to the real signal', async () => {
    const monitor = new MemoryPressureMonitor(readers({}));
    expect(await monitor.force('critical')).toMatchObject({ level: 'critical', source: 'forced' });
    expect(await monitor.force(null)).toMatchObject({ level: 'normal', source: 'darwin-sysctl' });
  });
});
