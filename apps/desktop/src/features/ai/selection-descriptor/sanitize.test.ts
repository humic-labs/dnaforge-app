import { describe, expect, it } from 'vitest';

import {
  DB_XREF_ALLOWLIST,
  TRUNCATION_MARKER,
  allowlistDbXref,
  sanitizeUntrusted,
  truncateMiddleOut,
  untrustedField,
} from './sanitize';

const DANGEROUS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]'
);

describe('sanitizeUntrusted — control / bidi / zero-width stripping', () => {
  it('strips a C0 control, a BEL, a bidi override, and a zero-width space', () => {
    const dirty = 'safe\u0001\u0007\u202E\u200Btext';
    expect(sanitizeUntrusted(dirty, 100)).toBe('safetext');
  });

  it('leaves no bidi-override or zero-width character behind', () => {
    const clean = sanitizeUntrusted('a\u202Db\u2066c\uFEFFd', 100);
    expect(clean).toBe('abcd');
    expect(DANGEROUS.test(clean)).toBe(false);
  });

  it('folds tabs/newlines to a single space rather than deleting the words', () => {
    expect(sanitizeUntrusted('lac\tpromoter\n\nregion', 100)).toBe('lac promoter region');
  });
});

describe('sanitizeUntrusted — grapheme-boundary truncation', () => {
  it('truncates an over-cap value and appends the truncation marker', () => {
    const long = 'x'.repeat(300);
    const capped = sanitizeUntrusted(long, 120);
    expect(capped).toHaveLength(121);
    expect(capped.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(capped.startsWith('x'.repeat(120))).toBe(true);
  });

  it('leaves an under-cap value unchanged (no marker)', () => {
    const clean = sanitizeUntrusted('short note', 120);
    expect(clean).toBe('short note');
    expect(clean.endsWith(TRUNCATION_MARKER)).toBe(false);
  });
});

describe('sanitizeUntrusted — escapable markup is preserved raw (escaping is downstream)', () => {
  it('keeps a </wp-sel>-like literal intact (A3 fence escapes, not here)', () => {
    const clean = sanitizeUntrusted('note </wp-sel> injected', 100);
    expect(clean).toContain('</wp-sel>');
  });

  it('keeps angle brackets, braces, and quotes raw', () => {
    const clean = sanitizeUntrusted('a <b> {c} "d" note', 100);
    expect(clean).toBe('a <b> {c} "d" note');
  });
});

describe('untrustedField — trust envelope', () => {
  it('wraps a sanitized value with trust: untrusted-data', () => {
    expect(untrustedField('lacZ-alpha', 120)).toEqual({
      value: 'lacZ-alpha',
      trust: 'untrusted-data',
    });
  });

  it('returns null when the sanitized value is empty (caller omits the key)', () => {
    expect(untrustedField('', 120)).toBeNull();
    expect(untrustedField('   ', 120)).toBeNull();
    expect(untrustedField(undefined, 120)).toBeNull();
  });

  it('middle-out mode keeps the head and tail of a long value', () => {
    const value = `HEAD_${'m'.repeat(200)}_TAIL`;
    const field = untrustedField(value, 40, { middleOut: true });
    expect(field).not.toBeNull();
    expect(field?.trust).toBe('untrusted-data');
    expect(field?.value.startsWith('HEAD_')).toBe(true);
    expect(field?.value.endsWith('_TAIL')).toBe(true);
    expect(field?.value).toContain(TRUNCATION_MARKER);
  });
});

describe('truncateMiddleOut', () => {
  it('is a no-op below the cap', () => {
    expect(truncateMiddleOut('short', 40)).toBe('short');
  });
});

describe('allowlistDbXref — namespace allowlist', () => {
  it('keeps an allowlisted GeneID xref intact', () => {
    expect(allowlistDbXref('GeneID:123')).toBe('GeneID:123');
  });

  it('drops an unknown namespace', () => {
    expect(allowlistDbXref('EVILNS:phish')).toBeNull();
  });

  it('re-emits the canonical-cased namespace for a case-variant match', () => {
    expect(allowlistDbXref('geneid:456')).toBe('GeneID:456');
  });

  it('drops a malformed xref with no usable namespace separator', () => {
    expect(allowlistDbXref('nocolon')).toBeNull();
    expect(allowlistDbXref(':leadingcolon')).toBeNull();
    expect(allowlistDbXref(null)).toBeNull();
  });

  it('GeneID is on the exported allowlist', () => {
    expect(DB_XREF_ALLOWLIST).toContain('GeneID');
  });
});
