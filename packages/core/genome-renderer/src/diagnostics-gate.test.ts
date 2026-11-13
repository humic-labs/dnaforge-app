// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWebGLDiagnosticsEnabled } from './diagnostics-gate';
import { recordWebGLSelectionDebug } from './renderers/pixi/selection-debug';

declare global {
  interface Window {
    __webglDiagnosticsEnabled?: boolean;
    __webglExposeForTests?: boolean;
  }
}

function stubProdEnv(): void {
  vi.stubEnv('DEV', false);
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITEST', 'false');
  delete window.__webglExposeForTests;
  window.__webglDiagnosticsEnabled = false;
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.__webglDiagnosticsEnabled;
  delete window.__webglExposeForTests;
  delete window.__webglSelectionDebug;
  delete window.__webglSelectionDebugLog;
  delete window.__dumpWebGLSelectionDebug;
  delete window.__clearWebGLSelectionDebug;
});

describe('WebGL diagnostics gate', () => {
  it('keeps diagnostics closed when explicitly disabled in production-like runtime', () => {
    stubProdEnv();

    expect(isWebGLDiagnosticsEnabled()).toBe(false);
  });

  it('allows explicit test exposure even in production-like runtime', () => {
    stubProdEnv();
    window.__webglExposeForTests = true;

    expect(isWebGLDiagnosticsEnabled()).toBe(true);
  });

  it('does not create selection debug globals when diagnostics are disabled', () => {
    stubProdEnv();

    recordWebGLSelectionDebug('pointer-move', { bp: 12 });

    expect(window.__webglSelectionDebugLog).toBeUndefined();
    expect(window.__dumpWebGLSelectionDebug).toBeUndefined();
  });

  it('records selection debug when explicitly enabled', () => {
    stubProdEnv();
    window.__webglSelectionDebug = true;

    recordWebGLSelectionDebug('pointer-move', { bp: 12 });

    expect(window.__dumpWebGLSelectionDebug?.()).toMatchObject([
      { event: 'pointer-move', detail: { bp: 12 } },
    ]);
  });
});
