import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { handlers, signalMock, paths } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => void>(),
  signalMock: vi.fn(),
  paths: { userData: '' },
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (e: unknown, p: unknown) => void) =>
      handlers.set(channel, handler),
  },
  app: { getPath: () => paths.userData },
}));
vi.mock('../diagnostics-upload', () => ({ reportRendererErrorSignal: signalMock }));

import { registerDiagnosticsHandlers, writeRendererBreadcrumbs } from './diagnostics';

describe('diagnostics renderer-error handler  item 3)', () => {
  beforeEach(() => {
    handlers.clear();
    signalMock.mockClear();
    registerDiagnosticsHandlers();
  });

  const fire = (payload: unknown) => handlers.get('diagnostics:renderer-error')?.({}, payload);

  it('routes a renderer error as a CLASS-ONLY signal (no bundle) with a namespaced class', () => {
    fire({ errorClass: 'TypeError', source: 'error' });
    expect(signalMock).toHaveBeenCalledWith('renderer_TypeError', 'renderer_error');
  });

  it('routes an unhandled rejection', () => {
    fire({ errorClass: 'RangeError', source: 'unhandledrejection' });
    expect(signalMock).toHaveBeenCalledWith('renderer_RangeError', 'renderer_unhandledrejection');
  });

  it('is defensive against a malformed payload', () => {
    fire(null);
    expect(signalMock).toHaveBeenCalledWith('renderer_error', 'renderer_error');
  });

  it('caps renderer-error reports per session (main-side, not trusting the renderer)', () => {
    for (let i = 0; i < 40; i++) fire({ errorClass: 'TypeError', source: 'error' });
    expect(signalMock).toHaveBeenCalledTimes(25);
  });
});

describe('writeRendererBreadcrumbs  item 4)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crumbs-'));
    paths.userData = root;
    mkdirSync(join(root, 'logs'), { recursive: true });
    registerDiagnosticsHandlers();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('persists breadcrumb lines to logs/renderer-breadcrumbs.log', () => {
    writeRendererBreadcrumbs(['warn: a', 'error: b']);
    const content = readFileSync(join(root, 'logs', 'renderer-breadcrumbs.log'), 'utf8');
    expect(content).toBe('warn: a\nerror: b');
  });

  it('ignores a non-array payload without throwing', () => {
    expect(() => writeRendererBreadcrumbs('not-an-array')).not.toThrow();
  });

  it('preserves the failed save from the previous session when the next renderer starts', () => {
    writeFileSync(join(root, 'logs', 'renderer-breadcrumbs.log'), 'error: prior save EACCES');
    writeRendererBreadcrumbs(['warn: new startup']);
    expect(readFileSync(join(root, 'logs', 'renderer-breadcrumbs.log'), 'utf8')).toBe(
      'error: prior save EACCES\nwarn: new startup'
    );
  });

  it('retains each new breadcrumb once across overlapping snapshots', () => {
    writeRendererBreadcrumbs(['warn: a', 'error: b']);
    writeRendererBreadcrumbs(['warn: a', 'error: b']);
    writeRendererBreadcrumbs(['error: b', 'error: c']);
    expect(readFileSync(join(root, 'logs', 'renderer-breadcrumbs.log'), 'utf8')).toBe(
      'warn: a\nerror: b\nerror: c'
    );
  });

  it('does not drop the final error when a pagehide snapshot immediately follows a flush', () => {
    const fire = (lines: string[]) => handlers.get('diagnostics:breadcrumbs')?.({}, lines);
    fire(['warn: startup']);
    fire(['warn: startup', 'error: save EIO']);
    expect(readFileSync(join(root, 'logs', 'renderer-breadcrumbs.log'), 'utf8')).toContain(
      'error: save EIO'
    );
  });

  it('bounds retained history and preserves the newest error', () => {
    const path = join(root, 'logs', 'renderer-breadcrumbs.log');
    writeFileSync(path, 'old\n'.repeat(30_000));
    writeRendererBreadcrumbs(['error: latest EIO']);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('old\n');
    expect(content.endsWith('error: latest EIO')).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(64 * 1024);
  });
});
