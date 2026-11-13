// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { createIndexedBbiTrackId } from '@waypoint/genome-data';
import {
  parseTrackViewDocument,
  serializeTrackViewDocument,
  TRACK_VIEW_SCHEMA,
  TRACK_VIEW_SCHEMA_V2,
  TRACK_VIEW_SCHEMA_V3,
} from './track-view';

import { trackViewFixture } from './track-view-fixture';

describe('native saved Track view document', () => {
  it('roundtrips a cluster receipt path while refusing live server authority', () => {
    const base = trackViewFixture();
    const remote = {
      contract: 'remote-alignment-locator.v1' as const,
      endpointId: 'cluster-source',
      target: 'cluster-alias',
      alignmentPath: '/data/reads.bam',
      indexPath: '/data/reads.bam.bai',
      tileServerReceiptPath: '/home/user/.dnaforge-node/connection.json',
    };
    const value = {
      ...base,
      bamTracks: [
        {
          trackId: 'cluster-reads',
          label: 'Cluster reads',
          visible: true,
          coverageCutoffDepth: 80,
          source: { bamPath: remote.alignmentPath, indexPath: remote.indexPath, remote },
        },
      ],
    };
    expect(parseTrackViewDocument(serializeTrackViewDocument(value))).toEqual(value);
    for (const tileServerReceiptPath of ['relative.json', '/data/connection\0.json']) {
      expect(() =>
        serializeTrackViewDocument({
          ...value,
          bamTracks: [
            {
              ...value.bamTracks[0],
              source: {
                ...value.bamTracks[0]!.source,
                remote: { ...remote, tileServerReceiptPath },
              },
            },
          ],
        })
      ).toThrow();
    }
    expect(() =>
      serializeTrackViewDocument({
        ...value,
        bamTracks: [
          {
            ...value.bamTracks[0],
            source: {
              ...value.bamTracks[0]!.source,
              remote: { ...remote, sessionToken: 'must-not-be-saved' },
            },
          },
        ],
      })
    ).toThrow();
  });
  it('migrates older views without losing their reference facts or presentation', () => {
    const current = trackViewFixture();
    for (const schema of ['dnaforge.track-view.v1', 'dnaforge.track-view.v2']) {
      expect(parseTrackViewDocument(JSON.stringify({ ...current, schema }))).toEqual(current);
    }
  });
  it('roundtrips a named custom-reference view without serializing reference payloads', () => {
    const value = trackViewFixture();
    expect(parseTrackViewDocument(serializeTrackViewDocument(value))).toEqual(value);
  });
  it('preserves a portable reference identity and refuses a conflicting one', () => {
    const base = trackViewFixture();
    const reference = {
      ...base.reference,
      assemblyId: 'hg38',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      bundleFingerprint: 'c'.repeat(64),
    };
    const portableReference = {
      kind: 'hosted-reference',
      catalogId: 'hg38',
      assemblyId: 'hg38',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      bundleFingerprint: 'c'.repeat(64),
    };
    const view = { ...base, reference, portableReference };
    expect(parseTrackViewDocument(serializeTrackViewDocument(view)).portableReference).toEqual(
      portableReference
    );
    expect(() =>
      serializeTrackViewDocument({
        ...view,
        portableReference: { ...portableReference, bundleFingerprint: 'd'.repeat(64) },
      })
    ).toThrow('portable and managed hosted reference fingerprints conflict');
  });
  it('roundtrips v2 admission provenance while rejecting embedded or signed credentials', () => {
    const base = trackViewFixture();
    const request = {
      contract: 'dnaforge.track-admission-request.v1' as const,
      assemblyId: 'local-1234567890abcdef12345678',
      source: {
        kind: 'http' as const,
        url: 'https://results.example.org/run/signal.bw',
        authRef: 'credential-broker/team-signal-read',
      },
      formatId: 'bigwig',
      scientificKind: 'quantitative' as const,
      label: 'Signal',
      ingress: { kind: 'automation' as const },
    };
    const value = {
      ...base,
      dataTracks: [
        {
          trackId: 'data:signal-v2',
          trackType: 'quantitative',
          label: 'Signal',
          color: 0x2563eb,
          trackPx: 128,
          laneHeightPx: 8,
          maxLanes: 32,
          visible: true,
          source: {
            uri: 'https://results.example.org/run/signal.bw',
            input: { kind: 'url' as const, url: 'https://results.example.org/run/signal.bw' },
            formatId: 'bigwig',
            admissionVersion: 2 as const,
            request,
            admittedAt: '2026-09-21T18:00:00.000Z',
            fingerprint: 'signal-v2-fingerprint',
            readerKind: 'bbi' as const,
            scientificKind: 'quantitative' as const,
            assemblyId: 'local-1234567890abcdef12345678',
            referenceReceipt: {
              assemblyId: 'local-1234567890abcdef12345678',
              referenceSignature: 'reference-signature',
              sourceSignature: 'source-signature',
              contigMap: { pUC19: 'pUC19' },
              checkedContigs: 1,
              status: 'compatible' as const,
              checkedAt: '2026-09-21T18:00:00.000Z',
            },
            provenance: { provider: 'direct-url', label: 'Signal' },
          },
        },
      ],
    };

    expect(parseTrackViewDocument(serializeTrackViewDocument(value))).toEqual(value);
    expect(() =>
      serializeTrackViewDocument({
        ...value,
        dataTracks: [
          {
            ...value.dataTracks[0],
            source: {
              ...value.dataTracks[0].source,
              request: {
                ...request,
                source: {
                  kind: 'http',
                  url: 'https://results.example.org/run/signal.bw?token=secret',
                },
              },
            },
          },
        ],
      })
    ).toThrow(/credential|signed/i);
  });
  it('roundtrips an interval-text source receipt', () => {
    const base = trackViewFixture();
    const source = {
      uri: 'file:///analysis/regions.bed',
      input: { kind: 'path' as const, path: '/analysis/regions.bed' },
      formatId: 'bed',
      admissionVersion: 2 as const,
      request: {
        contract: 'dnaforge.track-admission-request.v1' as const,
        assemblyId: base.reference.assemblyId,
        source: { kind: 'local-file' as const, path: '/analysis/regions.bed' },
        formatId: 'bed',
        scientificKind: 'interval' as const,
        ingress: { kind: 'file-picker' as const },
      },
      admittedAt: '2026-09-21T19:00:00.000Z',
      fingerprint: `bed:sha256:${'a'.repeat(64)}`,
      readerKind: 'interval-text' as const,
      scientificKind: 'interval' as const,
      assemblyId: base.reference.assemblyId,
      referenceReceipt: {
        assemblyId: base.reference.assemblyId,
        referenceSignature: 'reference-signature',
        sourceSignature: 'source-signature',
        contigMap: { pUC19: 'pUC19' },
        checkedContigs: 1,
        status: 'compatible' as const,
        checkedAt: '2026-09-21T19:00:00.000Z',
      },
      provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'regions.bed' },
      expectedValidators: { contentLength: 100 },
    };
    const value = {
      ...base,
      dataTracks: [
        {
          trackId: 'data:regions-bed',
          trackType: 'generic-interval',
          label: 'regions.bed',
          color: 0x3b82f6,
          trackPx: 160,
          laneHeightPx: 8,
          maxLanes: 32,
          visible: true,
          source,
        },
      ],
    };

    expect(parseTrackViewDocument(serializeTrackViewDocument(value))).toEqual(value);
  });
  it('rejects future formats, unsafe identities, and out-of-reference viewports', () => {
    expect(() =>
      parseTrackViewDocument(
        JSON.stringify({ ...trackViewFixture(), schema: 'dnaforge.track-view.v4' })
      )
    ).toThrow();
    expect(() =>
      serializeTrackViewDocument({ ...trackViewFixture(), id: '../../escape' })
    ).toThrow();
    expect(() =>
      serializeTrackViewDocument({ ...trackViewFixture(), viewport: { start0: 0, end0: 9999 } })
    ).toThrow();
  });
  it('rejects incomplete or cross-reference track descriptors instead of silently losing tracks', () => {
    expect(() =>
      serializeTrackViewDocument({ ...trackViewFixture(), dataTracks: [{ trackId: 'broken' }] })
    ).toThrow();
    expect(() =>
      serializeTrackViewDocument({ ...trackViewFixture(), sessionId: 'ephemeral' })
    ).toThrow();
  });
  it('roundtrips every exact variant paging receipt and rejects partial receipt sets', () => {
    const sourceGeneration = {
      canonicalPath: '/data/calls.vcf.gz',
      size: 123,
      mtimeNs: '456',
      ctimeNs: '457',
      device: '10',
      inode: '11',
    };
    const variantSource = {
      sourcePath: sourceGeneration.canonicalPath,
      queryPath: '/cache/calls.vcf.gz',
      indexPath: '/cache/calls.vcf.gz.tbi',
      format: 'vcf',
      label: 'calls.vcf.gz',
      sourceSizeBytes: sourceGeneration.size,
      sourceMtimeNs: sourceGeneration.mtimeNs,
      sourceIdentity: 'a'.repeat(64),
      sourceGeneration,
      queryGeneration: { ...sourceGeneration, canonicalPath: '/cache/calls.vcf.gz' },
      indexGeneration: { ...sourceGeneration, canonicalPath: '/cache/calls.vcf.gz.tbi' },
      assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
      matchedReferences: ['pUC19'],
      samples: ['sample'],
      attachedAt: 1,
    };
    const value = { ...trackViewFixture(), variantSource };

    expect(parseTrackViewDocument(serializeTrackViewDocument(value))).toEqual(value);

    const localAdmission = {
      admissionVersion: 2 as const,
      request: {
        contract: 'dnaforge.track-admission-request.v1' as const,
        assemblyId: trackViewFixture().reference.assemblyId,
        source: { kind: 'local-file' as const, path: sourceGeneration.canonicalPath },
        formatId: 'vcf',
        scientificKind: 'variants' as const,
        ingress: { kind: 'file-picker' as const },
      },
      admittedAt: '2026-09-22T00:00:00.000Z',
      uri: `file://${sourceGeneration.canonicalPath}`,
      input: { kind: 'path' as const, path: sourceGeneration.canonicalPath },
      formatId: 'vcf',
      recommendedTypes: ['variant'],
      fingerprint: `sha256:${'c'.repeat(64)}`,
      readerKind: 'variant' as const,
      scientificKind: 'variants' as const,
      assemblyId: trackViewFixture().reference.assemblyId,
      referenceReceipt: {
        assemblyId: trackViewFixture().reference.assemblyId,
        referenceSignature: `sha256:${'d'.repeat(64)}`,
        sourceSignature: `sha256:${'e'.repeat(64)}`,
        contigMap: { pUC19: 'pUC19' },
        checkedContigs: 1,
        status: 'compatible' as const,
        checkedAt: '2026-09-22T00:00:00.000Z',
      },
      provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'calls.vcf.gz' },
      expectedValidators: { contentLength: sourceGeneration.size },
    };
    const admittedLocal = {
      ...trackViewFixture(),
      variantSource: { ...variantSource, admittedSource: localAdmission },
    };
    expect(parseTrackViewDocument(serializeTrackViewDocument(admittedLocal))).toEqual(
      admittedLocal
    );
    expect(() =>
      serializeTrackViewDocument({
        ...trackViewFixture(),
        variantSource: {
          ...variantSource,
          admittedSource: {
            ...localAdmission,
            input: { kind: 'path' as const, path: '/elsewhere/calls.vcf.gz' },
          },
        },
      })
    ).toThrow('local variant receipt does not match');

    expect(() =>
      serializeTrackViewDocument({
        ...trackViewFixture(),
        variantSource: { ...variantSource, indexGeneration: undefined },
      })
    ).toThrow('every file and assembly receipt');
    expect(() =>
      serializeTrackViewDocument({
        ...trackViewFixture(),
        variantSource: {
          ...variantSource,
          queryGeneration: { ...variantSource.queryGeneration, canonicalPath: '/wrong' },
        },
      })
    ).toThrow('does not match');
  });

  it('roundtrips remote variant intent while excluding temporary range grants and snapshots', () => {
    const base = trackViewFixture();
    const sourceUrl = 'https://variants.example.org/run/tumor.vcf.gz';
    const indexUrl = 'https://variants.example.org/run/tumor.vcf.gz.tbi';
    const admittedSource = {
      admissionVersion: 2 as const,
      request: {
        contract: 'dnaforge.track-admission-request.v1' as const,
        assemblyId: base.reference.assemblyId,
        source: { kind: 'http' as const, url: sourceUrl },
        index: { kind: 'http' as const, url: indexUrl },
        formatId: 'vcf',
        scientificKind: 'variants' as const,
        label: 'Tumor calls',
        ingress: { kind: 'url' as const },
      },
      admittedAt: '2026-09-21T21:00:00.000Z',
      uri: sourceUrl,
      input: { kind: 'url' as const, url: sourceUrl },
      index: { kind: 'url' as const, url: indexUrl },
      formatId: 'vcf',
      recommendedTypes: ['variant'],
      fingerprint: `sha256:${'a'.repeat(64)}`,
      readerKind: 'variant' as const,
      scientificKind: 'variants' as const,
      assemblyId: base.reference.assemblyId,
      referenceReceipt: {
        assemblyId: base.reference.assemblyId,
        referenceSignature: `sha256:${'b'.repeat(64)}`,
        sourceSignature: `sha256:${'c'.repeat(64)}`,
        contigMap: { pUC19: 'pUC19' },
        checkedContigs: 1,
        status: 'compatible' as const,
        checkedAt: '2026-09-21T21:00:00.000Z',
      },
      provenance: {
        provider: 'http',
        sourceKind: 'http',
        remoteUrl: sourceUrl,
        label: 'Tumor calls',
      },
      expectedValidators: { contentLength: 12_345, etag: '"vcf-v1"' },
      indexExpectedValidators: { contentLength: 678, etag: '"tbi-v1"' },
    };
    const variantSource = {
      sourcePath: sourceUrl,
      queryPath: sourceUrl,
      indexPath: indexUrl,
      format: 'vcf' as const,
      label: 'Tumor calls',
      sourceSizeBytes: 12_345,
      sourceIdentity: 'd'.repeat(64),
      assemblyRevision: `variant-assembly-v1:sha256:${'e'.repeat(64)}`,
      admittedSource,
      matchedReferences: ['pUC19'],
      samples: ['tumor'],
      attachedAt: 1,
    };
    const value = { ...base, variantSource };

    const serialized = serializeTrackViewDocument(value);
    expect(parseTrackViewDocument(serialized)).toEqual(value);
    expect(serialized).not.toContain('source_token');
    expect(serialized).not.toContain('/external/range-proxy/');
    expect(serialized).not.toContain('/tmp/');

    expect(() =>
      serializeTrackViewDocument({
        ...base,
        variantSource: { ...variantSource, sourceMtimeNs: '1' },
      })
    ).toThrow('cannot contain local file receipts');
    expect(() =>
      serializeTrackViewDocument({
        ...base,
        variantSource: {
          ...variantSource,
          admittedSource: {
            ...admittedSource,
            expectedValidators: { contentLength: 12_346, etag: '"vcf-v1"' },
          },
        },
      })
    ).toThrow('does not match its source or reference');
  });

  it('roundtrips htsget variant endpoint intent while excluding tickets and runtime grants', () => {
    const base = trackViewFixture();
    const identity = '9'.repeat(64);
    const admittedSource = {
      admissionVersion: 2 as const,
      request: {
        contract: 'dnaforge.track-admission-request.v1' as const,
        assemblyId: base.reference.assemblyId,
        source: {
          kind: 'htsget' as const,
          endpoint: 'https://htsget.example.org',
          resourceId: 'tumor',
          dataClass: 'variants' as const,
          format: 'VCF' as const,
        },
        formatId: 'vcf',
        scientificKind: 'variants' as const,
        label: 'htsget tumor calls',
        ingress: { kind: 'url' as const },
      },
      admittedAt: '2026-09-21T21:00:00.000Z',
      uri: `htsget:${identity}`,
      formatId: 'vcf',
      recommendedTypes: ['variant'],
      fingerprint: `sha256:${'a'.repeat(64)}`,
      readerKind: 'variant' as const,
      scientificKind: 'variants' as const,
      assemblyId: base.reference.assemblyId,
      referenceReceipt: {
        assemblyId: base.reference.assemblyId,
        referenceSignature: `sha256:${'b'.repeat(64)}`,
        sourceSignature: `sha256:${'c'.repeat(64)}`,
        contigMap: { pUC19: 'pUC19' },
        checkedContigs: 1,
        status: 'compatible' as const,
        checkedAt: '2026-09-21T21:00:00.000Z',
      },
      provenance: { provider: 'htsget', sourceKind: 'htsget', label: 'htsget tumor calls' },
    };
    const sourcePath = `htsget-source://${identity}/source.vcf`;
    const variantSource = {
      sourcePath,
      queryPath: sourcePath,
      indexPath: `htsget-source://${identity}/regional-index`,
      format: 'vcf' as const,
      label: 'htsget tumor calls',
      sourceSizeBytes: 0,
      sourceIdentity: identity,
      assemblyRevision: `variant-assembly-v1:sha256:${'e'.repeat(64)}`,
      admittedSource,
      matchedReferences: ['pUC19'],
      samples: ['tumor'],
      attachedAt: 1,
    };
    const value = { ...base, variantSource };

    const serialized = serializeTrackViewDocument(value);
    expect(parseTrackViewDocument(serialized)).toEqual(value);
    expect(serialized).toContain('https://htsget.example.org');
    expect(serialized).toMatch(/"resourceId":\s*"tumor"/u);
    expect(serialized).not.toMatch(/source_token|ticket|authorization|runtime-token/iu);

    expect(() =>
      serializeTrackViewDocument({
        ...base,
        variantSource: { ...variantSource, indexPath: 'https://signed.example.org/secret.csi' },
      })
    ).toThrow('does not match its endpoint-backed source');
  });

  it('roundtrips complete quantitative and BAM/CRAM presentation settings', () => {
    const base = trackViewFixture();
    const alignedReadGeneration = {
      contract: 'aligned-read-source-generation.v1' as const,
      alignment: {
        canonicalPath: '/data/reads.bam',
        size: 1_000,
        mtimeNs: '1000000',
        ctimeNs: '2000000',
        device: '42',
        inode: '1001',
      },
      index: {
        canonicalPath: '/data/reads.bam.bai',
        size: 100,
        mtimeNs: '1000000',
        ctimeNs: '2000000',
        device: '42',
        inode: '1002',
      },
    };
    const value = {
      ...base,
      dataTracks: [
        {
          trackId: 'signal-1',
          trackType: 'quantitative',
          label: 'Signal',
          order: 0,
          color: 0xe11d48,
          trackPx: 128,
          laneHeightPx: 8,
          maxLanes: 32,
          visible: true,
          quantitativePresentation: {
            version: 1,
            graph: 'bar',
            showRange: true,
            smoothingSigmaBins: 1.2,
            scale: { mode: 'full-global', transform: 'log1p' },
          },
          source: {
            uri: 'https://example.org/signal.bw',
            formatId: 'bigwig',
            input: {
              kind: 'path',
              path: '/repo/test-fixtures/indexed/danRer11/pownall-figure-4n/AGS001841.bw',
            },
            admissionVersion: 1,
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
              checkedAt: '2026-09-08T00:00:00.000Z',
            },
            provenance: {
              provider: 'local-file',
              sourceKind: 'local-file',
              label: 'AGS001841.bw',
              devScenarioFixture: true,
            },
            quantitativeSummary: {
              contract: 'dnaforge.quantitative-source-summary.v1',
              algorithm: 'equal-genomic-bin-means-r7-quantiles-v1',
              targetSampleCount: 65_536,
              sampleCount: 100,
              lowerQuantile: 0.005,
              upperQuantile: 0.995,
              robustMin: 0,
              robustMax: 10,
              fullMin: 0,
              fullMax: 100,
              missingData: 'excluded',
            },
          },
        },
      ],
      bamTracks: [
        {
          trackId: 'reads-1',
          label: 'Reads',
          order: 1,
          visible: true,
          color: 0x2563eb,
          trackPx: 300,
          laneHeightPx: 4,
          maxLanes: 100,
          coverageCutoffDepth: 250,
          source: {
            bamPath: '/data/reads.bam',
            indexPath: '/data/reads.bam.bai',
            generation: alignedReadGeneration,
          },
          admittedSource: {
            admissionVersion: 2 as const,
            request: {
              contract: 'dnaforge.track-admission-request.v1' as const,
              assemblyId: base.reference.assemblyId,
              source: { kind: 'local-file' as const, path: '/data/reads.bam' },
              index: { kind: 'local-file' as const, path: '/data/reads.bam.bai' },
              formatId: 'bam',
              scientificKind: 'reads' as const,
              ingress: { kind: 'file-picker' as const },
            },
            admittedAt: '2026-09-21T20:00:00.000Z',
            uri: 'file:///data/reads.bam',
            input: { kind: 'path' as const, path: '/data/reads.bam' },
            index: { kind: 'path' as const, path: '/data/reads.bam.bai' },
            formatId: 'bam',
            recommendedTypes: ['pileup'],
            fingerprint: `sha256:${'a'.repeat(64)}`,
            readerKind: 'bam' as const,
            scientificKind: 'reads' as const,
            assemblyId: base.reference.assemblyId,
            referenceReceipt: {
              assemblyId: base.reference.assemblyId,
              referenceSignature: `sha256:${'b'.repeat(64)}`,
              sourceSignature: `sha256:${'c'.repeat(64)}`,
              contigMap: { pUC19: 'pUC19' },
              checkedContigs: 1,
              status: 'compatible' as const,
              checkedAt: '2026-09-21T20:00:00.000Z',
            },
            provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'reads.bam' },
            expectedValidators: { contentLength: 1_000 },
            alignedReadGeneration,
            alignedReadIndexState: 'present' as const,
          },
        },
      ],
      signalReadPileupViews: [
        {
          contract: 'dnaforge.signal-read-pileup-view.v1' as const,
          trackId: 'combined-1',
          readsTrackId: 'reads-1',
          signalTrackId: 'signal-1',
          label: 'Signal → reads',
          order: 2,
          visible: true,
          color: 0x2563eb,
          trackPx: 300,
          laneHeightPx: 4,
          maxLanes: 100,
          overflowBandHeightPx: 36,
          coverageCutoffDepth: 100,
          loadingAnimation: 'diagonal-scan' as const,
        },
      ],
    };

    expect(parseTrackViewDocument(serializeTrackViewDocument(value))).toEqual(value);
    expect(() =>
      serializeTrackViewDocument({
        ...value,
        signalReadPileupViews: [
          ...value.signalReadPileupViews,
          {
            ...value.signalReadPileupViews[0],
            trackId: 'combined-2',
          },
        ],
      })
    ).toThrow('Duplicate signal-to-reads source pair.');
  });

  it('roundtrips an SSH signal-to-reads view through its durable sibling signal locator', () => {
    const base = trackViewFixture();
    const target = 'analysis-hpc';
    const signalPath = '/runs/42/signal/sample.bigWig';
    const readsTrackId = 'remote-reads';
    const signalTrackId = createIndexedBbiTrackId({
      assemblyId: base.reference.assemblyId,
      source: { kind: 'url', url: `ssh://${target}${signalPath}` },
    });
    const value = {
      ...base,
      dataTracks: [],
      bamTracks: [
        {
          trackId: readsTrackId,
          label: 'Remote reads',
          visible: false,
          coverageCutoffDepth: 80,
          source: {
            bamPath: '/runs/42/align/sample.cram',
            indexPath: '/runs/42/align/sample.cram.crai',
            remote: {
              contract: 'remote-alignment-locator.v1' as const,
              endpointId: 'endpoint-42',
              target,
              alignmentPath: '/runs/42/align/sample.cram',
              indexPath: '/runs/42/align/sample.cram.crai',
              signalPath,
            },
          },
        },
      ],
      signalReadPileupViews: [
        {
          contract: 'dnaforge.signal-read-pileup-view.v1' as const,
          trackId: 'remote-combined',
          readsTrackId,
          signalTrackId,
          label: 'Remote signal → reads',
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
    };

    expect(parseTrackViewDocument(serializeTrackViewDocument(value))).toEqual(value);
    expect(() =>
      serializeTrackViewDocument({
        ...value,
        signalReadPileupViews: [
          { ...value.signalReadPileupViews[0], signalTrackId: 'unrelated-signal' },
        ],
      })
    ).toThrow('missing quantitative signal track');
  });
});

