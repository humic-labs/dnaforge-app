import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compiledBroadSurfaceAdmissionIdentityMatches,
  shouldClearCompiledBroadOnGenomeChange,
} from './indexed-compiled-broad-identity';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('compiled-broad identity gates', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function shouldClearCompiledBroadOnGenomeChange');
    expect(source).not.toContain('function compiledBroadSurfaceAdmissionIdentityMatches');
  });

  it('clears compiled-broad only when a live surface disagrees with the next genome', () => {
    expect(
      shouldClearCompiledBroadOnGenomeChange({
        hasCompiledSurface: false,
        currentLength: 100,
        nextLength: 200,
        previousGenomeIdentity: 'a',
        nextGenomeIdentity: 'b',
        compiledAuthority: null,
        nextProvenance: null,
      })
    ).toBe(false);
    expect(
      shouldClearCompiledBroadOnGenomeChange({
        hasCompiledSurface: true,
        currentLength: 100,
        nextLength: 200,
        previousGenomeIdentity: 'a',
        nextGenomeIdentity: 'a',
        compiledAuthority: null,
        nextProvenance: null,
      })
    ).toBe(true);
    expect(
      shouldClearCompiledBroadOnGenomeChange({
        hasCompiledSurface: true,
        currentLength: 100,
        nextLength: 100,
        previousGenomeIdentity: 'old',
        nextGenomeIdentity: 'new',
        compiledAuthority: null,
        nextProvenance: null,
      })
    ).toBe(true);
    expect(
      shouldClearCompiledBroadOnGenomeChange({
        hasCompiledSurface: true,
        currentLength: 100,
        nextLength: 100,
        previousGenomeIdentity: 'a',
        nextGenomeIdentity: 'a',
        compiledAuthority: { sourceFingerprint: 's1', placementFingerprint: 'p1' },
        nextProvenance: { sourceFingerprint: 's2', placementFingerprint: 'p1' },
      })
    ).toBe(true);
    expect(
      shouldClearCompiledBroadOnGenomeChange({
        hasCompiledSurface: true,
        currentLength: 100,
        nextLength: 100,
        previousGenomeIdentity: 'a',
        nextGenomeIdentity: 'a',
        compiledAuthority: { sourceFingerprint: 's1', placementFingerprint: 'p1' },
        nextProvenance: { sourceFingerprint: 's1', placementFingerprint: 'p1' },
      })
    ).toBe(false);
  });

  it('requires every owner and provenance identity field to match', () => {
    const same = {
      manifestFingerprint: 'mf',
      artifactKey: 'art',
      trackId: 'mrna',
      contract: 'c',
      genomeIdentity: 'hg38',
      genomeLengthBp: 1000,
      sourceFingerprint: 'src',
      placementFingerprint: 'plc',
      themeMode: 'light',
      prepackedOwnerKey: 'owner',
      prepackedArtifactKey: 'part',
    };
    expect(
      compiledBroadSurfaceAdmissionIdentityMatches({
        ownerManifest: same,
        ownerProvenance: same,
        nextManifest: same,
        nextProvenance: same,
      })
    ).toBe(true);
    expect(
      compiledBroadSurfaceAdmissionIdentityMatches({
        ownerManifest: same,
        ownerProvenance: same,
        nextManifest: { ...same, artifactKey: 'other' },
        nextProvenance: same,
      })
    ).toBe(false);
  });
});
