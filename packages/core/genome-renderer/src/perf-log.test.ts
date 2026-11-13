// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { time, timeAsync } from './perf-log';

declare global {
  interface Window {
    __perfEnabled?: boolean;
    __perfConsole?: boolean;
  }
}

function burn(ms: number): number {
  const t0 = performance.now();
  let x = 0;
  while (performance.now() - t0 < ms) x += Math.random();
  return x;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__perfEnabled;
  delete window.__perfConsole;
});

describe('perf-log per-call console echo gate (regression: DNA-TG1 codon scroll lag)', () => {
  it('time(): profiler ON but __perfConsole unset → NO console.log even for a >0.5ms op', () => {
    window.__perfEnabled = true;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = time('frame.render', () => {
      burn(1.5);
      return 42;
    });

    expect(result).toBe(42);
    expect(spy).not.toHaveBeenCalled();
  });

  it('time(): __perfConsole = true → DOES console.log a >0.5ms op (firehose still available)', () => {
    window.__perfEnabled = true;
    window.__perfConsole = true;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    time('frame.render', () => burn(1.5));

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toContain('frame.render');
  });

  it('time(): fast (<0.5ms) op never logs regardless of flag', () => {
    window.__perfEnabled = true;
    window.__perfConsole = true;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    time('cheap', () => 1);

    expect(spy).not.toHaveBeenCalled();
  });

  it('timeAsync(): same gate as time() — sibling path cannot regress independently', async () => {
    window.__perfEnabled = true;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const v = await timeAsync('frame.async', async () => {
      burn(1.5);
      return 'ok';
    });
    expect(v).toBe('ok');
    expect(spy).not.toHaveBeenCalled();

    window.__perfConsole = true;
    await timeAsync('frame.async', async () => burn(1.5));
    expect(spy).toHaveBeenCalled();
  });
});
