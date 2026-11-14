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

function safeStringify(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === 'string') return value;
  try {
    if (value instanceof Error) {
      if (seen.has(value) || seen.size >= 4) return '[nested error]';
      seen.add(value);
      const code = Object.getOwnPropertyDescriptor(value, 'code')?.value;
      const cause = Object.getOwnPropertyDescriptor(value, 'cause')?.value;
      const errors = Object.getOwnPropertyDescriptor(value, 'errors')?.value;
      return [
        `${value.name}: ${value.message}`,
        typeof code === 'string' ? `code=${code}` : '',
        cause === undefined ? '' : `cause=${safeStringify(cause, seen)}`,
        Array.isArray(errors)
          ? errors
              .slice(0, 3)
              .map((error) => safeStringify(error, seen))
              .join('; ')
          : '',
        value.stack ?? '',
      ]
        .filter(Boolean)
        .join(' ');
    }
    return JSON.stringify(value) ?? String(value);
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

  const flushNow = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      bridge?.sendBreadcrumbs?.(buffer.snapshot());
    } catch {}
  };

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
        const [first, ...rest] = args;
        const ordered = [
          first,
          ...rest.filter((value) => value instanceof Error),
          ...rest.filter((value) => !(value instanceof Error)),
        ];
        const line = redactTelemetryText(
          `${level}: ${new Date().toISOString()} ${ordered.map((value) => safeStringify(value)).join(' ')}`
        );
        buffer.push(line.slice(0, MAX_LINE_CHARS));
        if (level === 'error' && args.some((value) => value instanceof Error)) flushNow();
        else scheduleFlush();
      } catch {}
      original(...args);
    };
  };

  wrap('warn');
  wrap('error');

  target.addEventListener('pagehide', flushNow);

  return () => {
    if (flushTimer) clearTimeout(flushTimer);
    target.removeEventListener('pagehide', flushNow);
    if (originals.warn) console.warn = originals.warn;
    if (originals.error) console.error = originals.error;
  };
}
