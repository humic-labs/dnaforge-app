import { redactTelemetryText } from '../shared/redact-telemetry';

const DEFAULT_CAP = 200;
const MAX_LINE_CHARS = 500;
const FLUSH_DELAY_MS = 2000;

export interface BreadcrumbBuffer {
  push(line: string): void;
  snapshot(): string[];
}

export function createBreadcrumbBuffer(cap = DEFAULT_CAP): BreadcrumbBuffer {
  const lines: string[] = [];
  return {
    push(line: string): void {
      lines.push(line);
      if (lines.length > cap) lines.splice(0, lines.length - cap);
    },
    snapshot(): string[] {
      return lines.slice();
    },
  };
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface BreadcrumbBridge {
  sendBreadcrumbs?: (lines: string[]) => void;
}

export function installBreadcrumbCapture(target: Window = window): () => void {
  const buffer = createBreadcrumbBuffer();
  const bridge = (target as Window & { electronAPI?: BreadcrumbBridge }).electronAPI;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleFlush = (): void => {
    if (flushTimer || !bridge?.sendBreadcrumbs) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        bridge.sendBreadcrumbs?.(buffer.snapshot());
      } catch {}
    }, FLUSH_DELAY_MS);
  };

  const originals: Partial<Record<'warn' | 'error', (...args: unknown[]) => void>> = {};

  const wrap = (level: 'warn' | 'error'): void => {
    const original = console[level].bind(console) as (...args: unknown[]) => void;
    originals[level] = original;
    console[level] = (...args: unknown[]): void => {
      try {
        const line = redactTelemetryText(`${level}: ${args.map(safeStringify).join(' ')}`);
        buffer.push(line.slice(0, MAX_LINE_CHARS));
        scheduleFlush();
      } catch {}
      original(...args);
    };
  };

  wrap('warn');
  wrap('error');

  const flushNow = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      bridge?.sendBreadcrumbs?.(buffer.snapshot());
    } catch {}
  };
  target.addEventListener('pagehide', flushNow);

  return () => {
    if (flushTimer) clearTimeout(flushTimer);
    target.removeEventListener('pagehide', flushNow);
    if (originals.warn) console.warn = originals.warn;
    if (originals.error) console.error = originals.error;
  };
}
