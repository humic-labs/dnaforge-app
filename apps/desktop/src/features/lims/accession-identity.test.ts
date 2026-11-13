// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  accessionIdentityKey,
  accessionKeysForEntityFields,
  extractRowAccessions,
  parseAccessionIdentity,
  parseAccessions,
  type AccessionRef,
} from './accession-identity';

describe('parseAccessions — Addgene', () => {
  it.each([
    ['#125028', '125028'],
    ['Addgene #125028', '125028'],
    ['Addgene 125028', '125028'],
    ['addgene:125028', '125028'],
    ['Lab, Addgene #125028', '125028'],
  ])('parses %j as Addgene %s (digits only)', (text, id) => {
    expect(parseAccessions(text)).toEqual<AccessionRef[]>([{ scheme: 'addgene', id }]);
  });
});

describe('parseAccessions — GenBank', () => {
  it.each([
    ['MN908947', 'MN908947'],
    ['MN908947.3', 'MN908947'],
    ['U00096.3', 'U00096'],
    ['CAA12345', 'CAA12345'],
  ])('parses %j as GenBank %s (uppercased, no version)', (text, id) => {
    expect(parseAccessions(text)).toEqual<AccessionRef[]>([{ scheme: 'genbank', id }]);
  });
});

describe('parseAccessions — RefSeq', () => {
  it.each([
    ['NC_000913.3', 'NC_000913'],
    ['NM_001200.1', 'NM_001200'],
    ['NP_000508.1', 'NP_000508'],
    ['NR_003286.4', 'NR_003286'],
    ['XM_011544280.1', 'XM_011544280'],
    ['WP_000123456.1', 'WP_000123456'],
  ])('parses %j as RefSeq %s (no version)', (text, id) => {
    expect(parseAccessions(text)).toEqual<AccessionRef[]>([{ scheme: 'refseq', id }]);
  });

  it('RefSeq WINS over GenBank when the token has the NC_/NM_/… prefix', () => {
    const refs = parseAccessions('NC_000913.3');
    expect(refs).toHaveLength(1);
    expect(refs[0].scheme).toBe('refseq');
  });
});

describe('parseAccessions — plain names yield NO accession', () => {
  it.each(['pUC19', 'BY4741', 'DH5alpha', 'my favorite strain'])(
    'ignores plain name %j',
    (name) => {
      expect(parseAccessions(name)).toEqual([]);
    }
  );
});

describe('parseAccessions — mixed free text finds all, deduped', () => {
  it('extracts multiple distinct accessions from one messy cell', () => {
    const refs = parseAccessions(
      'pUC19 derivative (Addgene #125028); backbone NC_000913.3; insert MN908947.3'
    );
    expect(refs).toEqual<AccessionRef[]>([
      { scheme: 'addgene', id: '125028' },
      { scheme: 'refseq', id: 'NC_000913' },
      { scheme: 'genbank', id: 'MN908947' },
    ]);
  });

  it('dedupes two versions of the same accession to a single ref', () => {
    expect(parseAccessions('NC_000913.3 and also NC_000913.2')).toEqual<AccessionRef[]>([
      { scheme: 'refseq', id: 'NC_000913' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseAccessions('')).toEqual([]);
  });
});

describe('parseAccessionIdentity', () => {
  it('returns the single accession in a lone token', () => {
    expect(parseAccessionIdentity('NC_000913.3')).toEqual<AccessionRef>({
      scheme: 'refseq',
      id: 'NC_000913',
    });
    expect(parseAccessionIdentity('Addgene #125028')).toEqual<AccessionRef>({
      scheme: 'addgene',
      id: '125028',
    });
  });

  it('returns null for a plain name', () => {
    expect(parseAccessionIdentity('pUC19')).toBeNull();
  });

  it('returns null when the value is ambiguous (two accessions)', () => {
    expect(parseAccessionIdentity('NC_000913.3 / MN908947')).toBeNull();
  });
});

describe('accessionIdentityKey', () => {
  it('formats acc:<scheme>:<normalized-id>', () => {
    expect(accessionIdentityKey({ scheme: 'genbank', id: 'MN908947' })).toBe(
      'acc:genbank:mn908947'
    );
  });

  it('collapses Addgene case/prefix variants to one key', () => {
    const a = accessionIdentityKey(parseAccessionIdentity('Addgene #125028')!);
    const b = accessionIdentityKey(parseAccessionIdentity('addgene 125028')!);
    expect(a).toBe('acc:addgene:125028');
    expect(a).toBe(b);
  });

  it('collapses two versions of a RefSeq accession to the SAME key (version-independent identity)', () => {
    const v3 = accessionIdentityKey(parseAccessionIdentity('NC_000913.3')!);
    const v2 = accessionIdentityKey(parseAccessionIdentity('NC_000913.2')!);
    expect(v3).toBe('acc:refseq:nc_000913');
    expect(v2).toBe('acc:refseq:nc_000913');
    expect(v3).toBe(v2);
  });

  it('strips a version even when handed an un-normalized ref directly', () => {
    expect(accessionIdentityKey({ scheme: 'refseq', id: 'NC_000913.3' })).toBe(
      'acc:refseq:nc_000913'
    );
  });
});

describe('extractRowAccessions', () => {
  it('collects identity keys from the named columns only, deduped', () => {
    const row = {
      name: 'pUC19 derivative',
      addgene: 'Addgene #125028',
      genbank: 'MN908947.3',
      notes: 'unrelated NR_003286.4',
    };
    expect(extractRowAccessions(row, ['addgene', 'genbank'])).toEqual([
      'acc:addgene:125028',
      'acc:genbank:mn908947',
    ]);
  });

  it('dedupes across columns and tolerates missing/blank cells', () => {
    const row = {
      a: 'NC_000913.3',
      b: 'NC_000913.2',
      c: '',
    };
    expect(extractRowAccessions(row, ['a', 'b', 'c', 'missing'])).toEqual(['acc:refseq:nc_000913']);
  });
});

describe('accessionKeysForEntityFields', () => {
  it('reads fields.accessions[] AND free text in fields.source / fields.notes', () => {
    const keys = accessionKeysForEntityFields({
      accessions: ['MN908947.3', 'NC_000913'],
      source: 'ordered from Addgene #125028',
      notes: 'see also NM_001200.1',
    });
    expect(keys).toEqual([
      'acc:genbank:mn908947',
      'acc:refseq:nc_000913',
      'acc:addgene:125028',
      'acc:refseq:nm_001200',
    ]);
  });

  it('ignores non-string entries and non-string fields', () => {
    expect(
      accessionKeysForEntityFields({
        accessions: ['NC_000913.3', 42, null],
        source: 123,
        notes: undefined,
      })
    ).toEqual(['acc:refseq:nc_000913']);
  });

  it('returns [] when there are no accessions anywhere', () => {
    expect(accessionKeysForEntityFields({ accessions: ['pUC19'], notes: 'BY4741' })).toEqual([]);
  });
});
