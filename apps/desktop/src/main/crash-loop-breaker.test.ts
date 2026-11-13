import { describe, expect, it, vi } from 'vitest';
import { createCrashLoopBreaker } from './crash-loop-breaker';

describe('crash loop breaker', () => {
  it('emits one loop event for three force-killed renderers and preserves every exit', () => {
    const emit = vi.fn();
    const recover = vi.fn();
    const breaker = createCrashLoopBreaker(emit, recover);
    for (const now of [0, 60_000, 120_000, 180_000]) {
      breaker.record(
        {
          process_type: 'renderer',
          reason: 'killed',
          exitCode: 137,
          signal: 'SIGKILL',
          process_memory: null,
          uptime_ms: 1000,
        },
        now
      );
    }
    expect(emit.mock.calls.filter(([event]) => event === 'crash_loop_detected')).toHaveLength(1);
    const kills = emit.mock.calls.filter(([event]) => event === 'process_gone');
    expect(kills).toHaveLength(4);
    for (const [, details] of kills)
      expect(details).toMatchObject({ reason: 'killed', exitCode: 137 });
    expect(recover).toHaveBeenCalledOnce();
    expect(breaker.isSafeMode()).toBe(true);
  });

  it('expires old crashes and ignores clean exits', () => {
    const breaker = createCrashLoopBreaker(vi.fn(), vi.fn());
    const exit = {
      process_type: 'renderer',
      reason: 'crashed',
      exitCode: 1,
      process_memory: null,
      uptime_ms: 10,
    };
    breaker.record(exit, 0);
    breaker.record(exit, 300_001);
    breaker.record({ ...exit, reason: 'clean-exit', exitCode: 0 }, 300_002);
    breaker.record(exit, 300_003);
    expect(breaker.isSafeMode()).toBe(false);
    breaker.record(exit, 300_004);
    expect(breaker.isSafeMode()).toBe(true);
  });
});
