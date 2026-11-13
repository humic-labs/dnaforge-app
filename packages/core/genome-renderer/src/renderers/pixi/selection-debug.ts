import { isWebGLDiagnosticsEnabled } from '../../diagnostics-gate';
import { isWebGLTraceActive } from '../../webgl-registry';

export interface WebGLSelectionDebugEntry {
  t: number;
  wallTime: string;
  event: string;
  detail: Record<string, unknown>;
}

declare global {
  interface Window {
    __webglSelectionDebug?: boolean;
    __webglSelectionDebugLog?: WebGLSelectionDebugEntry[];
    __dumpWebGLSelectionDebug?: () => WebGLSelectionDebugEntry[];
    __clearWebGLSelectionDebug?: () => void;
  }
}

const MAX_SELECTION_DEBUG_ENTRIES = 600;

function shouldRecordSelectionDebug(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.__webglSelectionDebug === true || isWebGLDiagnosticsEnabled() || isWebGLTraceActive()
  );
}

function initSelectionDebugLog(): WebGLSelectionDebugEntry[] | null {
  if (typeof window === 'undefined') return null;
  if (!shouldRecordSelectionDebug()) return null;
  if (!window.__webglSelectionDebugLog) {
    window.__webglSelectionDebugLog = [];
  }
  if (!window.__dumpWebGLSelectionDebug) {
    window.__dumpWebGLSelectionDebug = () => [...(window.__webglSelectionDebugLog ?? [])];
  }
  if (!window.__clearWebGLSelectionDebug) {
    window.__clearWebGLSelectionDebug = () => {
      window.__webglSelectionDebugLog = [];
    };
  }
  return window.__webglSelectionDebugLog;
}

export function recordWebGLSelectionDebug(event: string, detail: Record<string, unknown>): void {
  const log = initSelectionDebugLog();
  if (!log) return;

  const entry: WebGLSelectionDebugEntry = {
    t: +performance.now().toFixed(1),
    wallTime: new Date().toISOString(),
    event,
    detail,
  };
  log.push(entry);
  if (log.length > MAX_SELECTION_DEBUG_ENTRIES) {
    log.splice(0, log.length - MAX_SELECTION_DEBUG_ENTRIES);
  }

  if (window.__webglSelectionDebug) {
    console.info('[webgl-selection-debug]', event, detail);
  }
}
