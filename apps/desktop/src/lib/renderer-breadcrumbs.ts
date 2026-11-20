import { redactTelemetryText } from '../shared/redact-telemetry';

const DEFAULT_CAP = 200;
const MAX_LINE_CHARS = 500;
const FLUSH_DELAY_MS = 2000;
const UUID_ID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const OPAQUE_DOCUMENT_ID = new RegExp(
  `^(?:file-document:|ws(?:0|[1-9][0-9]{0,15})::|${UUID_ID}::)?${UUID_ID}$`,
  'i'
);
const CONTEXT_IDS = ['pageId', 'documentId', 'entityId', 'tabId', 'designId'] as const;
const CONTEXT_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  operation: new Set(['autosave', 'manual', 'flush', 'save', 'save-all']),
  phase: new Set(['autosave', 'manual', 'flush']),
  kind: new Set(['page', 'sequence-document', 'file', 'tab']),
  reason: new Set(['owner-not-unique', 'owner-returned-false']),
};

export interface SampleRegistrationBreadcrumb {
  method: 'createSampleInstance' | 'importManaged' | 'ensureWorkspaceOwner';
  correlation: string;
  phase: 'start' | 'completed' | 'error';
  duration_ms: number;
}

let sampleRegistrationRecorder: ((span: SampleRegistrationBreadcrumb) => void) | undefined;

export function recordSampleRegistrationBreadcrumb(span: SampleRegistrationBreadcrumb): void {
  try {
    sampleRegistrationRecorder?.(span);
  } catch {}
}

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

function safeContextTokens(value: unknown, prefix: '' | 'target.' = ''): string[] {
  if (!value || typeof value !== 'object' || value instanceof Error || Array.isArray(value))
    return [];
  try {
    const tokens: string[] = [];
    for (const [key, allowed] of Object.entries(CONTEXT_VALUES)) {
      const item = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (typeof item === 'string' && allowed.has(item)) tokens.push(`${prefix}${key}=${item}`);
    }
    for (const key of CONTEXT_IDS) {
      const item = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (typeof item === 'string' && OPAQUE_DOCUMENT_ID.test(item))
        tokens.push(`${prefix}${key}=${item}`);
    }
    if (!prefix)
      tokens.push(
        ...safeContextTokens(Object.getOwnPropertyDescriptor(value, 'target')?.value, 'target.')
      );
    return tokens;
  } catch {
    return [];
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

  const previousSampleRecorder = sampleRegistrationRecorder;
  const recordSample = (span: SampleRegistrationBreadcrumb): void => {
    buffer.push(
      redactTelemetryText(
        `sample_registration method=${span.method} correlation=${span.correlation} phase=${span.phase} duration_ms=${span.duration_ms}`
      ).slice(0, MAX_LINE_CHARS)
    );
    scheduleFlush();
  };
  sampleRegistrationRecorder = recordSample;

  const originals: Partial<Record<'warn' | 'error', (...args: unknown[]) => void>> = {};

  const wrap = (level: 'warn' | 'error'): void => {
    const original = console[level].bind(console) as (...args: unknown[]) => void;
    originals[level] = original;
    console[level] = (...args: unknown[]): void => {
      try {
        const [first, ...rest] = args;
        const ordered = [
          first,
          rest.flatMap((value) => safeContextTokens(value)).join(' '),
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
    if (sampleRegistrationRecorder === recordSample)
      sampleRegistrationRecorder = previousSampleRecorder;
    if (flushTimer) clearTimeout(flushTimer);
    target.removeEventListener('pagehide', flushNow);
    if (originals.warn) console.warn = originals.warn;
    if (originals.error) console.error = originals.error;
  };
}
