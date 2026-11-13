interface Entry {
  name: string;
  t: number;
  dt: number;
  detail?: Record<string, unknown>;
}

const BUFFER_SIZE = 4000;
const buffer: Entry[] = [];
let writeIndex = 0;
let filled = false;

const pending = new Map<string, number>();

type PerfLogWindow = Window & {
  __perfEnabled?: boolean;
  __perfConsole?: boolean;
  __perfDump?: (filter?: string) => unknown;
  __perfClear?: () => void;
  __perfEntries?: (filter?: string) => unknown;
};

function perfWindow(): PerfLogWindow | null {
  return typeof window === 'undefined' ? null : (window as PerfLogWindow);
}

function enabled(): boolean {
  const w = perfWindow();
  if (!w) return false;
  if (w.__perfEnabled === true) return true;
  if (w.__perfEnabled === false) return false;
  return false;
}

function consoleEcho(): boolean {
  return perfWindow()?.__perfConsole === true;
}

function record(name: string, t: number, dt: number, detail?: Record<string, unknown>): void {
  if (!enabled()) return;
  const entry: Entry = { name, t, dt, detail };
  buffer[writeIndex] = entry;
  writeIndex = (writeIndex + 1) % BUFFER_SIZE;
  if (writeIndex === 0) filled = true;
  if (dt > 0 && typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    try {
      performance.measure(name, { start: t, duration: dt });
    } catch {}
  }
}

export function log(name: string, detail?: Record<string, unknown>): void {
  if (!enabled()) return;
  record(name, performance.now(), 0, detail);
  // eslint-disable-next-line no-console
  console.log(
    `[webgl ${performance.now().toFixed(1).padStart(9, ' ')}] ${name}`,
    detail ? detail : ''
  );
}

export function mark(name: string, detail?: Record<string, unknown>): void {
  log(name, detail);
}

export function time<T>(name: string, fn: () => T, detail?: Record<string, unknown>): T {
  if (!enabled()) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const dt = performance.now() - t0;
    record(name, t0, dt, detail);
    if (dt > 0.5 && consoleEcho()) {
      // eslint-disable-next-line no-console
      console.log(
        `[webgl ${performance.now().toFixed(1).padStart(9, ' ')}] ${name.padEnd(32)} ${dt.toFixed(2)}ms`,
        detail ?? ''
      );
    }
  }
}

export async function timeAsync<T>(
  name: string,
  fn: () => Promise<T>,
  detail?: Record<string, unknown>
): Promise<T> {
  if (!enabled()) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const dt = performance.now() - t0;
    record(name, t0, dt, detail);
    if (dt > 0.5 && consoleEcho()) {
      // eslint-disable-next-line no-console
      console.log(
        `[webgl ${performance.now().toFixed(1).padStart(9, ' ')}] ${name.padEnd(32)} ${dt.toFixed(2)}ms (async)`,
        detail ?? ''
      );
    }
  }
}

export function start(name: string): void {
  if (!enabled()) return;
  pending.set(name, performance.now());
}

export function end(name: string, detail?: Record<string, unknown>): number {
  if (!enabled()) return 0;
  const t0 = pending.get(name);
  if (t0 === undefined) return 0;
  pending.delete(name);
  const dt = performance.now() - t0;
  record(name, t0, dt, detail);
  return dt;
}

function getEntries(): Entry[] {
  if (!filled) return buffer.slice(0, writeIndex);
  return [...buffer.slice(writeIndex), ...buffer.slice(0, writeIndex)];
}

interface OpStats {
  op: string;
  count: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

function computeStats(filter?: RegExp): OpStats[] {
  const buckets = new Map<string, number[]>();
  for (const e of getEntries()) {
    if (e.dt <= 0) continue;
    if (filter && !filter.test(e.name)) continue;
    let arr = buckets.get(e.name);
    if (!arr) {
      arr = [];
      buckets.set(e.name, arr);
    }
    arr.push(e.dt);
  }
  const stats: OpStats[] = [];
  for (const [op, arr] of buckets) {
    arr.sort((a, b) => a - b);
    const total = arr.reduce((s, v) => s + v, 0);
    const pick = (p: number) => arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))];
    stats.push({
      op,
      count: arr.length,
      totalMs: +total.toFixed(2),
      meanMs: +(total / arr.length).toFixed(2),
      p50Ms: +pick(0.5).toFixed(2),
      p95Ms: +pick(0.95).toFixed(2),
      p99Ms: +pick(0.99).toFixed(2),
      maxMs: +arr[arr.length - 1].toFixed(2),
    });
  }
  stats.sort((a, b) => b.totalMs - a.totalMs);
  return stats;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

if (typeof window !== 'undefined' && enabled()) {
  const w = perfWindow()!;
  w.__perfDump = (filter?: string) => {
    const re = filter ? globToRegExp(filter) : undefined;
    const stats = computeStats(re);
    // eslint-disable-next-line no-console
    console.table(stats);
    return stats;
  };
  w.__perfClear = () => {
    buffer.length = 0;
    writeIndex = 0;
    filled = false;
    pending.clear();
  };
  w.__perfEntries = (filter?: string) => {
    const re = filter ? globToRegExp(filter) : undefined;
    return re ? getEntries().filter((e) => re.test(e.name)) : getEntries();
  };

  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const supported = PerformanceObserver.supportedEntryTypes ?? [];
      if (supported.includes('longtask')) {
        const obs = new PerformanceObserver((list) => {
          if (!enabled()) return;
          for (const e of list.getEntries()) {
            const detail: Record<string, unknown> = {};
            const attribution = (
              e as PerformanceEntry & {
                attribution?: Array<{
                  name?: string;
                  containerName?: string;
                  containerSrc?: string;
                }>;
              }
            ).attribution;
            if (attribution && attribution.length > 0) {
              detail.attributionName = attribution[0].name ?? null;
              detail.attributionContainer = attribution[0].containerName ?? null;
              detail.attributionSrc = attribution[0].containerSrc ?? null;
            }
            record('longtask', e.startTime, e.duration, detail);
            if (e.duration > 100) {
              // eslint-disable-next-line no-console
              console.warn(
                `[longtask] ${e.duration.toFixed(1)}ms at ${e.startTime.toFixed(1)}`,
                detail
              );
            }
          }
        });
        obs.observe({ entryTypes: ['longtask'] });
      }
      if (supported.includes('event')) {
        const obs2 = new PerformanceObserver((list) => {
          if (!enabled()) return;
          for (const e of list.getEntries()) {
            if (e.duration < 32) continue;
            const ev = e as PerformanceEntry & {
              name?: string;
              duration: number;
              startTime: number;
              target?: { tagName?: string };
            };
            record('slow-event', e.startTime, e.duration, {
              type: ev.name,
              targetTag: ev.target?.tagName ?? null,
            });
          }
        });
        try {
          obs2.observe({
            type: 'event',
            buffered: true,
            durationThreshold: 32,
          } as PerformanceObserverInit);
        } catch {
          obs2.observe({ entryTypes: ['event'] });
        }
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[perf-log] PerformanceObserver setup failed', err);
  }
}
