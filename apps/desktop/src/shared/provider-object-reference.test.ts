// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  isExactProviderStableId,
  isSafeProviderCanonicalUrl,
  parseProviderObjectReference,
  providerObjectClassForStableId,
  providerObjectReferenceKey,
} from './provider-object-reference';

const CORPUS_IDS = [
  'etr_DEMOET02',
  'etr_DEMOET03',
  'etr_DemoEtr001',
  'etr_DEMOET0004',
  'seq_DemoSeq004',
  'seq_DEMOSQ0004',
  'seq_DemoSeq3',
  'seq_DEMOSQ03',
  'bfi_DEMOBF01',
  'ent_DemoEnt1',
];

describe('isExactProviderStableId', () => {
  it.each(CORPUS_IDS)('accepts the real corpus ID %s', (id) => {
    expect(isExactProviderStableId(id)).toBe(true);
  });

  it.each([
    ['seq_x', 'a short token of the kind GenBank feature labels contain'],
    ['seq_12345', 'five characters, still below the real ID length'],
    ['seq_', 'a prefix with no suffix'],
    ['E80ZiLEIVE', 'a bare suffix with no type prefix'],
    ['seq E80ZiLEIVE', 'a space instead of an underscore'],
    ['seq_E80Zi-LEIVE', 'a hyphen, which Benchling IDs do not use'],
    ['seq_E80Zi/LEIVE', 'a path separator'],
    ['', 'the empty string'],
  ])('rejects %s (%s)', (value) => {
    expect(isExactProviderStableId(value)).toBe(false);
  });

  it.each(['lib_DemoLib2', 'fld_abc123def', 'src_abc123def'])(
    'rejects the folder identifier %s, which names a container and not a linkable object',
    (id) => {
      expect(isExactProviderStableId(id)).toBe(false);
    }
  );

  it.each([null, undefined, 42, {}, [], true])('rejects the non-string %s', (value) => {
    expect(isExactProviderStableId(value)).toBe(false);
  });
});

describe('providerObjectClassForStableId', () => {
  it.each([
    ['etr_DEMOET0004', 'notebook'],
    ['seq_DemoSeq004', 'sequence'],
    ['prtn_abc123def', 'protein'],
    ['prt_abc123def', 'protocol'],
    ['ent_DemoEnt1', 'registry_entity'],
    ['bfi_DEMOBF01', 'registry_entity'],
  ] as const)('maps %s to %s', (id, expected) => {
    expect(providerObjectClassForStableId(id)).toBe(expected);
  });

  it('returns null for an unknown prefix rather than guessing a class', () => {
    expect(providerObjectClassForStableId('zzz_abc123def')).toBeNull();
  });

  it('returns null for something that is not an exact ID at all', () => {
    expect(providerObjectClassForStableId('seq_x')).toBeNull();
  });
});

describe('isSafeProviderCanonicalUrl', () => {
  it('accepts an exact HTTPS Benchling URL', () => {
    expect(
      isSafeProviderCanonicalUrl(
        'https://benchling.com/exampleowner/f/lib_DemoLib2-sundew-localization/seq_DemoSeq004-x/edit'
      )
    ).toBe(true);
  });

  it('accepts a tenant subdomain', () => {
    expect(isSafeProviderCanonicalUrl('https://examplelab.benchling.com/x')).toBe(true);
  });

  it.each([
    ['http://benchling.com/x', 'plain HTTP'],
    ['https://benchling.com.evil.test/x', 'a lookalike host that merely starts with the name'],
    ['https://user:pw@benchling.com/x', 'embedded credentials'],
    ['javascript:alert(1)', 'a script URL'],
    ['file:///etc/passwd', 'a local file URL'],
    ['not a url', 'unparseable text'],
  ])('rejects %s (%s)', (url) => {
    expect(isSafeProviderCanonicalUrl(url)).toBe(false);
  });
});

describe('parseProviderObjectReference', () => {
  const valid = {
    provider: 'benchling',
    stableObjectId: 'seq_DemoSeq004',
    objectClass: 'sequence',
    canonicalUrl: 'https://benchling.com/exampleowner/f/lib_x/seq_DemoSeq004-y/edit',
    providerAccountHint: 'pnciaccia',
  };

  it('round-trips a well-formed reference', () => {
    expect(parseProviderObjectReference(valid)).toEqual(valid);
  });

  it('keeps the reference but drops an unsafe canonical URL', () => {
    const parsed = parseProviderObjectReference({ ...valid, canonicalUrl: 'http://evil.test' });
    expect(parsed).toMatchObject({ stableObjectId: 'seq_DemoSeq004', canonicalUrl: null });
  });

  it.each([
    [{ ...valid, provider: 'notion' }, 'an unsupported provider'],
    [{ ...valid, stableObjectId: 'seq_x' }, 'an ID below the exact shape'],
    [{ ...valid, stableObjectId: 'lib_DemoLib2' }, 'a folder ID'],
    [{ ...valid, objectClass: 'plasmid' }, 'an unknown object class'],
    [null, 'null'],
    ['seq_DemoSeq004', 'a bare string'],
    [[valid], 'an array'],
  ])('returns null for %o (%s)', (value) => {
    expect(parseProviderObjectReference(value)).toBeNull();
  });

  it('never throws on malformed input, because it parses notebook-stored attributes', () => {
    for (const value of [undefined, 0, NaN, Symbol('x'), () => undefined, new Map()]) {
      expect(() => parseProviderObjectReference(value)).not.toThrow();
    }
  });
});

describe('providerObjectReferenceKey', () => {
  it('separates references that differ only by object class', () => {
    const notebook = providerObjectReferenceKey({
      provider: 'benchling',
      stableObjectId: 'etr_DEMOET0004',
      objectClass: 'notebook',
    });
    const sequence = providerObjectReferenceKey({
      provider: 'benchling',
      stableObjectId: 'etr_DEMOET0004',
      objectClass: 'sequence',
    });
    expect(notebook).not.toEqual(sequence);
  });
});
