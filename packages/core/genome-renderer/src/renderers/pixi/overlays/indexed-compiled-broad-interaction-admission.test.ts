import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1 } from '../overview/compiled-broad-annotation-interaction-binary-v1';
import {
  compiledBroadAnnotationInteractionConflictsWithExisting,
  isCompiledBroadAnnotationInteractionAdmissible,
} from './indexed-compiled-broad-interaction-admission';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

const SHA24 = 'ab'.repeat(12);
const SHA64 = 'cd'.repeat(32);

const valid = {
  ownerKey: 'owner-a',
  validationMarker: TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1,
  sourceFingerprint: SHA24,
  interactionPayloadSha256: SHA64,
  sourceScene: {
    byteCount: 64,
    payloadSha256: SHA64,
    contractSha256: SHA64,
  },
  metadataValid: true,
  metadataGenomeIdentity: 'hg38',
  metadataGenomeLengthBp: 1000,
  currentGenomeIdentity: 'hg38',
  currentGenomeLengthBp: 1000,
  policyFeatureCount: 4,
  lookupFeatureCount: 4,
};

describe('compiled-broad interaction admission', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function isCompiledBroadAnnotationInteractionAdmissible');
    expect(source).not.toContain(
      'function compiledBroadAnnotationInteractionConflictsWithExisting'
    );
  });

  it('accepts a digest-joined trusted interaction for the live genome', () => {
    expect(isCompiledBroadAnnotationInteractionAdmissible(valid)).toBe(true);
  });

  it('rejects a missing marker, bad digest, genome mismatch, or feature-count split', () => {
    expect(
      isCompiledBroadAnnotationInteractionAdmissible({
        ...valid,
        validationMarker: 'nope',
      })
    ).toBe(false);
    expect(
      isCompiledBroadAnnotationInteractionAdmissible({
        ...valid,
        sourceFingerprint: 'zz',
      })
    ).toBe(false);
    expect(
      isCompiledBroadAnnotationInteractionAdmissible({
        ...valid,
        currentGenomeIdentity: 'other',
      })
    ).toBe(false);
    expect(
      isCompiledBroadAnnotationInteractionAdmissible({
        ...valid,
        policyFeatureCount: 4,
        lookupFeatureCount: 5,
      })
    ).toBe(false);
  });

  it('treats a same-owner digest or metadata change as a conflict', () => {
    const existing = {
      sourceFingerprint: SHA24,
      interactionPayloadSha256: SHA64,
      sourceScene: { byteCount: 64, payloadSha256: SHA64, contractSha256: SHA64 },
      metadata: { trackType: 'mRNA' },
    };
    expect(
      compiledBroadAnnotationInteractionConflictsWithExisting({
        existing,
        candidate: {
          sourceFingerprint: SHA24,
          interactionPayloadSha256: SHA64,
          sourceScene: { byteCount: 64, payloadSha256: SHA64, contractSha256: SHA64 },
          metadata: { trackType: 'mRNA' },
        },
        metadataEqual: true,
      })
    ).toBe(false);
    expect(
      compiledBroadAnnotationInteractionConflictsWithExisting({
        existing,
        candidate: {
          sourceFingerprint: SHA24,
          interactionPayloadSha256: 'ee'.repeat(32),
          sourceScene: { byteCount: 64, payloadSha256: SHA64, contractSha256: SHA64 },
          metadata: { trackType: 'mRNA' },
        },
        metadataEqual: true,
      })
    ).toBe(true);
  });
});
