// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWebGLFrameProbeApi, maybeRecordWebGLFrameProbe } from './webgl-frame-probe';

declare global {
  interface Window {
    __webglDiagnosticsEnabled?: boolean;
    __webglExposeForTests?: boolean;
    __webglFrameProbeEnabled?: boolean;
    __webglFrameProbe?: unknown[];
    __webglFrameProbeClear?: () => void;
    __webglFrameProbeEntries?: () => unknown[];
  }
}

function stubProdEnv(): void {
  vi.stubEnv('DEV', false);
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITEST', 'false');
  delete window.__webglExposeForTests;
  delete window.__webglFrameProbeEnabled;
  window.__webglDiagnosticsEnabled = false;
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.__webglDiagnosticsEnabled;
  delete window.__webglExposeForTests;
  delete window.__webglFrameProbeEnabled;
  delete window.__webglFrameProbe;
  delete window.__webglFrameProbeClear;
  delete window.__webglFrameProbeEntries;
});

describe('WebGL frame probe diagnostics gate', () => {
  it('does not expose frame-probe globals when diagnostics are closed', () => {
    stubProdEnv();

    ensureWebGLFrameProbeApi();

    expect(window.__webglFrameProbe).toBeUndefined();
    expect(window.__webglFrameProbeEntries).toBeUndefined();
  });

  it('allows explicit frame-probe opt-in', () => {
    stubProdEnv();
    window.__webglFrameProbeEnabled = true;

    ensureWebGLFrameProbeApi();

    expect(window.__webglFrameProbeEntries?.()).toEqual([]);
  });

  it('allows test-hook opt-in', () => {
    stubProdEnv();
    window.__webglExposeForTests = true;

    ensureWebGLFrameProbeApi();

    expect(window.__webglFrameProbeEntries?.()).toEqual([]);
  });

  it('records annotation geometry diagnostics from the renderer snapshot', () => {
    stubProdEnv();
    window.__webglFrameProbeEnabled = true;
    const renderer = {
      _timings: { features: 2.5 },
      getRendererDebugSnapshot: () => ({
        annotationOverlay: {
          hitRecords: 7,
          geometryRebuilds: 3,
          geometryCacheHits: 4,
          lastRenderMode: 'rebuild',
          lastGeometryRebuildReasons: ['viewOffset'],
        },
        orfTrack: {
          forwardOrfCount: 11,
          reverseOrfCount: 13,
          overviewBinDrawCount: 17,
          overviewIndividualDrawCount: 19,
          hitCount: 23,
        },
        retainedOverlays: [
          {
            id: 'annotations.overview-bodies',
            supported: true,
            enabled: true,
            mode: 'retained',
            dataBuilds: 1,
            cameraUpdates: 2,
            interactionUpdates: 0,
            fallbackRenders: 0,
            lastFallbackReason: null,
            retainedInstanceCount: 3,
            visibleInstanceCount: 3,
          },
        ],
      }),
    };

    maybeRecordWebGLFrameProbe({
      instanceId: 'probe-test',
      frame: 12,
      sinceLast: 16,
      frameDt: 4,
      state: {
        zoom: 1,
        viewOffset: 0.25,
        width: 800,
        height: 300,
      } as never,
      renderer: renderer as never,
      app: { stage: { children: [{}] } } as never,
    });

    expect(window.__webglFrameProbeEntries?.()).toMatchObject([
      {
        renderedAnnotationCount: 7,
        annotationGeometryRebuilds: 3,
        annotationGeometryCacheHits: 4,
        annotationLastRenderMode: 'rebuild',
        annotationLastRebuildReasons: ['viewOffset'],
        orfTrack: {
          forwardOrfCount: 11,
          reverseOrfCount: 13,
          overviewBinDrawCount: 17,
          overviewIndividualDrawCount: 19,
          hitCount: 23,
        },
        retainedOverlays: [
          {
            id: 'annotations.overview-bodies',
            mode: 'retained',
            dataBuilds: 1,
            cameraUpdates: 2,
          },
        ],
      },
    ]);
  });

  it('falls back to the annotation overlay snapshot if the renderer snapshot is unavailable', () => {
    stubProdEnv();
    window.__webglFrameProbeEnabled = true;
    const renderer = {
      _timings: { features: 1 },
      getRendererDebugSnapshot: () => {
        throw new Error('debug snapshot unavailable');
      },
      annotationOverlay: {
        getDebugSnapshot: () => ({
          hitRecords: 5,
          geometryRebuilds: 2,
          geometryCacheHits: 8,
          lastRenderMode: 'cache-hit',
          lastGeometryRebuildReasons: [],
        }),
      },
    };

    maybeRecordWebGLFrameProbe({
      instanceId: 'probe-fallback-test',
      frame: 13,
      sinceLast: 16,
      frameDt: 3,
      state: {
        zoom: 1,
        viewOffset: 0.1,
        width: 800,
        height: 300,
      } as never,
      renderer: renderer as never,
      app: { stage: { children: [] } } as never,
    });

    expect(window.__webglFrameProbeEntries?.()).toMatchObject([
      {
        renderedAnnotationCount: 5,
        annotationGeometryRebuilds: 2,
        annotationGeometryCacheHits: 8,
        annotationLastRenderMode: 'cache-hit',
        annotationLastRebuildReasons: [],
      },
    ]);
  });
});
