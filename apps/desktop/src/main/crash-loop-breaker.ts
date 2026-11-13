export interface ProcessExit {
  process_type: string;
  reason: string;
  exitCode: number | null;
  signal?: string | null;
  process_memory: number | null;
  uptime_ms: number | null;
}

export function createCrashLoopBreaker(
  emit: (event: 'process_gone' | 'crash_loop_detected', details: ProcessExit) => void,
  recover: () => void
) {
  let exits: number[] = [];
  let safeMode = false;
  return {
    isSafeMode: () => safeMode,
    record(details: ProcessExit, now = Date.now()): void {
      emit('process_gone', details);
      if (
        safeMode ||
        ![
          'killed',
          'crashed',
          'oom',
          'abnormal-exit',
          'integrity-failure',
          'launch-failed',
          'memory-eviction',
        ].includes(details.reason)
      )
        return;
      exits = exits.filter((time) => now - time <= 300_000);
      exits.push(now);
      if (exits.length < 3) return;
      safeMode = true;
      emit('crash_loop_detected', details);
      recover();
    },
  };
}
