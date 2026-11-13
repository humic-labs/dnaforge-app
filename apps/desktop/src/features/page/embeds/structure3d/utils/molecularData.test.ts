import { describe, expect, it } from 'vitest';
import {
  molecularDataPublicationSchema,
  molecularDataLayerSchema,
  parseMolecularDataTable,
  prepareMolecularDataPublication,
  compileMolecularDataColors,
  molecularDataColor,
  stableMolecularDataJson,
} from './molecularData';

const digest = 'a'.repeat(64);
const publication = {
  id: 'python-signal',
  name: 'Independent Python result',
  records: [
    { chain: 'A', position: 1, before: 9, after: 1, ratio: 0.2, class: 'rna' },
    { chain: 'D', position: 2, before: 1, after: 9, ratio: 5, class: 'protein' },
    { chain: 'H', position: 1, before: 4, after: 4, ratio: null, class: 'ligand' },
  ],
  source: { label: 'Synthetic calibration; not experimental enrichment', script: 'derive.py' },
  mapping: {
    coordinateSha256: digest,
    selectorColumns: { label_asym_id: 'chain', label_seq_id: 'position' },
  },
};
const layer = {
  id: 'ratio-view',
  name: 'Ratio',
  datasetId: publication.id,
  dataRevision: digest,
  mappingRevision: digest,
  column: 'ratio',
  style: {
    kind: 'continuous',
    domain: [0, 5],
    colors: ['#000000', '#ffffff'],
    missingColor: '#aaaaaa',
    transform: 'linear',
  },
};

