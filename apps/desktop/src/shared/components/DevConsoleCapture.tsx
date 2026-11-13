'use client';

import { useEffect } from 'react';
import { platform } from '../../platform';

const DEFAULT_LOG_FILE = 'logs/client.log';

const CUSTOM_LOG_PATH = import.meta.env.VITE_CLIENT_LOG_PATH as string | undefined;

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  source?: string;
}

interface DevConsoleState {
  logBuffer: string[];
  isWriting: boolean;
}

let writeFailed = false;

function getState(): DevConsoleState {
  if (typeof window !== 'undefined') {
    if (!window.__devConsoleState) {
      window.__devConsoleState = {
        logBuffer: [],
        isWriting: false,
        initialized: false,
        flushInterval: null,
      };
      console.info('[DevConsoleCapture] Created window state');
    }
    return window.__devConsoleState;
  }
  console.warn('[DevConsoleCapture] window undefined - using fallback state!');
  return { logBuffer: [], isWriting: false };
}

async function ensureLogDir() {
  try {
    if (CUSTOM_LOG_PATH) {
      const dir = CUSTOM_LOG_PATH.substring(0, CUSTOM_LOG_PATH.lastIndexOf('/'));
      await platform().fs.mkdir(dir, { recursive: true });
    } else {
      const appData = await platform().path.appDataDir();
      await platform().fs.mkdir(`${appData}/logs`, { recursive: true });
    }
  } catch {}
}

async function flushLogs() {
  const state = getState();
  if (writeFailed) {
    state.logBuffer = [];
    return;
  }
  if (state.isWriting || state.logBuffer.length === 0) {
    return;
  }

  state.isWriting = true;
  const logsToWrite = [...state.logBuffer];
  const _count = logsToWrite.length;
  state.logBuffer = [];

  try {
    await ensureLogDir();
    const content = logsToWrite.join('\n') + '\n';

    if (CUSTOM_LOG_PATH) {
      await platform().fs.writeTextFile(CUSTOM_LOG_PATH, content, { append: true });
    } else {
      const appData = await platform().path.appDataDir();
      await platform().fs.writeTextFile(`${appData}/${DEFAULT_LOG_FILE}`, content, {
        append: true,
      });
    }
  } catch (err) {
    writeFailed = true;
    state.logBuffer = [];
    window.__originalConsole?.error?.(
      '[DevConsoleCapture] Log file unavailable; console capture to file is off for this window:',
      err
    );
  } finally {
    state.isWriting = false;
  }
}

function formatLogEntry(entry: LogEntry): string {
  const { timestamp, level, message, source } = entry;
  const sourceStr = source ? ` (${source})` : '';
  return `[${timestamp}] [${level.toUpperCase()}]${sourceStr} ${message}`;
}

function captureLog(level: string, args: unknown[]) {
  if (writeFailed) return;
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

  const entry: LogEntry = { timestamp, level, message };
  state.logBuffer.push(formatLogEntry(entry));

  window.__originalConsole?.log?.(
    `[DevConsoleCapture] Captured: ${level} - buffer size: ${state.logBuffer.length}`
  );

  if (state.logBuffer.length >= 10) {
    flushLogs();
  }
}

export function DevConsoleCapture() {
  useEffect(() => {
    if (import.meta.env.PROD) return;

    if (!window.__trueOriginalConsole) {
      window.__trueOriginalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
        debug: console.debug,
      };
    }

    const originals = window.__trueOriginalConsole;
    window.__originalConsole = originals;

    console.log = (...args: unknown[]) => {
      captureLog('log', args);
      originals.log.apply(console, args);
    };

    console.warn = (...args: unknown[]) => {
      captureLog('warn', args);
      originals.warn.apply(console, args);
    };

    console.error = (...args: unknown[]) => {
      captureLog('error', args);
      originals.error.apply(console, args);
    };

    console.info = (...args: unknown[]) => {
      captureLog('info', args);
      originals.info.apply(console, args);
    };

    console.debug = (...args: unknown[]) => {
      captureLog('debug', args);
      originals.debug.apply(console, args);
    };

    const errorHandler = (event: ErrorEvent) => {
      captureLog('error', [
        `Uncaught Error: ${event.message}`,
        `at ${event.filename}:${event.lineno}:${event.colno}`,
      ]);
    };

    const rejectionHandler = (event: PromiseRejectionEvent) => {
      captureLog('error', ['Unhandled Promise Rejection:', event.reason]);
    };

    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectionHandler);

    const flushInterval = setInterval(flushLogs, 1000);

    const logPath = CUSTOM_LOG_PATH || 'AppData/logs/client.log';
    captureLog('info', [`[DevConsoleCapture] Initialized - logging to ${logPath}`]);

    return () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
      console.info = originals.info;
      console.debug = originals.debug;

      window.removeEventListener('error', errorHandler);
      window.removeEventListener('unhandledrejection', rejectionHandler);
      clearInterval(flushInterval);

      flushLogs();
    };
  }, []);

  return null;
}
