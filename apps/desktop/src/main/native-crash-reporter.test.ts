import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { reportMock, paths } = vi.hoisted(() => ({
  reportMock: vi.fn(),
  paths: { crashDumps: '', userData: '' },
}));
vi.mock('./diagnostics-upload', () => ({ reportBootOrCrashFailure: reportMock }));
vi.mock('electron', () => ({
  crashReporter: { start: vi.fn() },
  app: { getPath: (n: string) => (n === 'crashDumps' ? paths.crashDumps : paths.userData) },
}));

import {
  selectNewNativeDumps,
  reportPriorNativeCrashes,
  startNativeCrashReporter,
} from './native-crash-reporter';
import { crashReporter } from 'electron';

describe('native-crash-reporter  item 5)', () => {
  let root: string;
  const savedDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    reportMock.mockClear();
    vi.mocked(crashReporter.start).mockClear();
    delete process.env.SENTRY_DSN;
    root = mkdtempSync(join(tmpdir(), 'ncr-'));
    paths.crashDumps = join(root, 'dumps');
    paths.userData = join(root, 'user');
    mkdirSync(paths.crashDumps, { recursive: true });
    mkdirSync(paths.userData, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = savedDsn;
  });

  it('selectNewNativeDumps returns dumps newer than the marker and advances it', () => {
    const r = selectNewNativeDumps(
      [
        { name: 'a.dmp', mtimeMs: 100 },
        { name: 'b.dmp', mtimeMs: 300 },
      ],
      200
    );
    expect(r.newDumps).toEqual(['b.dmp']);
    expect(r.newMarkerMs).toBe(300);
  });

  it('starts Crashpad (local capture) only when Sentry is dark; skips when a DSN is set', () => {
    startNativeCrashReporter();
    expect(crashReporter.start).toHaveBeenCalledWith(
      expect.objectContaining({ uploadToServer: false })
    );

    vi.mocked(crashReporter.start).mockClear();
    process.env.SENTRY_DSN = 'https://x@o1.ingest.sentry.io/9';
    startNativeCrashReporter();
    expect(crashReporter.start).not.toHaveBeenCalled();
  });

  it('finds minidumps in Crashpad SUBDIRS (completed/) and phones home once, then not again', () => {
    const completed = join(paths.crashDumps, 'completed');
    mkdirSync(completed, { recursive: true });
    writeFileSync(join(completed, 'crash1.dmp'), 'x');
    writeFileSync(join(paths.crashDumps, 'settings.dat'), 'y');

    reportPriorNativeCrashes();
    expect(reportMock).toHaveBeenCalledWith('native_crash', 'crash', 'native_minidump_x1');
    expect(existsSync(join(paths.userData, '.native-crash-marker'))).toBe(true);

    reportMock.mockClear();
    reportPriorNativeCrashes();
    expect(reportMock).not.toHaveBeenCalled();
  });
});
