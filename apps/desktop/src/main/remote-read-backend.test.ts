import { describe, expect, it } from 'vitest';
import { assertRemoteReadBackend } from './remote-read-backend';

describe('supported remote read computation', () => {
  const request = { target: 'cluster', alignmentPath: '/data/reads.bam' };
  it('refuses unsupported Windows local decoding before opening SSH', () => {
    expect(() => assertRemoteReadBackend(request, 'win32')).toThrow('Linux compute service');
  });
  it('admits the existing Linux computation service on Windows', () => {
    expect(() =>
      assertRemoteReadBackend(
        { ...request, tileServerReceiptPath: '/home/user/connection.json' },
        'win32'
      )
    ).not.toThrow();
  });
  it('keeps supported macOS and Linux local processing', () => {
    expect(() => assertRemoteReadBackend(request, 'darwin')).not.toThrow();
    expect(() => assertRemoteReadBackend(request, 'linux')).not.toThrow();
  });
});
