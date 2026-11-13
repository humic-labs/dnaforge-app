import { describe, expect, it } from 'vitest';
import { defineScientificDocument, parseScientificDocument } from './index';

const primer = (overrides: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  kind: 'primer',
  name: 'PCR primer',
  molecule: 'DNA',
  bases: 'acgTNN',
  modifications: [],
  fields: { custom: { retained: [1, 'text', null] } },
  ...overrides,
});

describe('scientific content and readable records', () => {
  it('accepts a zero-base sequence draft while refusing an empty primer', () => {
    expect(
      defineScientificDocument({
        formatVersion: 1,
        kind: 'sequence',
        name: 'New sequence',
        molecule: 'DNA',
        bases: '',
        topology: 'linear',
        annotations: [],
        fields: {},
      }).document
    ).toMatchObject({ kind: 'sequence', bases: '' });
    expect(() => defineScientificDocument(primer({ bases: '' }))).toThrow();
  });

  it('retains native strain relationship type and complete provenance without changing old envelopes', () => {
    for (const kind of ['strain-sequence', 'strain-descent'] as const) {
      const target = { resourceId: 'parent-or-sequence', revisionId: 'rr_' + 'a'.repeat(64) };
      const legacy = {
        formatVersion: 1,
        kind,
        strainId: 'strain',
        ...(kind === 'strain-sequence' ? { sequence: target } : { parent: target }),
        assertion: 'planned',
        evidence: [],
      };
      const old = defineScientificDocument(legacy);
      expect(old.document).toEqual(legacy);
      const fields = {
        nativeRelationshipType: kind === 'strain-sequence' ? 'carried_by' : 'derives_from',
        payload: {
          assertion: 'planned',
          method: 'homologous recombination',
          source: { preserve: ['stock', 12] },
        },
      };
      expect(defineScientificDocument({ ...legacy, fields }).document).toEqual({
        ...legacy,
        fields,
      });
    }
  });
  it('retains lowercase and custom fields while keeping display names out of calculation identity', () => {
    const first = defineScientificDocument(primer());
    const renamed = defineScientificDocument(primer({ name: 'New name' }));
    expect(first.document).toMatchObject({
      bases: 'acgTNN',
      fields: { custom: { retained: [1, 'text', null] } },
    });
    expect(renamed.scientificHash).toBe(first.scientificHash);
    expect(renamed.blob.hash).not.toBe(first.blob.hash);
    expect(parseScientificDocument(JSON.parse(first.text))).toEqual(first.document);
  });

  it('changes calculation identity for bases, modifications and custom scientific fields', () => {
    const original = defineScientificDocument(primer());
    for (const edit of [
      { bases: 'acgTNT' },
      {
        modifications: [
          { anchor: { kind: 'terminus', end: 'five-prime' }, code: '5-phosphate', details: {} },
        ],
      },
      { fields: { custom: { retained: [2, 'text', null] } } },
    ])
      expect(defineScientificDocument(primer(edit)).scientificHash).not.toBe(
        original.scientificHash
      );
  });

  it('rejects malformed bases and modification positions rather than normalizing them away', () => {
    for (const edit of [
      { bases: 'ACZ' },
      { bases: '' },
      { bases: 'ß' },
      { bases: 'ſ' },
      { modifications: [{ anchor: { kind: 'base', index: 99 }, code: 'x', details: {} }] },
      {
        modifications: [{ anchor: { kind: 'between-bases', offset: 0.5 }, code: 'x', details: {} }],
      },
    ])
      expect(() => defineScientificDocument(primer(edit))).toThrow();
  });

  it('has deterministic payload identity regardless of object-key order', () => {
    const one = defineScientificDocument(primer({ fields: { a: 1, b: 2 } }));
    const two = defineScientificDocument(primer({ fields: { b: 2, a: 1 } }));
    expect(two.blob).toEqual(one.blob);
    expect(two.scientificHash).toBe(one.scientificHash);
  });

  it('keeps sequence annotations in saved history without invalidating sequence binding calculations', () => {
    const source = {
      formatVersion: 1,
      kind: 'sequence',
      name: 'Donor',
      molecule: 'DNA',
      bases: 'ACGT',
      topology: 'linear',
      fields: {},
      annotations: [],
    };
    const before = defineScientificDocument(source);
    const after = defineScientificDocument({
      ...source,
      annotations: [{ name: 'feature', start: 1, end: 4 }],
    });
    expect(after.bindingInputHash).toBe(before.bindingInputHash);
    expect(after.scientificHash).not.toBe(before.scientificHash);
    expect(after.blob.hash).not.toBe(before.blob.hash);
  });

  it('refuses unknown fields and non-JSON data rather than silently dropping scientific input', () => {
    for (const edit of [
      { unexplained: true },
      { fields: { x: undefined } },
      { fields: { x: Infinity } },
      { fields: { x: new Date() } },
      { fields: { x: '\ud800' } },
    ])
      expect(() => defineScientificDocument(primer(edit))).toThrow();
  });

  it('accepts large sequence payloads without stuffing their bases into revision metadata', () => {
    const value = defineScientificDocument({
      formatVersion: 1,
      kind: 'sequence',
      name: 'Large reference',
      molecule: 'DNA',
      bases: 'ACGT'.repeat(250_000),
      topology: 'linear',
      annotations: [],
      fields: {},
    });
    expect(value.blob.byteLength).toBeGreaterThan(1_000_000);
    expect(value.state).toHaveProperty('hash');
  });

  it('preserves distinct base and between-base chemistry anchors', () => {
    const base = defineScientificDocument(
      primer({
        modifications: [{ anchor: { kind: 'base', index: 1 }, code: 'chemistry', details: {} }],
      })
    );
    const bond = defineScientificDocument(
      primer({
        modifications: [
          { anchor: { kind: 'between-bases', offset: 1 }, code: 'chemistry', details: {} },
        ],
      })
    );
    expect(base.bindingInputHash).not.toBe(bond.bindingInputHash);
  });

  it('does not confuse uracil with thymine or DNA orders with RNA orders', () => {
    const dna = defineScientificDocument(primer({ bases: 'ACTG' }));
    const rna = defineScientificDocument(primer({ molecule: 'RNA', bases: 'ACUG' }));
    expect(dna.bindingInputHash).not.toBe(rna.bindingInputHash);
    expect(rna.document).toMatchObject({ molecule: 'RNA', bases: 'ACUG' });
  });

  it('rejects hidden fields, getters, sparse arrays, symbols and cyclic input', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const hidden = Object.defineProperty({}, 'hidden', { value: true });
    const getter = Object.defineProperty({}, 'getter', { get: () => 1, enumerable: true });
    const symbol = { [Symbol('lost')]: 1 };
    for (const value of [cycle, hidden, getter, symbol, new Array(2)])
      expect(() => defineScientificDocument(primer({ fields: { value } }))).toThrow();
  });
});
