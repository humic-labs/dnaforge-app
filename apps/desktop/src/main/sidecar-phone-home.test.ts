import { describe, it, expect, vi, beforeEach } from 'vitest';

const { reportMock } = vi.hoisted(() => ({ reportMock: vi.fn() }));
vi.mock('./diagnostics-upload', () => ({ reportBootOrCrashFailure: reportMock }));
vi.mock('electron', () => ({ app: {}, BrowserWindow: class {} }));
vi.mock('./analytics', () => ({ trackSidecarLifecycleEvent: vi.fn() }));
vi.mock('./sentry', () => ({ captureSidecarLifecycleEvent: vi.fn() }));

import { reportFatalSidecarFailure } from './sidecar';

describe('sidecar fatal → phone-home  item 6)', () => {
  beforeEach(() => reportMock.mockClear());

  it('phones home a namespaced sidecar class for a fatal failure', () => {
    reportFatalSidecarFailure('crash_exit');
    expect(reportMock).toHaveBeenCalledWith('sidecar_crash_exit', 'crash', 'sidecar_crash_exit');
  });
});
