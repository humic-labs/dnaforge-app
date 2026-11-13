import { describe, expect, it } from 'vitest';

import {
  TRACK_ADMISSION_REQUEST_V1,
  createTrackAdmissionRequestId,
  directTrackAdmissionRequest,
  formatInputFromTrackAdmissionRequest,
  parseTrackAdmissionRequestV1,
  trackAdmissionRequestIdentity,
  trackAdmissionRequestLabel,
  type TrackAdmissionRequestV1,
} from './track-admission-request';
import { createIndexedBbiTrackId } from './indexed-bbi-track-source';

describe('track admission request', () => {
  it.each<{
    name: string;
    source: TrackAdmissionRequestV1['source'];
  }>([
    {
      name: 'a selected local file',
      source: { kind: 'local-file', path: '/analysis/sample.bam' },
    },
    {
      name: 'a public or authenticated HTTP object',
      source: {
        kind: 'http',
        url: 'https://data.example.org/sample.bam',
        authRef: 'credential:institutional-data',
      },
    },
    {
      name: 'an S3 object',
      source: {
        kind: 's3',
        bucket: 'research-results',
        key: 'runs/42/sample.bam',
        region: 'us-west-2',
        requesterPays: true,
        authRef: 'credential:aws-research',
      },
    },
    {
      name: 'a Google Cloud Storage object',
      source: {
        kind: 'gcs',
        bucket: 'research-results',
        object: 'runs/42/sample.bam',
        billingProject: 'genomics-billing',
        authRef: 'credential:gcp-research',
      },
    },
    {
      name: 'an htsget resource',
      source: {
        kind: 'htsget',
        endpoint: 'https://htsget.example.org',
        resourceId: 'reads-42',
        dataClass: 'reads',
        format: 'BAM',
        authRef: 'credential:htsget-research',
      },
    },
    {
      name: 'a native UCSC catalog track',
      source: {
        kind: 'ucsc-track',
        sourceKind: 'ucsc-native',
        genome: 'hg38',
        track: 'knownGene',
      },
    },
    {
      name: 'an unlisted UCSC-compatible track hub entry',
      source: {
        kind: 'ucsc-track',
        sourceKind: 'ucsc-hub',
        genome: 'hg38',
        track: 'labSignal',
        hubUrl: 'https://hub.example.org/hub.txt',
      },
    },
  ])('round-trips $name without admitting raw credentials', ({ source }) => {
    const request = parseTrackAdmissionRequestV1({
      contract: TRACK_ADMISSION_REQUEST_V1,
      assemblyId: 'grch38',
      source,
      formatId: 'bam',
      index: { kind: 'http', url: 'https://data.example.org/sample.bam.bai' },
      label: 'Tumor reads',
      ingress: { kind: 'manifest', manifestId: 'run-42' },
    });

    expect(request.source).toEqual(source);
    expect(JSON.stringify(request)).not.toMatch(/authorization|bearer|secret|sessionToken/i);
  });

  it('normalizes legacy local and URL inputs into one request contract', () => {
    expect(
      directTrackAdmissionRequest({
        assemblyId: 'grch38',
        input: { kind: 'path', path: '/analysis/signal.bigWig' },
        formatId: 'bigwig',
        ingress: 'file-picker',
      })
    ).toEqual({
      contract: TRACK_ADMISSION_REQUEST_V1,
      assemblyId: 'grch38',
      source: { kind: 'local-file', path: '/analysis/signal.bigWig' },
      formatId: 'bigwig',
      ingress: { kind: 'file-picker' },
    });

    expect(
      directTrackAdmissionRequest({
        assemblyId: 'grch38',
        input: { kind: 'url', url: 'https://data.example.org/signal.bigWig' },
        formatId: 'bigwig',
        ingress: 'automation',
        label: 'Signal',
      })
    ).toMatchObject({
      source: { kind: 'http', url: 'https://data.example.org/signal.bigWig' },
      ingress: { kind: 'automation' },
      label: 'Signal',
    });
  });

  it('converts only direct local and HTTP sources into format detection inputs', () => {
    const local = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'path', path: '/analysis/signal.bigWig' },
      formatId: 'bigwig',
      ingress: 'file-picker',
    });
    const remote = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'url', url: 'https://data.example.org/signal.bigWig' },
      formatId: 'bigwig',
      ingress: 'url',
    });
    const cloud = parseTrackAdmissionRequestV1({
      contract: TRACK_ADMISSION_REQUEST_V1,
      assemblyId: 'grch38',
      source: { kind: 's3', bucket: 'research-results', key: 'signal.bigWig' },
      formatId: 'bigwig',
      ingress: { kind: 'cloud' },
    });

    expect(formatInputFromTrackAdmissionRequest(local)).toEqual({
      kind: 'path',
      path: '/analysis/signal.bigWig',
    });
    expect(formatInputFromTrackAdmissionRequest(remote)).toEqual({
      kind: 'url',
      url: 'https://data.example.org/signal.bigWig',
    });
    expect(() => formatInputFromTrackAdmissionRequest(cloud)).toThrow(
      'must be resolved by its source adapter'
    );
  });

  it('uses scientific identity rather than label or ingress for deduplication', () => {
    const first = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'url', url: 'https://data.example.org/signal.bigWig' },
      formatId: 'bigwig',
      ingress: 'url',
      label: 'First label',
    });
    const second = parseTrackAdmissionRequestV1({
      ...first,
      label: 'Second label',
      ingress: { kind: 'session', sessionId: 'shared-view-1' },
    });
    const otherAssembly = parseTrackAdmissionRequestV1({
      ...first,
      assemblyId: 'grch37',
    });

    expect(trackAdmissionRequestIdentity(first)).toBe(trackAdmissionRequestIdentity(second));
    expect(trackAdmissionRequestIdentity(first)).not.toBe(
      trackAdmissionRequestIdentity(otherAssembly)
    );
  });

  it('preserves existing direct BigWig track ids while supporting every locator kind', () => {
    const direct = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'url', url: 'https://data.example.org/signal.bigWig' },
      formatId: 'bigwig',
      ingress: 'url',
    });
    expect(createTrackAdmissionRequestId(direct)).toBe(
      createIndexedBbiTrackId({
        assemblyId: 'grch38',
        source: { kind: 'url', url: 'https://data.example.org/signal.bigWig' },
      })
    );

    const cloud = parseTrackAdmissionRequestV1({
      contract: TRACK_ADMISSION_REQUEST_V1,
      assemblyId: 'grch38',
      source: { kind: 's3', bucket: 'research-results', key: 'signal.bigWig' },
      formatId: 'bigwig',
      ingress: { kind: 'cloud' },
    });
    expect(createTrackAdmissionRequestId(cloud)).toMatch(/^data:signal\.bigWig-[a-z0-9]+$/u);
  });

  it('derives a useful label without treating it as source identity', () => {
    const request = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'url', url: 'https://data.example.org/run/signal.bigWig?download=1' },
      formatId: 'bigwig',
      ingress: 'url',
    });
    expect(trackAdmissionRequestLabel(request)).toBe('signal.bigWig');
    expect(trackAdmissionRequestLabel({ ...request, label: 'Coverage' })).toBe('Coverage');
  });

  it.each([
    {
      source: { kind: 'http', url: 'https://user:password@example.org/sample.bam' },
      message: 'may not contain embedded credentials',
    },
    {
      source: { kind: 'http', url: 'https://example.org/sample.bam?token=raw-secret' },
      message: 'may not contain credential parameters',
    },
    {
      source: {
        kind: 'http',
        url: 'https://example.org/sample.bam?X-Amz-Signature=raw-secret',
      },
      message: 'may not contain credential parameters',
    },
    {
      source: { kind: 'local-file', path: '' },
      message: 'path is required',
    },
    {
      source: { kind: 's3', bucket: 'bucket', key: '../escape.bam' },
      message: 'object key may not traverse',
    },
    {
      source: { kind: 'ucsc-track', sourceKind: 'ucsc-hub', genome: 'hg38', track: 'x' },
      message: 'hubUrl is required',
    },
  ])('rejects an unsafe or incomplete durable locator', ({ source, message }) => {
    expect(() =>
      parseTrackAdmissionRequestV1({
        contract: TRACK_ADMISSION_REQUEST_V1,
        assemblyId: 'grch38',
        source,
        formatId: 'bam',
        ingress: { kind: 'url' },
      })
    ).toThrow(message);
  });
});
