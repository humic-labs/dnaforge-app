/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IndexedGenomeVariantSourceState } from '../../../shared/indexed-genome';
import { useLaneContractStore } from '../lane-contract-store';
import { variantTrackId } from '../variant-track-lane';
import { usePersistedVariantTrack } from './usePersistedVariantTrack';

describe('usePersistedVariantTrack', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
  });

  it('projects a durable source and persists explicit gutter removal', async () => {
    const source = variantSource();
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ currentSource }) =>
        usePersistedVariantTrack({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          source: currentSource,
          onChange,
        }),
      { initialProps: { currentSource: source as IndexedGenomeVariantSourceState | null } }
    );

    await waitFor(() =>
      expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(1)
    );
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      useLaneContractStore.getState().removeLane('tab', variantTrackId(source));
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith(null));

    rerender({ currentSource: null });
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual([]);
  });
});

function variantSource(): IndexedGenomeVariantSourceState {
  return {
    sourcePath: '/data/tumor.vcf.gz',
    queryPath: '/cache/tumor.vcf.gz',
    indexPath: '/cache/tumor.vcf.gz.tbi',
    format: 'vcf',
    label: 'Tumor calls',
    sourceSizeBytes: 1_000,
    sourceIdentity: 'a'.repeat(64),
    assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
    matchedReferences: ['chr1'],
    samples: [],
    attachedAt: 1,
    admittedSource: {
      admissionVersion: 2,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: 'grch38',
        source: { kind: 'local-file', path: '/data/tumor.vcf.gz' },
        formatId: 'vcf',
        scientificKind: 'variants',
        ingress: { kind: 'file-picker' },
      },
      admittedAt: '2026-09-21T20:00:00.000Z',
      uri: 'file:///data/tumor.vcf.gz',
      input: { kind: 'path', path: '/data/tumor.vcf.gz' },
      formatId: 'vcf',
      recommendedTypes: ['variant'],
      fingerprint: `sha256:${'c'.repeat(64)}`,
      readerKind: 'variant',
      scientificKind: 'variants',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: `sha256:${'d'.repeat(64)}`,
        sourceSignature: `sha256:${'e'.repeat(64)}`,
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-21T20:00:00.000Z',
      },
      provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'Tumor calls' },
      expectedValidators: { contentLength: 1_000 },
    },
  };
}
