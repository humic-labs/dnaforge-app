import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1 } from '../overview/bounded-annotation-broad-surface';
import {
  compiledBroadCompactInteractionResidentMatches,
  compiledBroadInteractionBlockedByDifferentActiveOwner,
  compiledBroadInteractionResidentMatchesOwner,
  compiledBroadSurfaceProvenanceFailure,
  selectUniqueOrActivePrepackedResident,
} from './indexed-compiled-broad-provenance';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

const provenance = {
  contract: COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1,
  manifestFingerprint: 'mf',
  artifactKey: 'art',
  trackId: 'mrna',
  genomeIdentity: 'hg38',
  genomeLengthBp: 1000,
  sourceFingerprint: 'src',
  placementFingerprint: 'plc',
  prepackedOwnerKey: 'owner',
  prepackedArtifactKey: 'part',
};

describe('compiled-broad provenance and interaction join', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function compiledBroadSurfaceProvenanceFailure');
    expect(source).not.toContain('function compiledBroadInteractionResidentMatchesOwner');
    expect(source).not.toContain('function compiledBroadInteractionBlockedByDifferentActiveOwner');
    expect(source).not.toContain('function compiledBroadCompactInteractionResidentMatches');
    expect(source).not.toContain('function selectUniqueOrActivePrepackedResident');
  });

  it('fails closed when provenance is missing or disagrees with the live genome receipt', () => {
    expect(
      compiledBroadSurfaceProvenanceFailure({
        provenance,
        manifest: { manifestFingerprint: 'mf', artifactKey: 'art', trackId: 'mrna' },
        currentGenomeIdentity: 'hg38',
        genomeLengthBp: 1000,
        currentAnnotationSourceFingerprint: 'src',
        currentAnnotationPlacementFingerprint: 'plc',
      })
    ).toBeNull();
    expect(
      compiledBroadSurfaceProvenanceFailure({
        provenance: null,
        manifest: { manifestFingerprint: 'mf', artifactKey: 'art', trackId: 'mrna' },
        currentGenomeIdentity: 'hg38',
        genomeLengthBp: 1000,
        currentAnnotationSourceFingerprint: 'src',
        currentAnnotationPlacementFingerprint: 'plc',
      })
    ).toBe('compiled-broad-surface-provenance-identity-mismatch');
    expect(
      compiledBroadSurfaceProvenanceFailure({
        provenance,
        manifest: { manifestFingerprint: 'mf', artifactKey: 'art', trackId: 'mrna' },
        currentGenomeIdentity: 'hg38',
        genomeLengthBp: 1000,
        currentAnnotationSourceFingerprint: 'other',
        currentAnnotationPlacementFingerprint: 'plc',
      })
    ).toBe('compiled-broad-surface-provenance-identity-mismatch');
  });

  it('joins a resident only to the exact raster-named owner and blocks a different active owner', () => {
    expect(
      compiledBroadInteractionResidentMatchesOwner({
        resident: {
          input: { ownerKey: 'owner' },
          metadata: {
            artifactKey: 'part',
            genomeIdentity: 'hg38',
            genomeLengthBp: 1000,
            trackType: 'mRNA',
          },
        },
        provenance: {
          prepackedOwnerKey: 'owner',
          prepackedArtifactKey: 'part',
          genomeIdentity: 'hg38',
          genomeLengthBp: 1000,
        },
        manifestTrackId: 'mRNA',
      })
    ).toBe(true);
    expect(
      compiledBroadInteractionBlockedByDifferentActiveOwner({
        activeTrackType: 'mRNA',
        activeOwnerKey: 'other',
        trackId: 'mRNA',
        expectedOwnerKey: 'owner',
      })
    ).toBe(true);
    expect(
      compiledBroadInteractionBlockedByDifferentActiveOwner({
        activeTrackType: 'enhancer',
        activeOwnerKey: 'other',
        trackId: 'mrna',
        expectedOwnerKey: 'owner',
      })
    ).toBe(false);
  });

  it('joins compact interaction only to the raster-named owner and source fingerprint', () => {
    expect(
      compiledBroadCompactInteractionResidentMatches({
        resident: {
          ownerKey: 'owner',
          sourceFingerprint: 'src',
          metadata: {
            artifactKey: 'part',
            genomeIdentity: 'hg38',
            genomeLengthBp: 1000,
            trackType: 'mRNA',
          },
        },
        provenance: {
          prepackedOwnerKey: 'owner',
          sourceFingerprint: 'src',
          prepackedArtifactKey: 'part',
          genomeIdentity: 'hg38',
          genomeLengthBp: 1000,
        },
        manifestTrackId: 'mRNA',
      })
    ).toBe(true);
    expect(
      compiledBroadCompactInteractionResidentMatches({
        resident: {
          ownerKey: 'owner',
          sourceFingerprint: 'other',
          metadata: {
            artifactKey: 'part',
            genomeIdentity: 'hg38',
            genomeLengthBp: 1000,
            trackType: 'mRNA',
          },
        },
        provenance: {
          prepackedOwnerKey: 'owner',
          sourceFingerprint: 'src',
          prepackedArtifactKey: 'part',
          genomeIdentity: 'hg38',
          genomeLengthBp: 1000,
        },
        manifestTrackId: 'mrna',
      })
    ).toBe(false);
  });

  it('returns a unique candidate, otherwise only the active owner', () => {
    const a = { ownerKey: 'a', layer: 'la' };
    const b = { ownerKey: 'b', layer: 'lb' };
    expect(
      selectUniqueOrActivePrepackedResident({
        candidates: [a],
        activeOwnerKey: 'x',
        activeLayer: 'lz',
      })
    ).toBe(a);
    expect(
      selectUniqueOrActivePrepackedResident({
        candidates: [a, b],
        activeOwnerKey: 'b',
        activeLayer: 'lb',
      })
    ).toBe(b);
    expect(
      selectUniqueOrActivePrepackedResident({
        candidates: [a, b],
        activeOwnerKey: 'missing',
        activeLayer: 'lz',
      })
    ).toBeNull();
  });
});