describe('v3 Track view user layers', () => {
  const binding = {
    id: 'binding-1',
    primerId: '4e40896d-930d-42c4-8c85-7c6c59546e0c',
    primerName: 'JUN_exon_F1',
    primerBases: 'GCGCTCTTCGTGCGCAGCGG',
    start0: 100,
    end0: 120,
    strand: '+' as const,
    source: 'created' as const,
  };
  const annotation = {
    id: 'annotation-1',
    annotation: { name: 'Site', type: 'misc_feature', start: 5, end: 40, direction: 1 as const },
  };
  function layered(schema: string) {
    const base = trackViewFixture();
    const chrom = base.reference.chromosomes[0]!.chrom;
    return {
      ...base,
      schema,
      primerBindings: [{ ...binding, chrom }],
      userAnnotations: [{ ...annotation, chrom }],
    };
  }

  it('roundtrips primer bindings and user annotations in a v3 view', () => {
    const value = layered(TRACK_VIEW_SCHEMA_V3);
    expect(parseTrackViewDocument(serializeTrackViewDocument(value))).toEqual(value);
  });

  it('refuses user layers in a v2 view, so an older reader never drops them silently', () => {
    expect(() => serializeTrackViewDocument(layered(TRACK_VIEW_SCHEMA_V2))).toThrow(
      /v3 Track view/
    );
  });

  it('refuses a binding outside its reference chromosome', () => {
    const value = layered(TRACK_VIEW_SCHEMA_V3);
    const length = value.reference.chromosomes[0]!.length;
    value.primerBindings = [{ ...value.primerBindings[0]!, start0: length, end0: length + 20 }];
    expect(() => serializeTrackViewDocument(value)).toThrow(/outside its reference/);
  });
});
