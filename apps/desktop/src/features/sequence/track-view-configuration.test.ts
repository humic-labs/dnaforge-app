// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { trackViewFixture } from '../../shared/track-view-fixture';
import { parseTrackViewDocument } from '../../shared/track-view';
import {
  trackViewConfigurationKey,
  trackViewMatchesSavedConfiguration,
} from './track-view-configuration';

describe('saved view configuration comparison', () => {
  it('accepts newly discovered identity for an older view while retaining edit detection', () => {
    const saved = parseTrackViewDocument(JSON.stringify(trackViewFixture()));
    const current = {
      ...saved,
      reference: { ...saved.reference, sequenceIdentity: 'a'.repeat(64) },
    };
    expect(trackViewMatchesSavedConfiguration(current, saved)).toBe(true);
    expect(
      trackViewMatchesSavedConfiguration(
        { ...current, viewport: { start0: 200, end0: 900 } },
        saved
      )
    ).toBe(false);
  });

  it('requires a recorded reference identity to remain present and unchanged', () => {
    const legacy = parseTrackViewDocument(JSON.stringify(trackViewFixture()));
    const saved = {
      ...legacy,
      reference: { ...legacy.reference, sequenceIdentity: 'a'.repeat(64) },
    };
    expect(trackViewMatchesSavedConfiguration(saved, saved)).toBe(true);
    expect(trackViewMatchesSavedConfiguration(legacy, saved)).toBe(false);
    expect(
      trackViewMatchesSavedConfiguration(
        { ...saved, reference: { ...saved.reference, sequenceIdentity: 'b'.repeat(64) } },
        saved
      )
    ).toBe(false);
  });

  it('ignores reference cache and document metadata while detecting identity, viewport, policy and visibility edits', () => {
    const original = parseTrackViewDocument(JSON.stringify(trackViewFixture()));
    const key = trackViewConfigurationKey(original);
    expect(
      trackViewConfigurationKey({
        ...original,
        name: 'Another name',
        updatedAt: new Date().toISOString(),
        reference: { ...original.reference, sourceFingerprint: null },
      } as typeof original)
    ).toBe(key);
    for (const updated of [
      { ...original, reference: { ...original.reference, assemblyId: 'another-reference' } },
      { ...original, viewport: { start0: 500, end0: 1000 } },
      {
        ...original,
        annotation: {
          ...original.annotation,
          policy: { ...original.annotation.policy, laneLimit: 8 },
        },
      },
      { ...original, annotation: { ...original.annotation, visibilityByTrackId: { mRNA: false } } },
      {
        ...original,
        signalReadPileupViews: [
          {
            contract: 'dnaforge.signal-read-pileup-view.v1' as const,
            trackId: 'combined',
            readsTrackId: 'reads',
            signalTrackId: 'signal',
            label: 'Coverage to reads',
            visible: true,
            color: 0xa8ceff,
            trackPx: 276,
            laneHeightPx: 3,
            maxLanes: 80,
            overflowBandHeightPx: 36,
            coverageCutoffDepth: 80,
            loadingAnimation: 'diagonal-scan' as const,
          },
        ],
      },
    ])
      expect(trackViewConfigurationKey(updated)).not.toBe(key);
  });

  it('does not mark a reopened track dirty merely because it was re-admitted later', () => {
    const original = parseTrackViewDocument(
      JSON.stringify({
        ...trackViewFixture(),
        dataTracks: [
          {
            trackId: 'data:signal',
            trackType: 'quantitative',
            label: 'Signal',
            color: 0x2563eb,
            trackPx: 128,
            laneHeightPx: 8,
            maxLanes: 32,
            visible: true,
            source: {
              uri: 'https://results.example.org/signal.bw',
              input: { kind: 'url', url: 'https://results.example.org/signal.bw' },
              formatId: 'bigwig',
              admissionVersion: 2,
              request: {
                contract: 'dnaforge.track-admission-request.v1',
                assemblyId: 'local-1234567890abcdef12345678',
                source: { kind: 'http', url: 'https://results.example.org/signal.bw' },
                formatId: 'bigwig',
                scientificKind: 'quantitative',
                ingress: { kind: 'catalog' },
              },
              admittedAt: '2026-09-21T18:00:00.000Z',
              fingerprint: 'signal-fingerprint',
              readerKind: 'bbi',
              scientificKind: 'quantitative',
              assemblyId: 'local-1234567890abcdef12345678',
              referenceReceipt: {
                assemblyId: 'local-1234567890abcdef12345678',
                referenceSignature: 'reference-signature',
                sourceSignature: 'source-signature',
                contigMap: { pUC19: 'pUC19' },
                checkedContigs: 1,
                status: 'compatible',
                checkedAt: '2026-09-21T18:00:00.000Z',
              },
              provenance: { provider: 'direct-url', label: 'Signal' },
            },
          },
        ],
      })
    );
    const reAdmitted = {
      ...original,
      dataTracks: original.dataTracks.map((track) => ({
        ...track,
        source: {
          ...track.source,
          admittedAt: '2030-01-02T03:04:05.000Z',
          referenceReceipt: {
            ...track.source.referenceReceipt,
            checkedAt: '2030-01-02T03:04:05.000Z',
          },
        },
      })),
    };
    expect(trackViewConfigurationKey(reAdmitted)).toBe(trackViewConfigurationKey(original));
    expect(
      trackViewConfigurationKey({
        ...reAdmitted,
        dataTracks: reAdmitted.dataTracks.map((track) => ({
          ...track,
          source: { ...track.source, fingerprint: 'different-data' },
        })),
      })
    ).not.toBe(trackViewConfigurationKey(original));
  });

  it('detects edits to saved primer bindings and user annotations', () => {
    const original = parseTrackViewDocument(JSON.stringify(trackViewFixture()));
    const key = trackViewConfigurationKey(original);
    expect(
      trackViewConfigurationKey({ ...original, primerBindings: [], userAnnotations: [] })
    ).toBe(key);
    expect(
      trackViewConfigurationKey({
        ...original,
        primerBindings: [
          {
            id: 'binding-1',
            primerId: 'primer-1',
            primerName: 'Primer',
            primerBases: 'ACGT',
            chrom: 'pUC19',
            start0: 100,
            end0: 104,
            strand: '+',
            source: 'attached',
          },
        ],
      })
    ).not.toBe(key);
    expect(
      trackViewConfigurationKey({
        ...original,
        userAnnotations: [
          {
            id: 'annotation-1',
            chrom: 'pUC19',
            annotation: {
              name: 'Site',
              type: 'misc_feature',
              start: 100,
              end: 104,
              direction: 1,
            },
          },
        ],
      })
    ).not.toBe(key);
  });
});
