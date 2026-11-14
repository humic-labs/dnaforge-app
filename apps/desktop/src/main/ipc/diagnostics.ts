import { mainIpc } from '../../shared/ipc-contract';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { reportRendererErrorSignal } from '../diagnostics-upload';
import { readLogTail } from '../boot-log';
import { redactTelemetryText } from '../../shared/redact-telemetry';

const MAX_BREADCRUMB_BYTES = 64 * 1024;
const MAX_RENDERER_ERROR_REPORTS = 25;

let rendererErrorCount = 0;
const previousSnapshots = new Map<number, string[]>();

export function writeRendererBreadcrumbs(lines: unknown, senderId = 0): void {
  try {
    if (!Array.isArray(lines)) return;
    const snapshot = lines
      .filter((line): line is string => typeof line === 'string')
      .slice(-200)
      .map((line) => redactTelemetryText(line).slice(0, 500));
    const previous = previousSnapshots.get(senderId) ?? [];
    let overlap = Math.min(previous.length, snapshot.length);
    while (
      overlap > 0 &&
      !previous.slice(-overlap).every((line, index) => line === snapshot[index])
    )
      overlap -= 1;
    const added = snapshot.slice(overlap);
    if (!added.length) return;
    const logsDir = join(app.getPath('userData'), 'logs');
    mkdirSync(logsDir, { recursive: true });
    const path = join(logsDir, 'renderer-breadcrumbs.log');
    const retained = readLogTail(path, MAX_BREADCRUMB_BYTES);
    const content = Buffer.from([retained, ...added].filter(Boolean).join('\n'), 'utf8');
    let start = Math.max(0, content.length - MAX_BREADCRUMB_BYTES);
    while (start < content.length && (content[start] & 0xc0) === 0x80) start += 1;
    writeFileSync(path, content.subarray(start));
    previousSnapshots.set(senderId, snapshot);
    if (previousSnapshots.size > 32)
      previousSnapshots.delete(previousSnapshots.keys().next().value!);
  } catch {}
}

export function registerDiagnosticsHandlers(): void {
  rendererErrorCount = 0;
  previousSnapshots.clear();

  mainIpc.on('diagnostics:renderer-error', (_event, payload: unknown) => {
    if (rendererErrorCount >= MAX_RENDERER_ERROR_REPORTS) return;
    rendererErrorCount += 1;
    const report = (payload ?? {}) as { errorClass?: unknown; source?: unknown };
    const rawClass = typeof report.errorClass === 'string' ? report.errorClass : 'error';
    const source = report.source === 'unhandledrejection' ? 'unhandledrejection' : 'error';
    reportRendererErrorSignal(`renderer_${rawClass}`, `renderer_${source}`);
  });

  mainIpc.on('diagnostics:breadcrumbs', (event, lines: unknown) => {
    writeRendererBreadcrumbs(lines, event.sender?.id);
  });
}
