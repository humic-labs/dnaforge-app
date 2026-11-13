import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectCompiledBroadReadyDemandCells } from './indexed-compiled-broad-demand-collect';
import { buildCompiledBroadSurfaceManifestV2 } from '../overview/bounded-annotation-broad-surface';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('collectCompiledBroadReadyDemandCells', () => {
  it('lives outside annotation-overlay.ts', () => {
    expect(overlaySource()).not.toContain('function collectCompiledBroadReadyDemandCells');
  });

  it('puts visible tiles in required and keeps halo tiles from collapsing into required', async () => {
    const manifest = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: 'bounded-annotation-artifact.v1:mrna',
      trackId: 'mrna',
      genomeLengthBp: 3_088_269_832,
      broadCorridorFinestSpanBp: 16_000_000,
      broadTilePhysicalWidthPx: 512,
      broadTileXGuardPhysicalPx: 1,
      prefetchRing: 1,
      maxQualifiedRasterMagnificationX: 1.75,
      rasterDevicePixelRatio: 2,
      laneSlabRowCount: 8,
      laneRowCssHeightPx: 16,
      laneRowTextureStridePx: 32,
      laneRowTransparentTailGutterPx: 4,
      laneRowCounts: { canonical: 12, expanded: 70 },
    });
    const bank = collectCompiledBroadReadyDemandCells({
      manifest,
      plan: {
        isoformMode: 'canonical',
        submittedLaneSlabIds: [0],
        activeLevels: [
          {
            level: 2,
            visibleTilePlacements: [{ tileX: 7 }, { tileX: 8 }],
            residentXTileIds: ['L2:X7', 'L2:X8'],
          },
        ],
      },
      camera: {
        viewportStartBp: 0,
        viewportEndBp: 16_000_000,
        viewportCssWidthPx: 800,
        devicePixelRatio: 2,
      },
    });
    const requiredXs = [...bank.required.values()].map((cell) => cell.tileX).sort((a, b) => a - b);
    expect(requiredXs).toEqual([7, 8]);
    for (const cell of bank.required.values()) {
      expect(bank.successor.has(cell.cellId)).toBe(false);
      expect(bank.prefetch.has(cell.cellId)).toBe(false);
    }
    expect(bank.successor.size).toBeGreaterThan(0);
  });
});
