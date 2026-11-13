import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  isCurrentAdmittedTrackSource,
  migrateAdmittedTrackSource,
  requireTrackAdmissionRequest,
  sameAdmittedTrackSourceIdentity,
  type AdmittedTrackSource,
  type QuantitativeColumnSemantics,
  type ScientificTrackKind,
  type TrackLoadResult,
} from './admitted-track-source';

describe('admitted genomic track source contract', () => {
  it('keeps durable source identity separate from short-lived access grants', () => {
    const source: AdmittedTrackSource = {
      admissionVersion: 1,
      uri: 'https://example.org/signal.bw',
      formatId: 'bigwig',
      fingerprint: 'etag:abc',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      quantitativeColumnSemantics: 'continuous-signal',
      assemblyId: 'GRCh38',
      referenceReceipt: {
        assemblyId: 'GRCh38',
        referenceSignature: 'reference-signature',
        sourceSignature: 'source-signature',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 24,
        status: 'compatible',
        checkedAt: '2026-07-28T20:20:00Z',
      },
      provenance: { provider: 'ucsc', track: 'signal' },
    };

    expect(source).not.toHaveProperty('sourceToken');
    expect(source).not.toHaveProperty('session');
    expect(source.scientificKind).toBe('quantitative');
    expect(source.quantitativeColumnSemantics).toBe('continuous-signal');
    expectTypeOf<QuantitativeColumnSemantics>().toEqualTypeOf<
      'continuous-signal' | 'native-interval'
    >();
    expect(sameAdmittedTrackSourceIdentity(source, { ...source })).toBe(true);
    expect(
      sameAdmittedTrackSourceIdentity(source, {
        ...source,
        fingerprint: 'etag:different',
      })
    ).toBe(false);
  });

  it('migrates a legacy direct source into the durable request contract', () => {
    const legacy: AdmittedTrackSource = {
      admissionVersion: 1,
      uri: 'https://example.org/signal.bw',
      input: { kind: 'url', url: 'https://example.org/signal.bw' },
      formatId: 'bigwig',
      fingerprint: 'etag:abc',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'GRCh38',
      referenceReceipt: {
        assemblyId: 'GRCh38',
        referenceSignature: 'reference-signature',
        sourceSignature: 'source-signature',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 24,
        status: 'compatible',
        checkedAt: '2026-07-28T20:20:00.000Z',
      },
      provenance: { provider: 'direct-url' },
    };

    expect(requireTrackAdmissionRequest(legacy)).toMatchObject({
      contract: 'dnaforge.track-admission-request.v1',
      assemblyId: 'GRCh38',
      source: { kind: 'http', url: 'https://example.org/signal.bw' },
      formatId: 'bigwig',
      ingress: { kind: 'session', sessionId: 'legacy-admitted-track' },
    });

    const current = migrateAdmittedTrackSource(legacy);
    expect(current).toMatchObject({
      admissionVersion: 2,
      admittedAt: '2026-07-28T20:20:00.000Z',
      request: {
        source: { kind: 'http', url: 'https://example.org/signal.bw' },
      },
    });
    expect(isCurrentAdmittedTrackSource(current)).toBe(true);
  });

  it('migrates a legacy UCSC source by catalog identity rather than its resolved URL', () => {
    const legacy: AdmittedTrackSource = {
      admissionVersion: 1,
      uri: 'https://download.example.org/resolved-at-admission.bw',
      formatId: 'bigwig',
      fingerprint: 'provider-generation',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'GRCh38',
      referenceReceipt: {
        assemblyId: 'GRCh38',
        referenceSignature: 'reference-signature',
        sourceSignature: 'source-signature',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 24,
        status: 'compatible',
        checkedAt: '2026-07-28T20:20:00.000Z',
      },
      provenance: {
        provider: 'ucsc',
        sourceKind: 'ucsc-hub',
        ucscGenome: 'hg38',
        track: 'labSignal',
        hubUrl: 'https://hub.example.org/hub.txt',
      },
    };

    expect(requireTrackAdmissionRequest(legacy)).toMatchObject({
      source: {
        kind: 'ucsc-track',
        sourceKind: 'ucsc-hub',
        genome: 'hg38',
        track: 'labSignal',
        hubUrl: 'https://hub.example.org/hub.txt',
      },
      ingress: { kind: 'hub' },
    });
  });

  it('rejects malformed current receipts instead of silently falling back to legacy fields', () => {
    const malformed = {
      admissionVersion: 2,
      admittedAt: '2026-07-28T20:20:00.000Z',
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: 'another-assembly',
        source: { kind: 'http', url: 'https://example.org/signal.bw' },
        formatId: 'bigwig',
        ingress: { kind: 'url' },
      },
      uri: 'https://example.org/signal.bw',
      formatId: 'bigwig',
      fingerprint: 'etag:abc',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'GRCh38',
      referenceReceipt: {
        assemblyId: 'GRCh38',
        referenceSignature: 'reference-signature',
        sourceSignature: 'source-signature',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 24,
        status: 'compatible',
        checkedAt: '2026-07-28T20:20:00.000Z',
      },
      provenance: { provider: 'direct-url' },
    } as AdmittedTrackSource;

    expect(() => requireTrackAdmissionRequest(malformed)).toThrow(
      'request assembly another-assembly does not match admitted assembly GRCh38'
    );
    expect(isCurrentAdmittedTrackSource(malformed)).toBe(false);
  });

  it('makes incomplete ready data unrepresentable', () => {
    const complete: TrackLoadResult<readonly number[]> = {
      state: 'ready',
      requestEpoch: 4,
      complete: true,
      data: [1, 2],
    };
    expect(complete.complete).toBe(true);
    expectTypeOf<ScientificTrackKind>().toEqualTypeOf<
      | 'transcript'
      | 'interval'
      | 'quantitative'
      | 'peak'
      | 'repeat'
      | 'reads'
      | 'variants'
      | 'unsupported'
    >();
  });
});
