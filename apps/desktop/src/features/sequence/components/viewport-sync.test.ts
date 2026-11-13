// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { shouldSyncCanvasCenterFromWebGL, shouldSyncViewportCenterToWebGL } from './viewport-sync';

describe('viewer viewport sync boundaries', () => {
  it('does not move WebGL camera center for Canvas layout-only zoom updates', () => {
    expect(
      shouldSyncViewportCenterToWebGL({
        source: 'layout',
        isWebglSyncLocked: true,
        isWebglDrivenEcho: false,
      })
    ).toBe(false);
  });

  it('does move WebGL camera center for Canvas scroll updates when sync is locked', () => {
    expect(
      shouldSyncViewportCenterToWebGL({
        source: 'scroll',
        isWebglSyncLocked: true,
        isWebglDrivenEcho: false,
      })
    ).toBe(true);
  });

  it('does move WebGL camera center for Canvas focal-zoom updates when sync is locked', () => {
    expect(
      shouldSyncViewportCenterToWebGL({
        source: 'zoom',
        isWebglSyncLocked: true,
        isWebglDrivenEcho: false,
      })
    ).toBe(true);
  });

  it('does not bounce WebGL-driven Canvas scroll back into WebGL', () => {
    expect(
      shouldSyncViewportCenterToWebGL({
        source: 'scroll',
        isWebglSyncLocked: true,
        isWebglDrivenEcho: true,
      })
    ).toBe(false);
  });

  it('does not move Canvas 2D center for WebGL zoom-only updates', () => {
    expect(shouldSyncCanvasCenterFromWebGL({ reason: 'zoom', isWebglSyncLocked: true })).toBe(
      false
    );
  });

  it('does move Canvas 2D center for WebGL scroll updates when sync is locked', () => {
    expect(shouldSyncCanvasCenterFromWebGL({ reason: 'scroll', isWebglSyncLocked: true })).toBe(
      true
    );
  });
});