describe('general molecular data', () => {
  it('uses locale-independent key order for durable scientific data identities', () => {
    expect(stableMolecularDataJson({ a: 1, A: 2, z: 3, ä: 4, Z: 5 })).toBe(
      '{"A":2,"Z":5,"a":1,"z":3,"ä":4}'
    );
  });
  it('retains arbitrary columns and repeated observations; separates data and mapping revisions', async () => {
    const first = await prepareMolecularDataPublication(publication);
    expect(first.dataset.records).toEqual(publication.records);
    expect(first.mapping.targets[0]).toEqual({
      row: 0,
      selector: { label_asym_id: 'A', label_seq_id: 1 },
    });
    const second = await prepareMolecularDataPublication({
      ...publication,
      mapping: {
        ...publication.mapping,
        selectorColumns: { auth_asym_id: 'chain', auth_seq_id: 'position' },
      },
    });
    expect(first.dataset.revision).toBe(second.dataset.revision);
    expect(first.mapping.revision).not.toBe(second.mapping.revision);
    const duplicate = await prepareMolecularDataPublication({
      ...publication,
      records: [...publication.records, publication.records[0]],
    });
    expect(duplicate.dataset.records).toHaveLength(4);
    expect(duplicate.mapping.targets).toHaveLength(4);
  });

  it('parses strict ordinary CSV/TSV without renaming arbitrary fields or treating missing as zero', () => {
    expect(parseMolecularDataTable('chain,value\n,\nA,0\n', 'csv')).toEqual([
      { chain: null, value: null },
      { chain: 'A', value: '0' },
    ]);
    expect(parseMolecularDataTable('value\n""', 'csv')).toEqual([{ value: null }]);
    expect(
      parseMolecularDataTable(
        'chain\tposition\tmy ratio\tnote\nA\t1\t0\t"a\tquoted note"\nD\t2\t\tother\n',
        'tsv'
      )
    ).toEqual([
      { chain: 'A', position: '1', 'my ratio': '0', note: 'a\tquoted note' },
      { chain: 'D', position: '2', 'my ratio': null, note: 'other' },
    ]);
    expect(() => parseMolecularDataTable('x,x\n1,2', 'csv')).toThrow(/unique/i);
    expect(() => parseMolecularDataTable('x,y\n1,2,3', 'csv')).toThrow(/columns/i);
    expect(() => parseMolecularDataTable('x,y\n"unterminated,1', 'csv')).toThrow(/quote/i);
    expect(() => parseMolecularDataTable('x,y\n"closed"extra,1', 'csv')).toThrow(/quote/i);
    expect(() => parseMolecularDataTable('x,y\nunescaped"quote,1', 'csv')).toThrow(/quote/i);
  });

  it('accepts disjoint atom groups, RNA, modified monomers and explicit unresolved records', async () => {
    const prepared = await prepareMolecularDataPublication({
      ...publication,
      mapping: {
        coordinateSha256: digest,
        targets: [
          {
            row: 0,
            selector: [
              { label_asym_id: 'A', label_comp_id: 'PSU' },
              { label_asym_id: 'B', label_atom_id: 'P' },
            ],
          },
          {
            row: 1,
            selector: {
              auth_asym_id: 'A',
              auth_seq_id: 2,
              pdbx_PDB_ins_code: 'B',
              instance_id: 'ASM-1',
            },
          },
        ],
        unresolved: [{ row: 2, reason: 'No coordinates in this model' }],
      },
    });
    expect(prepared.mapping.targets[0].selector).toHaveLength(2);
    expect(prepared.mapping.unresolved).toEqual([
      { row: 2, reason: 'No coordinates in this model' },
    ]);
  });

  it('rejects unscoped residue numbers, absent columns and unsupported residue_index', async () => {
    expect(
      molecularDataPublicationSchema.safeParse({
        ...publication,
        mapping: { coordinateSha256: digest, targets: [{ row: 0, selector: { label_seq_id: 1 } }] },
      }).success
    ).toBe(false);
    expect(
      molecularDataPublicationSchema.safeParse({
        ...publication,
        mapping: {
          coordinateSha256: digest,
          targets: [{ row: 0, selector: { residue_index: 1 } }],
        },
      }).success
    ).toBe(false);
    await expect(
      prepareMolecularDataPublication({
        ...publication,
        mapping: { ...publication.mapping, selectorColumns: { label_asym_id: 'does-not-exist' } },
      })
    ).rejects.toThrow(/column/i);
  });

  it('retains producer-declared unresolved rows when mapping the remaining rows from columns', async () => {
    const input = {
      ...publication,
      mapping: {
        ...publication.mapping,
        unresolved: [{ row: 2, reason: 'The producer could not map this observation.' }],
      },
    };
    const { dataset, mapping } = await prepareMolecularDataPublication(input);
    expect(dataset.records).toEqual(publication.records);
    expect(mapping.targets.map(({ row }) => row)).toEqual([0, 1]);
    expect(mapping.unresolved).toEqual(input.mapping.unresolved);
    const automatic = await prepareMolecularDataPublication(publication);
    expect(dataset.revision).toBe(automatic.dataset.revision);
    expect(mapping.revision).not.toBe(automatic.mapping.revision);
    await expect(
      prepareMolecularDataPublication({
        ...publication,
        mapping: {
          coordinateSha256: digest,
          targets: [{ row: 2, selector: { label_asym_id: 'H' } }],
          unresolved: input.mapping.unresolved,
        },
      })
    ).rejects.toThrow('A row cannot be both mapped and explicitly unresolved.');
  });

  it('colors supplied numeric or categorical results, preserving missing values and exact scopes', async () => {
    const { dataset, mapping } = await prepareMolecularDataPublication(publication);
    const actual = { ...layer, dataRevision: dataset.revision, mappingRevision: mapping.revision };
    const numeric = compileMolecularDataColors(
      dataset,
      mapping,
      molecularDataLayerSchema.parse(actual)
    );
    expect(numeric).toEqual([
      { row: 0, selector: { label_asym_id: 'A', label_seq_id: 1 }, color: '#0a0a0a' },
      { row: 1, selector: { label_asym_id: 'D', label_seq_id: 2 }, color: '#ffffff' },
      { row: 2, selector: { label_asym_id: 'H', label_seq_id: 1 }, color: '#aaaaaa' },
    ]);
    expect(
      compileMolecularDataColors(
        dataset,
        mapping,
        molecularDataLayerSchema.parse({
          ...actual,
          column: 'class',
          style: {
            kind: 'categorical',
            colors: { rna: '#ff0000', protein: '#0000ff', ligand: '#00ff00' },
            missingColor: '#aaaaaa',
          },
        })
      ).map((row) => row.color)
    ).toEqual(['#ff0000', '#0000ff', '#00ff00']);
    expect(() =>
      compileMolecularDataColors(dataset, mapping, {
        ...actual,
        dataRevision: 'b'.repeat(64),
      } as never)
    ).toThrow(/revision/i);
    expect(() =>
      compileMolecularDataColors(dataset, mapping, { ...actual, column: 'absent' } as never)
    ).toThrow(/column/i);
  });

  it('requires explicit replicate selection and does not average overlapping observations', async () => {
    const { dataset, mapping } = await prepareMolecularDataPublication({
      ...publication,
      records: [
        { chain: 'A', position: 1, replicate: 'one', ratio: 0 },
        { chain: 'A', position: 1, replicate: 'two', ratio: 5 },
      ],
    });
    const actual = molecularDataLayerSchema.parse({
      ...layer,
      dataRevision: dataset.revision,
      mappingRevision: mapping.revision,
    });
    expect(() => compileMolecularDataColors(dataset, mapping, actual)).toThrow(
      /overlap|observations/i
    );
    expect(
      compileMolecularDataColors(dataset, mapping, {
        ...actual,
        filter: { column: 'replicate', equals: 'two' },
      })
    ).toEqual([{ row: 1, selector: { label_asym_id: 'A', label_seq_id: 1 }, color: '#ffffff' }]);
  });

  it('treats arbitrary category names as data and permits overlapping groups belonging to the same observation', async () => {
    expect(
      molecularDataColor('toString', {
        kind: 'categorical',
        colors: { rna: '#123456' },
        missingColor: '#abcdef',
      })
    ).toBe('#abcdef');
    const { dataset, mapping } = await prepareMolecularDataPublication({
      ...publication,
      records: [{ ratio: 1 }],
      mapping: {
        coordinateSha256: digest,
        targets: [
          { row: 0, selector: { label_asym_id: 'A' } },
          { row: 0, selector: { label_asym_id: 'A' } },
        ],
      },
    });
    expect(
      compileMolecularDataColors(
        dataset,
        mapping,
        molecularDataLayerSchema.parse({
          ...layer,
          dataRevision: dataset.revision,
          mappingRevision: mapping.revision,
        })
      )
    ).toHaveLength(2);
  });
});
