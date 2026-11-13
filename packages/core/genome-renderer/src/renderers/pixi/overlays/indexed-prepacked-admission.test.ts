import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  firstPrepackedMaterializeRejectReason,
  inspectPrepackedMaterializeAdmission,
  isValidPrepackedPolicyContract,
  secondPrepackedMaterializeRejectReason,
} from './indexed-prepacked-admission';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

const none = {
  hasPolicyProjection: false,
  hasPolicyGpuData: false,
  hasRuntimePolicy: false,
  hasSubmissionBank: false,
  hasSubmissionFineIndices: false,
};

describe('isValidPrepackedPolicyContract', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function isValidPrepackedPolicyContract');
    expect(source).not.toContain('function firstPrepackedMaterializeRejectReason');
    expect(source).not.toContain('function inspectPrepackedMaterializeAdmission');
    expect(source).not.toContain('function secondPrepackedMaterializeRejectReason');
  });

  it('accepts a scene with no policy plane at all', () => {
    expect(isValidPrepackedPolicyContract(none)).toBe(true);
  });

  it('accepts either GPU instance data or a direct-submission bank, not both', () => {
    expect(
      isValidPrepackedPolicyContract({
        ...none,
        hasPolicyProjection: true,
        hasRuntimePolicy: true,
        hasPolicyGpuData: true,
      })
    ).toBe(true);
    expect(
      isValidPrepackedPolicyContract({
        ...none,
        hasPolicyProjection: true,
        hasRuntimePolicy: true,
        hasSubmissionBank: true,
        hasSubmissionFineIndices: true,
      })
    ).toBe(true);
    expect(
      isValidPrepackedPolicyContract({
        ...none,
        hasPolicyProjection: true,
        hasRuntimePolicy: true,
        hasPolicyGpuData: true,
        hasSubmissionBank: true,
        hasSubmissionFineIndices: true,
      })
    ).toBe(false);
  });

  it('rejects a partial policy contract', () => {
    expect(
      isValidPrepackedPolicyContract({
        ...none,
        hasPolicyProjection: true,
      })
    ).toBe(false);
    expect(
      isValidPrepackedPolicyContract({
        ...none,
        hasRuntimePolicy: true,
        hasSubmissionBank: true,
      })
    ).toBe(false);
  });
});

describe('firstPrepackedMaterializeRejectReason', () => {
  it('rejects a non-canonical theme, an unselected track, or a source-shape family first', () => {
    expect(
      firstPrepackedMaterializeRejectReason({
        themeMode: 'dark',
        trackType: 'mRNA',
        requestedLayerTypes: ['mRNA'],
        familyKinds: ['transcript'],
      })
    ).toBe('variant-mismatch');
    expect(
      firstPrepackedMaterializeRejectReason({
        themeMode: 'light',
        trackType: 'enhancer',
        requestedLayerTypes: ['mRNA'],
        familyKinds: ['transcript'],
      })
    ).toBe('mixed-layer-fallback');
    expect(
      firstPrepackedMaterializeRejectReason({
        themeMode: 'light',
        trackType: 'mRNA',
        requestedLayerTypes: ['mRNA'],
        familyKinds: ['transcript', 'source'],
      })
    ).toBe('scene-contains-source-shape');
    expect(
      firstPrepackedMaterializeRejectReason({
        themeMode: 'light',
        trackType: 'mRNA',
        requestedLayerTypes: ['mRNA'],
        familyKinds: ['transcript'],
      })
    ).toBeNull();
  });
});

const admissionOk = {
  requestedLayersCovered: true,
  ownerKeyValid: true,
  metadataValid: true,
  trackMatches: true,
  barHeightMatches: true,
  interactionIndexPresent: true,
  viewportDetailValid: true,
  trustedAdmissionCoherent: true,
  hasValidPolicyContract: true,
  runtimePolicyValid: true,
  policyFeatureCountMatches: true,
  partitionSpanMatches: true,
};

describe('inspectPrepackedMaterializeAdmission', () => {
  it('is valid only when every materialize flag is true', () => {
    expect(inspectPrepackedMaterializeAdmission(admissionOk)).toEqual({
      valid: true,
      flags: admissionOk,
    });
    expect(
      inspectPrepackedMaterializeAdmission({
        ...admissionOk,
        barHeightMatches: false,
      }).valid
    ).toBe(false);
    expect(
      inspectPrepackedMaterializeAdmission({
        ...admissionOk,
        trustedAdmissionCoherent: false,
      }).valid
    ).toBe(false);
  });
});

describe('secondPrepackedMaterializeRejectReason', () => {
  it('rejects a genome identity/length change, then a non-WebGL renderer', () => {
    expect(
      secondPrepackedMaterializeRejectReason({
        currentGenomeIdentity: 'hg38',
        metadataGenomeIdentity: 'other',
        genomeLength: 1000,
        metadataGenomeLength: 1000,
        isWebgl: true,
      })
    ).toBe('genome-mismatch');
    expect(
      secondPrepackedMaterializeRejectReason({
        currentGenomeIdentity: 'hg38',
        metadataGenomeIdentity: 'hg38',
        genomeLength: 1000,
        metadataGenomeLength: 1000,
        isWebgl: false,
      })
    ).toBe('unsupported-renderer');
    expect(
      secondPrepackedMaterializeRejectReason({
        currentGenomeIdentity: 'hg38',
        metadataGenomeIdentity: 'hg38',
        genomeLength: 1000,
        metadataGenomeLength: 1000,
        isWebgl: true,
      })
    ).toBeNull();
  });
});
