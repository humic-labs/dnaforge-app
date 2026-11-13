import { describe, expect, it } from 'vitest';

import {
  directRemoteSignalGrant,
  isTrustedRemoteSignalUrl,
  remoteAlignmentSourceId,
  remoteSignalSourceId,
} from './remote-signal-url';

describe('remote signal URLs', () => {
  it.each(['bam', 'cram'])('recovers the source from an SSH %s URL', (format) => {
    expect(
      remoteAlignmentSourceId(`http://127.0.0.1:43117/v1/source-handle/alignment.${format}`)
    ).toBe('source-handle');
  });

  it.each([
    'http://127.0.0.1:43117/v1/source-handle/signal.bigWig',
    'http://localhost:43117/v1/source-handle/alignment.bam',
    'https://127.0.0.1:43117/v1/source-handle/alignment.bam',
    'http://127.0.0.1:0/v1/source-handle/alignment.bam',
    'http://127.0.0.1:65536/v1/source-handle/alignment.bam',
    'http://127.0.0.1:43117/v1/source-handle/alignment.bam?source=other',
    'http://user@127.0.0.1:43117/v1/source-handle/alignment.bam',
  ])('does not recover an alignment source from %s', (url) => {
    expect(remoteAlignmentSourceId(url)).toBeNull();
  });

  it('accepts only the loopback SSH histogram route', () => {
    expect(isTrustedRemoteSignalUrl('http://127.0.0.1:43117/v1/source-handle/signal.bigWig')).toBe(
      true
    );
    expect(isTrustedRemoteSignalUrl('http://127.0.0.1:43117/v1/source-handle/alignment.bam')).toBe(
      false
    );
    expect(isTrustedRemoteSignalUrl('http://localhost:43117/v1/source-handle/signal.bigWig')).toBe(
      false
    );
    expect(isTrustedRemoteSignalUrl('https://127.0.0.1:43117/v1/source-handle/signal.bigWig')).toBe(
      false
    );
    expect(isTrustedRemoteSignalUrl('http://127.0.0.1:0/v1/source-handle/signal.bigWig')).toBe(
      false
    );
    expect(remoteSignalSourceId('http://127.0.0.1:43117/v1/source-handle/signal.bigWig')).toBe(
      'source-handle'
    );
    expect(
      remoteSignalSourceId('https://127.0.0.1:43117/v1/source-handle/signal.bigWig')
    ).toBeNull();
  });

  it('builds a direct range grant from the admitted file length', () => {
    const source = {
      uri: 'http://127.0.0.1:43117/v1/source-handle/signal.bigWig',
      fingerprint: 'fingerprint-1',
      expectedValidators: { contentLength: 4096, etag: '"abc"' },
    };

    const grant = directRemoteSignalGrant(source);

    expect(grant.directRangeUrl).toBe(source.uri);
    expect(grant.sourceUri).toBe(source.uri);
    expect(grant.byteLength).toBe(4096);
    expect(grant.etag).toBe('"abc"');
  });
});
