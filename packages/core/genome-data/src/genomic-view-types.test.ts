import { describe, expect, it } from 'vitest';

import {
  GENOMIC_VIEW_TYPES,
  genomicViewSourceFromAdmission,
  requireGenomicViewBinding,
  type GenomicViewSource,
} from './genomic-view-types';
import type { AdmittedTrackSource } from './admitted-track-source';

const signal: GenomicViewSource = {
  id: 'signal-a',
  assemblyId: 'hg19',
  scientificKind: 'quantitative',
  formatId: 'bigwig',
  regionalAccess: 'internal-index',
  quantitativeMeaning: 'unknown',
};
const indexedReads: GenomicViewSource = {
  id: 'reads-a',
  assemblyId: 'hg19',
  scientificKind: 'reads',
  formatId: 'cram',
  regionalAccess: 'companion-index',
};

const admittedSignal: AdmittedTrackSource = {
  admissionVersion: 1,
  uri: 'https://example.org/signal.bw',
  input: { kind: 'url', url: 'https://example.org/signal.bw' },
  formatId: 'bigwig',
  recommendedTypes: ['quantitative'],
  fingerprint: 'signal-fingerprint',
  readerKind: 'bbi',
  scientificKind: 'quantitative',
  assemblyId: 'hg19',
  referenceReceipt: {
    assemblyId: 'hg19',
    referenceSignature: 'reference',
    sourceSignature: 'signal',
    contigMap: {},
    checkedContigs: 1,
    status: 'compatible',
    checkedAt: '2026-09-25T00:00:00.000Z',
  },
  provenance: { provider: 'direct-url' },
};

const admittedReads: AdmittedTrackSource = {
  ...admittedSignal,
  uri: 'file:///reads.cram',
  input: { kind: 'path', path: '/reads.cram' },
  index: { kind: 'path', path: '/reads.cram.crai' },
  formatId: 'cram',
  recommendedTypes: ['pileup'],
  fingerprint: 'reads-fingerprint',
  readerKind: 'bam',
  scientificKind: 'reads',
  alignedReadIndexState: 'present',
};

describe('genomic view-type source roles', () => {
  it('keeps a BigWig-only quantitative view valid without a CRAI', () => {
    expect(requireGenomicViewBinding('quantitative-signal', { signal })).toMatchObject({
      type: 'quantitative-signal',
      boundRoles: ['signal'],
    });
    expect(requireGenomicViewBinding('signal-with-read-evidence', { signal })).toMatchObject({
      type: 'signal-with-read-evidence',
      boundRoles: ['signal'],
      previewFidelity: 'approximate',
    });
  });

  it('admits direct indexed CRAM and server-selected reads through the same role', () => {
    expect(
      requireGenomicViewBinding('signal-read-pileup-v1', { signal, reads: indexedReads }).boundRoles
    ).toEqual(['signal', 'reads']);
    expect(
      requireGenomicViewBinding('regional-reads', {
        reads: { ...indexedReads, id: 'htsget-a', formatId: 'htsget', regionalAccess: 'service' },
      }).boundRoles
    ).toEqual(['reads']);
  });

  it('rejects an unindexed direct CRAM and an assembly mismatch', () => {
    expect(() =>
      requireGenomicViewBinding('regional-reads', {
        reads: { ...indexedReads, regionalAccess: 'none' },
      })
    ).toThrow(/regional access/u);
    expect(() =>
      requireGenomicViewBinding('signal-with-read-evidence', {
        signal,
        reads: { ...indexedReads, assemblyId: 'hg38' },
      })
    ).toThrow(/same reference assembly/u);
  });

  it('makes optional reads optional only for the new view type, not legacy manifests', () => {
    expect(GENOMIC_VIEW_TYPES['signal-with-read-evidence'].roles.reads).toBe('optional');
    expect(GENOMIC_VIEW_TYPES['signal-read-pileup-v1'].roles.reads).toBe('required');
    expect(() => requireGenomicViewBinding('signal-read-pileup-v1', { signal })).toThrow(
      /requires reads/u
    );
  });

  it('derives regional capability from admission rather than an unverified locator', () => {
    expect(genomicViewSourceFromAdmission('signal-a', admittedSignal)).toMatchObject({
      scientificKind: 'quantitative',
      regionalAccess: 'internal-index',
    });
    expect(genomicViewSourceFromAdmission('reads-a', admittedReads)).toMatchObject({
      scientificKind: 'reads',
      regionalAccess: 'companion-index',
    });
    expect(
      genomicViewSourceFromAdmission('reads-a', {
        ...admittedReads,
        alignedReadIndexState: 'created',
      }).regionalAccess
    ).toBe('managed-index');
    expect(
      genomicViewSourceFromAdmission('reads-a', {
        ...admittedReads,
        index: undefined,
        alignedReadIndexState: undefined,
      }).regionalAccess
    ).toBe('none');
    expect(
      genomicViewSourceFromAdmission('reads-a', {
        ...admittedReads,
        referenceReceipt: { ...admittedReads.referenceReceipt, status: 'incompatible' },
      }).regionalAccess
    ).toBe('none');
  });

  it('recognizes htsget as regional reads without a companion index', () => {
    expect(
      genomicViewSourceFromAdmission('reads-service', {
        ...admittedReads,
        index: undefined,
        alignedReadIndexState: undefined,
        request: {
          contract: 'dnaforge.track-admission-request.v1',
          assemblyId: 'hg19',
          source: {
            kind: 'htsget',
            endpoint: 'https://example.org/htsget',
            resourceId: 'sample',
            dataClass: 'reads',
            format: 'CRAM',
          },
          formatId: 'cram',
          scientificKind: 'reads',
          ingress: { kind: 'automation' },
        },
      }).regionalAccess
    ).toBe('service');
  });
});
