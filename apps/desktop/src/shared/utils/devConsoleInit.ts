import { platform } from '../../platform';

const _DEFAULT_LOG_FILE = 'logs/client.log';
const CUSTOM_LOG_PATH = import.meta.env.VITE_CLIENT_LOG_PATH as string | undefined;

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

interface DevConsoleState {
  logBuffer: string[];
  isWriting: boolean;
  initialized: boolean;
  flushInterval: ReturnType<typeof setInterval> | null;
}

declare global {
  interface Window {
    __devConsoleState?: DevConsoleState;
    __originalConsole?: {
      log: typeof console.log;
      warn: typeof console.warn;
      error: typeof console.error;
      info: typeof console.info;
      debug: typeof console.debug;
    };
    __trueOriginalConsole?: {
      log: typeof console.log;
      warn: typeof console.warn;
      error: typeof console.error;
      info: typeof console.info;
      debug: typeof console.debug;
    };
  }
}

function getState(): DevConsoleState {
  if (typeof window !== 'undefined') {
    if (!window.__devConsoleState) {
      window.__devConsoleState = {
        logBuffer: [],
        isWriting: false,
        initialized: false,
        flushInterval: null,
      };
    }
    return window.__devConsoleState!;
  }
  return { logBuffer: [], isWriting: false, initialized: false, flushInterval: null };
}

async function ensureLogDir() {
  try {
    if (CUSTOM_LOG_PATH) {
      const dir = CUSTOM_LOG_PATH.substring(0, CUSTOM_LOG_PATH.lastIndexOf('/'));
      await platform().fs.mkdir(dir, { recursive: true });
    }
  } catch {}
}

async function flushLogs() {
  const state = getState();
  if (state.isWriting || state.logBuffer.length === 0) {
    return;
  }

  let bridge: ReturnType<typeof platform> | null = null;
  try {
    bridge = platform();
  } catch {
    return;
  }

  state.isWriting = true;
  const logsToWrite = [...state.logBuffer];
  const count = logsToWrite.length;
  state.logBuffer = [];

  try {
    await ensureLogDir();
    const content = logsToWrite.join('\n') + '\n';

    if (CUSTOM_LOG_PATH) {
      await bridge.fs.writeTextFile(CUSTOM_LOG_PATH, content, { append: true });
    }
    window.__originalConsole?.log?.(`[DevConsole] Flushed ${count} logs`);
  } catch (err) {
    window.__originalConsole?.error?.('[DevConsole] Failed to write logs:', err);
  } finally {
    state.isWriting = false;
  }
}

function formatLogEntry(entry: LogEntry): string {
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`;
}

function captureLog(level: string, args: unknown[]) {
  const state = getState();
  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');

  state.logBuffer.push(formatLogEntry({ timestamp, level, message }));

  if (state.logBuffer.length >= 10) {
    flushLogs();
  }
}

export function initDevConsole(): void {
  if (import.meta.env.PROD) return;

  const state = getState();
  if (state.initialized) return;
  state.initialized = true;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  window.__originalConsole = {
    log: originalLog,
    warn: originalWarn,
    error: originalError,
    info: originalInfo,
    debug: originalDebug,
  };

  console.log = (...args) => {
    captureLog('log', args);
    originalLog.apply(console, args);
  };

  console.warn = (...args) => {
    captureLog('warn', args);
    originalWarn.apply(console, args);
  };

  console.error = (...args) => {
    captureLog('error', args);
    originalError.apply(console, args);
  };

  console.info = (...args) => {
    captureLog('info', args);
    originalInfo.apply(console, args);
  };

  console.debug = (...args) => {
    captureLog('debug', args);
    originalDebug.apply(console, args);
  };

  window.addEventListener('error', (event: ErrorEvent) => {
    captureLog('error', [
      `Uncaught Error: ${event.message}`,
      `at ${event.filename}:${event.lineno}:${event.colno}`,
    ]);
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    captureLog('error', ['Unhandled Promise Rejection:', event.reason]);
  });

  state.flushInterval = setInterval(flushLogs, 1000);

  const logPath = CUSTOM_LOG_PATH || 'AppData/logs/client.log';
  captureLog('info', [`[DevConsole] Initialized - logging to ${logPath}`]);
}
