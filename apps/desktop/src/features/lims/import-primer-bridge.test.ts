import { describe, expect, it } from 'vitest';
import type { LimsImportPlan, LimsImportPlanRecord } from '../../shared/lims';
import {
  oligoImportSourceRowId,
  plannedPrimersForDestination,
  plannedPrimersFromImport,
} from './import-primer-bridge';

function oligoRecord(
  id: string,
  name: string,
  bases: string,
  over: Partial<LimsImportPlanRecord> = {}
): LimsImportPlanRecord {
  return {
    id,
    accepted: true,
    action: 'create',
    entityDraft: {
      kind: 'oligo',
      name,
      fields: { use: 'primer', sequence: { mode: 'inline', bases } },
    },
    duplicateCandidates: [],
    proposedLinks: [],
    unresolvedLinks: [],
    errors: [],
    warnings: [],
    source: {},
    ...over,
  } as LimsImportPlanRecord;
}

function planOf(records: LimsImportPlanRecord[]): LimsImportPlan {
  return { records } as LimsImportPlan;
}

function rnaOligoRecord(
  id: string,
  name: string,
  notation: string,
  bases: string,
  fields: Record<string, unknown> = {}
): LimsImportPlanRecord {
  return {
    ...oligoRecord(id, name, bases),
    entityDraft: {
      kind: 'rna_oligo',
      name,
      fields: {
        use: 'primer',
        sequence: { mode: 'inline', bases },
        ...fields,
      },
    },
    source: { Sequence: notation },
  } as LimsImportPlanRecord;
}

describe('plannedPrimersFromImport — import records → file-authoritative primers', () => {
  it('maps accepted oligo create records without inventing a PCR application', async () => {
    const primers = await plannedPrimersFromImport(
      planOf([oligoRecord('r1', 'oPC-0001', 'ACGTACGT'), oligoRecord('r2', 'oPC-0002', 'TTTTGGGG')])
    );
    expect(primers).toHaveLength(2);
    expect(primers[0]).toMatchObject({
      name: 'oPC-0001',
      sequence: 'ACGTACGT',
    });
    expect(primers[0].application).toBeUndefined();
    expect(primers[0].artifactStem).toMatch(/^oPC-0001-[0-9a-f]{8}$/);
  });

  it('skips records that are not accepted, not create, not oligo, or have no inline sequence', async () => {
    const primers = await plannedPrimersFromImport(
      planOf([
        oligoRecord('a', 'kept', 'ACGT'),
        oligoRecord('b', 'not-accepted', 'ACGT', { accepted: false }),
        oligoRecord('c', 'skip-action', 'ACGT', { action: 'skip' }),
        oligoRecord('d', 'wrong-kind', 'ACGT', {
          entityDraft: {
            kind: 'strain',
            name: 'wrong-kind',
            fields: {},
          } as LimsImportPlanRecord['entityDraft'],
        }),
        oligoRecord('e', 'no-seq', '', {
          entityDraft: {
            kind: 'oligo',
            name: 'no-seq',
            fields: { use: 'primer', sequence: { mode: 'unresolved' } },
          } as LimsImportPlanRecord['entityDraft'],
        }),
      ])
    );
    expect(primers.map((p) => p.name)).toEqual(['kept']);
  });

  it('same name+sequence → same stem (dedup key); different sequence → different stem', async () => {
    const [a, b] = await plannedPrimersFromImport(
      planOf([oligoRecord('r1', 'dup', 'ACGTACGT'), oligoRecord('r2', 'dup', 'ACGTACGT')])
    );
    expect(a.artifactStem).toBe(b.artifactStem);

    const [c, d] = await plannedPrimersFromImport(
      planOf([oligoRecord('r1', 'dup', 'ACGTACGT'), oligoRecord('r2', 'dup', 'GGGGCCCC')])
    );
    expect(c.artifactStem).not.toBe(d.artifactStem);
  });

  it('places artifacts directly in the selected destination directory', async () => {
    const [primer] = await plannedPrimersForDestination(
      planOf([oligoRecord('r1', 'nested oligo', 'ACGTACGT')]),
      '/workspace/orders/august'
    );

    expect(primer.artifactPath).toMatch(
      /^\/workspace\/orders\/august\/nested_oligo-[0-9a-f]{8}\.primer\.json$/
    );
  });

  it('trims whitespace from the sequence', async () => {
    const [p] = await plannedPrimersFromImport(planOf([oligoRecord('r1', 'ws', '  ACGT  ')]));
    expect(p.sequence).toBe('ACGT');
  });

  it('maps RNA oligo rows to RNA artifacts without flattening exact IDT notation', async () => {
    const notation = '/5Phos/rArCrGrUrArCrGrUrArC';
    const plan = {
      ...planOf([
        rnaOligoRecord('rna-1', 'RNA import', notation, 'ACGUACGUAC', {
          vendor: 'IDT',
          purification: 'HPLC',
          notes: 'imported order',
        }),
      ]),
      columns: [
        {
          sourceColumn: 'Sequence',
          mappedField: 'fields.sequence',
          mappingMode: 'mapped',
          confidence: 'deterministic',
          warnings: [],
        },
      ],
    } as LimsImportPlan;

    const [rna] = await plannedPrimersFromImport(plan);
    expect(rna).toMatchObject({
      name: 'RNA import',
      sequence: 'ACGUACGUAC',
      oligo: {
        vendor: 'idt',
        orderType: 'rna',
        notation,
      },
      entitySchema: { name: 'rna_oligo', baseKind: 'primer' },
      entityFields: {
        vendor: 'IDT',
        purification: 'HPLC',
        notes: 'imported order',
      },
    });
  });

  it('keeps DNA and RNA identity, and different exact chemistry, out of one artifact stem', async () => {
    const dna = oligoRecord('dna', 'same-name', 'ACGTACGTAC');
    dna.source = { Sequence: 'ACGTACGTAC' };
    const rna = rnaOligoRecord('rna', 'same-name', 'rArCrGrUrArCrGrUrArC', 'ACGUACGUAC');
    const modifiedRna = rnaOligoRecord(
      'rna-modified',
      'same-name',
      '/5Phos/rArCrGrUrArCrGrUrArC',
      'ACGUACGUAC'
    );
    const plan = {
      ...planOf([dna, rna, modifiedRna]),
      columns: [
        {
          sourceColumn: 'Sequence',
          mappedField: 'fields.sequence',
          mappingMode: 'mapped',
          confidence: 'deterministic',
          warnings: [],
        },
      ],
    } as LimsImportPlan;

    const primers = await plannedPrimersFromImport(plan);
    expect(new Set(primers.map((primer) => primer.artifactStem)).size).toBe(3);
  });

  it('uses connector row identity across reorder, rename, and chemistry edits', async () => {
    const original = oligoRecord('row-2', 'Original name', 'ACGT', {
      sourceRow: 2,
      externalRowId: 'sheet-row-abc',
    });
    const movedAndEdited = oligoRecord('row-100', 'Renamed', 'GGGG', {
      sourceRow: 100,
      externalRowId: 'sheet-row-abc',
    });

    await expect(oligoImportSourceRowId(original, 'dna:ACGT')).resolves.toBe(
      'external-sheet-row-abc'
    );
    await expect(oligoImportSourceRowId(movedAndEdited, 'dna:/5Phos/GGGG')).resolves.toBe(
      'external-sheet-row-abc'
    );
  });
});
