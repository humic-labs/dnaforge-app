import { describe, expect, it } from 'vitest';

import {
  FormatHandlerRegistry,
  extractExtension,
  extractFilename,
  formatInputUri,
  matchesMagic,
  normalizeExtension,
  type FormatHandler,
  type FormatInput,
} from './format-handler';

function fakeHandler(overrides: Partial<FormatHandler> = {}): FormatHandler {
  return {
    id: overrides.id ?? 'fake',
    extensions: overrides.extensions ?? ['.fake'],
    magic: overrides.magic,
    mimeTypes: overrides.mimeTypes,
    recommendedTypes: overrides.recommendedTypes ?? ['annotation-fake'],
    toTrackSource(input: FormatInput) {
      return {
        uri: formatInputUri(input),
        formatId: overrides.id ?? 'fake',
        input,
        recommendedTypes: overrides.recommendedTypes ?? ['annotation-fake'],
      };
    },
  };
}

describe('normalizeExtension', () => {
  it('lowercases and adds leading dot when missing', () => {
    expect(normalizeExtension('BAM')).toBe('.bam');
  });
  it('keeps the leading dot when already present', () => {
    expect(normalizeExtension('.BigWig')).toBe('.bigwig');
  });
  it('handles compound extensions verbatim', () => {
    expect(normalizeExtension('.bed.gz')).toBe('.bed.gz');
  });
});

describe('formatInputUri', () => {
  it('normalizes paths, URLs, and in-memory inputs into stable URIs', () => {
    expect(formatInputUri({ kind: 'path', path: '/data/sample.bam' })).toBe(
      'file:///data/sample.bam'
    );
    expect(formatInputUri({ kind: 'url', url: 'https://example.org/sample.bw' })).toBe(
      'https://example.org/sample.bw'
    );
    expect(
      formatInputUri({
        kind: 'blob',
        blob: new Uint8Array([1]),
        filename: 'sample.bb',
      })
    ).toBe('memory:sample.bb');
  });
});

describe('extractFilename', () => {
  it('returns the basename for a path', () => {
    expect(extractFilename({ kind: 'path', path: '/a/b/c.bam' })).toBe('c.bam');
  });
  it('returns the basename for a Windows-style path', () => {
    expect(extractFilename({ kind: 'path', path: 'C:\\a\\b\\c.bam' })).toBe('c.bam');
  });
  it('returns the last path segment for a URL', () => {
    expect(extractFilename({ kind: 'url', url: 'https://example.com/data/foo.bigwig' })).toBe(
      'foo.bigwig'
    );
  });
  it('returns null for a malformed URL', () => {
    expect(extractFilename({ kind: 'url', url: 'not://a real url at all//' })).toBe(null);
  });
  it('returns null when blob has no filename hint', () => {
    expect(extractFilename({ kind: 'blob', blob: new Uint8Array() })).toBe(null);
  });
  it('returns the blob filename when present', () => {
    expect(extractFilename({ kind: 'blob', blob: new Uint8Array(), filename: 'x.bed' })).toBe(
      'x.bed'
    );
  });
});

describe('extractExtension', () => {
  it('returns the lowercased extension with dot', () => {
    expect(extractExtension('foo.BAM')).toBe('.bam');
  });
  it('peels one extra extension off compression suffixes', () => {
    expect(extractExtension('foo.bed.gz')).toBe('.bed.gz');
    expect(extractExtension('chr1.gff3.bgz')).toBe('.gff3.bgz');
  });
  it('returns null for files with no extension', () => {
    expect(extractExtension('README')).toBe(null);
  });
});

describe('matchesMagic', () => {
  it('matches when source starts with handler magic', () => {
    const magic = new Uint8Array([0x42, 0x41, 0x4d, 0x01]);
    const source = new Uint8Array([0x42, 0x41, 0x4d, 0x01, 0xff, 0xff]);
    expect(matchesMagic(magic, source)).toBe(true);
  });
  it('rejects when source is shorter than magic', () => {
    const magic = new Uint8Array([0x42, 0x41, 0x4d, 0x01]);
    expect(matchesMagic(magic, new Uint8Array([0x42, 0x41]))).toBe(false);
  });
  it('returns false when handler has no magic', () => {
    expect(matchesMagic(undefined, new Uint8Array([0x42]))).toBe(false);
    expect(matchesMagic(new Uint8Array(), new Uint8Array([0x42]))).toBe(false);
  });
});

describe('FormatHandlerRegistry', () => {
  it('throws on duplicate id registration', () => {
    const r = new FormatHandlerRegistry();
    r.register(fakeHandler({ id: 'a' }));
    expect(() => r.register(fakeHandler({ id: 'a' }))).toThrow(/already registered/);
  });
  it('looks up by id, extension, and mime', () => {
    const r = new FormatHandlerRegistry();
    const h = fakeHandler({ id: 'bam', extensions: ['.bam'], mimeTypes: ['application/x-bam'] });
    r.register(h);
    expect(r.findById('bam')).toBe(h);
    expect(r.findByExtension('.BAM')).toBe(h);
    expect(r.findByExtension('bam')).toBe(h);
    expect(r.findByMime('Application/X-Bam')).toBe(h);
  });
  it('unregister cleans up extension + mime maps', () => {
    const r = new FormatHandlerRegistry();
    const h = fakeHandler({ id: 'bam', extensions: ['.bam'], mimeTypes: ['application/x-bam'] });
    r.register(h);
    expect(r.unregister('bam')).toBe(true);
    expect(r.findById('bam')).toBe(null);
    expect(r.findByExtension('.bam')).toBe(null);
    expect(r.findByMime('application/x-bam')).toBe(null);
  });
  it('detect: magic-byte prefix wins over extension', () => {
    const r = new FormatHandlerRegistry();
    const bam = fakeHandler({
      id: 'bam',
      extensions: ['.bam'],
      magic: new Uint8Array([0x42, 0x41, 0x4d, 0x01]),
    });
    const wrongExt = fakeHandler({ id: 'gff3', extensions: ['.gff3'] });
    r.register(bam);
    r.register(wrongExt);
    const blob = new Uint8Array([0x42, 0x41, 0x4d, 0x01, 0x00]);
    expect(r.detect({ kind: 'blob', blob, filename: 'wrong.gff3' })).toBe(bam);
  });
  it('detect: extension wins when no magic / no mime', () => {
    const r = new FormatHandlerRegistry();
    const bigwig = fakeHandler({ id: 'bigwig', extensions: ['.bigwig', '.bw'] });
    r.register(bigwig);
    expect(r.detect({ kind: 'path', path: '/d/sample.BW' })).toBe(bigwig);
  });
  it('detect: returns null when nothing matches', () => {
    const r = new FormatHandlerRegistry();
    r.register(fakeHandler({ id: 'bam', extensions: ['.bam'] }));
    expect(r.detect({ kind: 'path', path: '/d/sample.unknown' })).toBe(null);
  });
  it('detect: MIME hint matches when present and no magic', () => {
    const r = new FormatHandlerRegistry();
    const h = fakeHandler({
      id: 'bigwig',
      extensions: ['.bigwig'],
      mimeTypes: ['application/x-bigwig'],
    });
    r.register(h);
    expect(
      r.detect({ kind: 'url', url: 'https://example.com/x' }, { mime: 'application/x-bigwig' })
    ).toBe(h);
  });
});
