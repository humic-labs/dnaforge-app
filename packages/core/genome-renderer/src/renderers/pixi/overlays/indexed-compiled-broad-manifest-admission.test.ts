import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canAdmitCompiledBroadSurfaceManifest } from './indexed-compiled-broad-manifest-admission';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

const ok = {
  hasManifestObject: true,
  hostGenomeLength: 1000,
  manifestGenomeLength: 1000,
  hasAdmittedSurface: false,
  requirement: null as { genomeLengthBp: number; broadCorridorFinestSpanBp: number } | null,
  manifestBroadCorridorFinestSpanBp: 100,
  themeMode: 'light' as const,
  provenanceFailure: null as string | null,
};

describe('canAdmitCompiledBroadSurfaceManifest', () => {
  it('lives outside annotation-overlay.ts', () => {
    expect(overlaySource()).not.toContain('function canAdmitCompiledBroadSurfaceManifest');
  });

  it('rejects a missing object, length mismatch, wrong theme, or failed provenance', () => {
    expect(canAdmitCompiledBroadSurfaceManifest(ok)).toBe(true);
    expect(canAdmitCompiledBroadSurfaceManifest({ ...ok, hasManifestObject: false })).toBe(false);
    expect(
      canAdmitCompiledBroadSurfaceManifest({
        ...ok,
        hostGenomeLength: 1000,
        manifestGenomeLength: 9,
      })
    ).toBe(false);
    expect(canAdmitCompiledBroadSurfaceManifest({ ...ok, themeMode: 'dark' })).toBe(false);
    expect(canAdmitCompiledBroadSurfaceManifest({ ...ok, provenanceFailure: 'mismatch' })).toBe(
      false
    );
  });

  it('once a surface is admitted, the new manifest must match the armed corridor', () => {
    expect(
      canAdmitCompiledBroadSurfaceManifest({
        ...ok,
        hasAdmittedSurface: true,
        requirement: { genomeLengthBp: 1000, broadCorridorFinestSpanBp: 100 },
      })
    ).toBe(true);
    expect(
      canAdmitCompiledBroadSurfaceManifest({
        ...ok,
        hasAdmittedSurface: true,
        requirement: null,
      })
    ).toBe(false);
    expect(
      canAdmitCompiledBroadSurfaceManifest({
        ...ok,
        hasAdmittedSurface: true,
        requirement: { genomeLengthBp: 1000, broadCorridorFinestSpanBp: 250 },
      })
    ).toBe(false);
  });
});
