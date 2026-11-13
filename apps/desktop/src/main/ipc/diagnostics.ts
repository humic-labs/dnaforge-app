import { mainIpc } from '../../shared/ipc-contract';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { reportRendererErrorSignal } from '../diagnostics-upload';

const MAX_BREADCRUMB_CHARS = 64 * 1024;
const MAX_RENDERER_ERROR_REPORTS = 25;
const MIN_BREADCRUMB_WRITE_INTERVAL_MS = 1000;

let rendererErrorCount = 0;
let lastBreadcrumbWriteMs = 0;

export function writeRendererBreadcrumbs(lines: unknown): void {
  try {
    if (!Array.isArray(lines)) return;
    const logsDir = join(app.getPath('userData'), 'logs');
    mkdirSync(logsDir, { recursive: true });
    const content = lines
      .filter((line): line is string => typeof line === 'string')
      .join('\n')
      .slice(-MAX_BREADCRUMB_CHARS);
    writeFileSync(join(logsDir, 'renderer-breadcrumbs.log'), content);
  } catch {}
}

export function registerDiagnosticsHandlers(): void {
  rendererErrorCount = 0;
  lastBreadcrumbWriteMs = 0;

  mainIpc.on('diagnostics:renderer-error', (_event, payload: unknown) => {
    if (rendererErrorCount >= MAX_RENDERER_ERROR_REPORTS) return;
    rendererErrorCount += 1;
    const report = (payload ?? {}) as { errorClass?: unknown; source?: unknown };
    const rawClass = typeof report.errorClass === 'string' ? report.errorClass : 'error';
    const source = report.source === 'unhandledrejection' ? 'unhandledrejection' : 'error';
    reportRendererErrorSignal(`renderer_${rawClass}`, `renderer_${source}`);
  });

  mainIpc.on('diagnostics:breadcrumbs', (_event, lines: unknown) => {
    const now = Date.now();
    if (now - lastBreadcrumbWriteMs < MIN_BREADCRUMB_WRITE_INTERVAL_MS) return;
    lastBreadcrumbWriteMs = now;
    writeRendererBreadcrumbs(lines);
  });
}
