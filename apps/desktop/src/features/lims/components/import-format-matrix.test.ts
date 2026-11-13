import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { LimsEntityKind } from '../../../shared/lims';

vi.mock('../operations', () => ({
  queryLimsEntities: async () => [],
  applyLimsImportBatch: async () => {
    throw new Error('applyLimsImportBatch not used in import-format-matrix unit tests');
  },
}));

import { createLimsImportPlan } from '../ingress';

function xlsxArrayBuffer(
  sheets: Array<{ name: string; rows: (string | number)[][] }>
): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayLike<number>;
  return new Uint8Array(out).buffer;
}

const OLIGO_ROWS: (string | number)[][] = [
  ['Name', 'Sequence'],
  ['OL-1', 'ACGTACGTACGT'],
  ['OL-2', 'TTTTGGGGCCCC'],
  ['OL-3', 'AAAACCCCGGGG'],
];

describe('import format matrix — every tabular format lands the same records', () => {
  it('CSV → 3 oligos', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: OLIGO_ROWS.map((row) => row.join(',')).join('\n'),
      forcedKind: 'oligo',
    });
    expect(plan.records).toHaveLength(3);
    expect(plan.records.every((record) => record.entityDraft.kind === 'oligo')).toBe(true);
    expect(plan.records.map((record) => record.entityDraft.name)).toEqual(['OL-1', 'OL-2', 'OL-3']);
  });

  it('TSV → 3 oligos', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.tsv',
      text: OLIGO_ROWS.map((row) => row.join('\t')).join('\n'),
      forcedKind: 'oligo',
    });
    expect(plan.records).toHaveLength(3);
    expect(plan.records.map((record) => record.entityDraft.name)).toEqual(['OL-1', 'OL-2', 'OL-3']);
  });

  it('XLSX (single sheet) → 3 oligos', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.xlsx',
      arrayBuffer: xlsxArrayBuffer([{ name: 'Oligos', rows: OLIGO_ROWS }]),
      forcedKind: 'oligo',
    });
    expect(plan.records).toHaveLength(3);
    expect(plan.records.map((record) => record.entityDraft.name)).toEqual(['OL-1', 'OL-2', 'OL-3']);
  });

  it('XLSX (multi-tab) → picks the entity sheet, not the notes sheet', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'workbook.xlsx',
      arrayBuffer: xlsxArrayBuffer([
        { name: 'ReadMe', rows: [['This workbook holds our oligo order.']] },
        { name: 'Oligos', rows: OLIGO_ROWS },
      ]),
      forcedKind: 'oligo',
    });
    expect(plan.records).toHaveLength(3);
    expect(plan.records.map((record) => record.entityDraft.name)).toEqual(['OL-1', 'OL-2', 'OL-3']);
    expect(plan.records.every((record) => record.entityDraft.kind === 'oligo')).toBe(true);
  });

  it('XLSX (multi-tab) can be pinned to an explicit sheet by name', async () => {
    const strainRows: (string | number)[][] = [
      ['Name', 'Genotype'],
      ['ST-1', 'wild-type'],
      ['ST-2', 'delta-argF'],
    ];
    const plan = await createLimsImportPlan({
      fileName: 'workbook.xlsx',
      arrayBuffer: xlsxArrayBuffer([
        { name: 'Oligos', rows: OLIGO_ROWS },
        { name: 'Strains', rows: strainRows },
      ]),
      sheetName: 'Strains',
      forcedKind: 'strain',
    });
    expect(plan.records).toHaveLength(2);
    expect(plan.records.map((record) => record.entityDraft.name)).toEqual(['ST-1', 'ST-2']);
    expect(plan.records.every((record) => record.entityDraft.kind === 'strain')).toBe(true);
  });
});

describe('import format matrix — forcedKind overrides content inference', () => {
  const strainLookingCsv = ['Name,Genotype,Organism', 'X1,dArgF,E. coli', 'X2,dLacZ,E. coli'].join(
    '\n'
  );

  it.each<[LimsEntityKind]>([['oligo'], ['strain'], ['plasmid'], ['guide_rna'], ['marker']])(
    'forcedKind=%s wins over the strain-shaped content',
    async (kind) => {
      const plan = await createLimsImportPlan({
        fileName: 'ambiguous.csv',
        text: strainLookingCsv,
        forcedKind: kind,
      });
      expect(plan.records).toHaveLength(2);
      expect(plan.records.every((record) => record.entityDraft.kind === kind)).toBe(true);
    }
  );
});
