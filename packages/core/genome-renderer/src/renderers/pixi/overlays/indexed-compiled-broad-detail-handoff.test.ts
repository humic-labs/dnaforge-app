import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectCompiledBroadDetailHandoffCells } from './indexed-compiled-broad-detail-handoff';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('collectCompiledBroadDetailHandoffCells', () => {
  it('lives outside annotation-overlay.ts', () => {
    expect(overlaySource()).not.toContain('function collectCompiledBroadDetailHandoffCells');
  });

  it('skips when there is no detail corridor and the plan is still broad', () => {
    expect(
      collectCompiledBroadDetailHandoffCells({
        detail: undefined,
        planStatus: 'broad-ready',
        ownsViewport: false,
        manifest: {} as never,
        planIsoformMode: 'canonical',
        resolvedPolicy: { isoformMode: 'canonical', laneLimit: 1 },
        camera: {
          viewportStartBp: 0,
          viewportEndBp: 100,
          viewportCssWidthPx: 800,
          devicePixelRatio: 2,
        },
      })
    ).toEqual({ status: 'skipped' });
  });

  it('skips a retained detail corridor once broad owns the camera', () => {
    expect(
      collectCompiledBroadDetailHandoffCells({
        detail: {
          coverageStartBp: -100,
          coverageEndBp: -1,
          handoffStartBp: -100,
          handoffEndBp: -1,
        },
        planStatus: 'broad-ready',
        ownsViewport: true,
        manifest: {} as never,
        planIsoformMode: 'canonical',
        resolvedPolicy: { isoformMode: 'canonical', laneLimit: 1 },
        camera: {
          viewportStartBp: 0,
          viewportEndBp: 100,
          viewportCssWidthPx: 800,
          devicePixelRatio: 2,
        },
      })
    ).toEqual({ status: 'skipped' });
  });
});
