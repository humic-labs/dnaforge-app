import { canvasTestWindow } from './canvas-test-bridge';

export function visiblePaintedBandMidpoint(
  top: number,
  height: number,
  viewportHeight: number,
  dpr = 1
): number | null {
  const start = Math.max(0, top),
    end = Math.min(viewportHeight, top + height);
  if (!(end > start) || !(dpr > 0)) return null;
  const firstPixel = Math.max(0, Math.ceil(start * dpr - 0.5));
  const lastPixel = Math.min(Math.ceil(viewportHeight * dpr) - 1, Math.ceil(end * dpr - 0.5) - 1);
  if (lastPixel < firstPixel) return null;
  return Math.max(firstPixel, Math.min(lastPixel, Math.round(((start + end) / 2) * dpr))) / dpr;
}

export type DiagEvent =
  | { t: number; type: 'scroll'; scrollTop: number; scrollHeight: number; clientHeight: number }
  | {
      t: number;
      type: 'scroll-handler';
      scrollTop: number;
      height: number;
      drawAvailable: boolean;
      drawDispatchMs: number;
      visibleRangeMs: number;
      totalMs: number;
    }
  | {
      t: number;
      type: 'minimap-viewport';
      scrollTop: number;
      height: number;
      totalHeight: number;
      durMs: number;
    }
  | {
      t: number;
      type: 'scroll-raf';
      scrollTop: number;
      height: number;
      centerMs: number;
      visibleRangeMs: number;
      totalMs: number;
    }
  | {
      t: number;
      type: 'layout';
      totalHeight: number;
      totalLineCount: number;
      lineH: number;
      lazyMode: boolean;
      computeRangeFirst: number;
      computeRangeLast: number;
      sequenceLength: number;
      isCircular: boolean;
    }
  | {
      t: number;
      type: 'ref-update';
      name: string;
      prev: unknown;
      next: unknown;
    }
  | {
      t: number;
      type: 'render-frame';
      durMs: number;
      layoutMs: number;
      drawMs: number;
      source?: 'main' | 'worker';
      visibleLineCount?: number;
      visibleAnnotationCount?: number;
      annotationsMs?: number;
      sequenceMs?: number;
      complementMs?: number;
      otherMs?: number;
      backgroundMs?: number;
      translationMs?: number;
      rulerMs?: number;
      viewportSeq?: number;
      viewportRequestSeq?: number;
      viewportLatencyMs?: number;
      viewportReason?: 'scroll' | 'draw';
      scrollTop?: number;
      height?: number;
    }
  | {
      t: number;
      type: 'worker-viewport-request';
      requestSeq: number;
      scrollTop: number;
      height: number;
      reason: 'scroll' | 'draw';
    }
  | {
      t: number;
      type: 'worker-viewport-post';
      requestSeq: number;
      viewportSeq: number;
      scrollTop: number;
      height: number;
      reason: 'scroll' | 'draw';
      queueDelayMs: number;
    }
  | {
      t: number;
      type: 'worker-viewport-complete';
      requestSeq?: number;
      viewportSeq: number;
      scrollTop: number;
      height: number;
      reason?: 'scroll' | 'draw';
      latencyMs?: number;
      durMs: number;
      cullMs: number;
      renderMs: number;
      visibleLineCount?: number;
    }
  | { t: number; type: 'console'; level: 'log' | 'warn' | 'error'; msg: string }
  | { t: number; type: 'error'; msg: string; stack?: string }
  | { t: number; type: 'marker'; label: string; data?: Record<string, unknown> };

export type DiagEventType = DiagEvent['type'];

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DiagEventInput = DistributiveOmit<DiagEvent, 't'>;

export type DiagSubscriber = (e: DiagEvent) => void;

const RING_CAPACITY = 50_000;

interface ConsoleHandlers {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

class Diagnostics {
  enabled = false;
  private buf: DiagEvent[] = [];
  private head = 0;
  private size = 0;
  private originalConsole: ConsoleHandlers | null = null;
  private subscribers = new Set<DiagSubscriber>();

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.installConsoleHooks();
    this.installErrorHooks();
  }

  disable(): void {
    this.enabled = false;
    this.restoreConsoleHooks();
  }

  capture(e: DiagEventInput): void {
    if (!this.enabled) return;
    const event = { ...e, t: performance.now() } as DiagEvent;
    if (this.size < RING_CAPACITY) {
      this.buf.push(event);
      this.size++;
    } else {
      this.buf[this.head] = event;
      this.head = (this.head + 1) % RING_CAPACITY;
    }

    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {}
    }
  }

  subscribe(fn: DiagSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  events(): DiagEvent[] {
    if (this.size < RING_CAPACITY) return [...this.buf];
    const out: DiagEvent[] = new Array(RING_CAPACITY);
    for (let i = 0; i < RING_CAPACITY; i++) {
      out[i] = this.buf[(this.head + i) % RING_CAPACITY];
    }
    return out;
  }

  eventsOfType<T extends DiagEventType>(...types: T[]): Extract<DiagEvent, { type: T }>[] {
    return this.events().filter((e) => (types as string[]).includes(e.type)) as Extract<
      DiagEvent,
      { type: T }
    >[];
  }

  count(pred: (e: DiagEvent) => boolean): number {
    let n = 0;
    for (const e of this.events()) if (pred(e)) n++;
    return n;
  }

  clear(): void {
    this.buf.length = 0;
    this.head = 0;
    this.size = 0;
  }

  snapshot(): {
    events: DiagEvent[];
    eventCounts: Record<DiagEventType, number>;
    firstT: number | null;
    lastT: number | null;
  } {
    const events = this.events();
    const counts = Object.create(null) as Record<string, number>;
    for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
    return {
      events,
      eventCounts: counts as Record<DiagEventType, number>,
      firstT: events[0]?.t ?? null,
      lastT: events[events.length - 1]?.t ?? null,
    };
  }

  private installConsoleHooks(): void {
    if (this.originalConsole || typeof console === 'undefined') return;
    const original: ConsoleHandlers = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    this.originalConsole = original;

    const stringify = (args: unknown[]): string =>
      args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');

    console.log = (...args: unknown[]) => {
      this.capture({ type: 'console', level: 'log', msg: stringify(args) });
      original.log(...args);
    };
    console.warn = (...args: unknown[]) => {
      this.capture({ type: 'console', level: 'warn', msg: stringify(args) });
      original.warn(...args);
    };
    console.error = (...args: unknown[]) => {
      this.capture({ type: 'console', level: 'error', msg: stringify(args) });
      original.error(...args);
    };
  }

  private restoreConsoleHooks(): void {
    if (!this.originalConsole) return;
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    this.originalConsole = null;
  }

  private installErrorHooks(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (ev) => {
      this.capture({
        type: 'error',
        msg: ev.message ?? String(ev.error),
        stack: ev.error?.stack,
      });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = (ev as PromiseRejectionEvent).reason;
      this.capture({
        type: 'error',
        msg: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });
  }
}

export const diag = new Diagnostics();

if (typeof window !== 'undefined') {
  const w = canvasTestWindow(window);
  w.__diag = diag;
  const isDev = import.meta.env.DEV === true;
  const optIn = w.__enableDiag === true;
  if (isDev || optIn) {
    diag.enable();
  }
}
