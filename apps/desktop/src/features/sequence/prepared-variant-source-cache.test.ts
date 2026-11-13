// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';

import type { IndexedGenomeVariantSourceState } from '../../shared/indexed-genome';

import {
  clearPreparedVariantSources,
  forgetPreparedVariantSource,
  preparedVariantSourceFromDurable,
  recallPreparedVariantSource,
  rememberPreparedVariantSource,
} from './prepared-variant-source-cache';
import type { PreparedVariantSource } from './variant-client';

const REFERENCES = [{ name: 'chrIV', length: 1_531_933 }] as const;

function generation(canonicalPath: string, size: number) {
  return { canonicalPath, size, mtimeNs: '1', ctimeNs: '1' };
}

const PREPARED: PreparedVariantSource = {
  sourcePath: '/canonical/calls.vcf',
  queryPath: '/cache/calls.vcf.gz',
  indexPath: '/cache/calls.vcf.gz.tbi',
  format: 'vcf',
  label: 'calls.vcf',
  sourceSizeBytes: 1_000,
  sourceMtimeNs: '1',
  sourceIdentity: 'a'.repeat(64),
  sourceGeneration: generation('/canonical/calls.vcf', 1_000),
  queryGeneration: generation('/cache/calls.vcf.gz', 900),
  indexGeneration: generation('/cache/calls.vcf.gz.tbi', 100),
  assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
  matchedReferences: ['chrIV'],
  samples: [],
};

describe('prepared variant source cache', () => {
  beforeEach(() => clearPreparedVariantSources());

  it('recalls a receipt by the requested path and by the canonical path', () => {
    rememberPreparedVariantSource(PREPARED, REFERENCES, '/selected/calls.vcf');
    expect(recallPreparedVariantSource('/selected/calls.vcf', REFERENCES)).toBe(PREPARED);
    expect(recallPreparedVariantSource('/canonical/calls.vcf', REFERENCES)).toBe(PREPARED);
  });

  it('keeps receipts apart by reference set', () => {
    rememberPreparedVariantSource(PREPARED, REFERENCES);
    expect(
      recallPreparedVariantSource('/canonical/calls.vcf', [{ name: 'chrIV', length: 10 }])
    ).toBeNull();
  });

  it('forgets every path that reached a changed source', () => {
    rememberPreparedVariantSource(PREPARED, REFERENCES, '/selected/calls.vcf');
    forgetPreparedVariantSource('/selected/calls.vcf');
    expect(recallPreparedVariantSource('/selected/calls.vcf', REFERENCES)).toBeNull();
    expect(recallPreparedVariantSource('/canonical/calls.vcf', REFERENCES)).toBeNull();
  });

  it('rebuilds a receipt only from a saved local source that carries every generation', () => {
    const saved: IndexedGenomeVariantSourceState = {
      ...PREPARED,
      matchedReferences: ['chrIV'],
      samples: [],
      attachedAt: 1,
    };
    expect(preparedVariantSourceFromDurable(saved)).toEqual(PREPARED);
    expect(preparedVariantSourceFromDurable({ ...saved, queryGeneration: undefined })).toBeNull();
    expect(preparedVariantSourceFromDurable({ ...saved, sourceMtimeNs: undefined })).toBeNull();
  });
});
