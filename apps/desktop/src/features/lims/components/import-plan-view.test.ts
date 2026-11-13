import { describe, expect, it, vi } from 'vitest';
import type { LimsIdScheme, LimsImportPlan } from '../../../shared/lims';

vi.mock('../operations', () => ({
  queryLimsEntities: async () => [],
  applyLimsImportBatch: async () => {
    throw new Error('applyLimsImportBatch not used in import-plan-view unit tests');
  },
}));

import { createLimsImportPlan } from '../ingress';
import { computeImportPlanView, importRecordDuplicateKind } from './import-plan-view';

function oligoScheme(overrides: Partial<LimsIdScheme> = {}): LimsIdScheme {
  return {
    kind: 'oligo',
    prefix: 'o',
    padWidth: 6,
    nextSeq: 123,
    enabled: true,
    updatedAt: 0,
    ...overrides,
  };
}

async function threeCleanOligos(): Promise<LimsImportPlan> {
  return createLimsImportPlan({
    fileName: 'oligos.csv',
    text: ['Name,Sequence', 'OL-a,ACGTACGTACGT', 'OL-b,TTTTGGGGCCCC', 'OL-c,AAAACCCCGGGG'].join(
      '\n'
    ),
    forcedKind: 'oligo',
  });
}

describe('computeImportPlanView — registry-ID auto-increment preview', () => {
  it('mints one sequential id per registrable record, starting at the scheme nextSeq', async () => {
    const plan = await threeCleanOligos();
    const view = computeImportPlanView(plan, [oligoScheme()]);

    expect(view.showRegistryId).toBe(true);
    const ids = [...view.idPreview.values()];
    expect(ids).toEqual(['o000123', 'o000124', 'o000125']);
    expect(view.idPreviewSample).toBe('o000123, o000124');
    expect(view.idRange).toBe('o000123 – o000125');
  });

  it('honors an explicit prefix override without touching the scheme prefix', async () => {
    const plan = await threeCleanOligos();
    const view = computeImportPlanView(plan, [oligoScheme()], 'pXYZ');
    expect([...view.idPreview.values()]).toEqual(['pXYZ000123', 'pXYZ000124', 'pXYZ000125']);
  });

  it('respects padWidth and a different nextSeq', async () => {
    const plan = await threeCleanOligos();
    const view = computeImportPlanView(plan, [oligoScheme({ padWidth: 3, nextSeq: 9 })]);
    expect([...view.idPreview.values()]).toEqual(['o009', 'o010', 'o011']);
  });

  it('mints no ids and hides the column when the matching scheme is disabled', async () => {
    const plan = await threeCleanOligos();
    const view = computeImportPlanView(plan, [oligoScheme({ enabled: false })]);
    expect(view.showRegistryId).toBe(false);
    expect(view.idPreview.size).toBe(0);
    expect(view.idRange).toBe('');
  });

  it('mints no ids when there is no scheme for the target kind', async () => {
    const plan = await threeCleanOligos();
    const view = computeImportPlanView(plan, [oligoScheme({ kind: 'strain' })]);
    expect(view.showRegistryId).toBe(false);
    expect(view.idPreview.size).toBe(0);
  });

  it('skips records with a blocking error when assigning ids', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: ['Name,Sequence', 'OL-good,ACGTACGTACGT', 'OL-bad,ZZZ-not-dna'].join('\n'),
      forcedKind: 'oligo',
    });
    const view = computeImportPlanView(plan, [oligoScheme()]);
    expect([...view.idPreview.values()]).toEqual(['o000123']);
  });
});

describe('computeImportPlanView — column order follows the REGISTRY, not the source file', () => {
  it('reorders mapped columns into registry-field order and trails unmapped (custom) columns', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: ['Sequence,Freezer Box,Name', 'ACGTACGTACGT,Box A,OL-a'].join('\n'),
      forcedKind: 'oligo',
    });
    const view = computeImportPlanView(plan, [oligoScheme()]);
    expect(view.dataColumns).toEqual(['Name', 'Sequence', 'Freezer Box']);
    expect(view.orderedColumns.map((column) => column.sourceColumn)).toEqual(view.dataColumns);
  });
});

describe('computeImportPlanView — required registry fields are a hard mapping gate', () => {
  it('blocks canApply and reports the unmet field when a required field has no column mapped', async () => {
    const plan = await threeCleanOligos();
    const unmapped: LimsImportPlan = {
      ...plan,
      columns: plan.columns.map((column) =>
        column.mappedField === 'fields.sequence'
          ? { ...column, mappingMode: 'source_only', mappedField: undefined }
          : column
      ),
    };
    const view = computeImportPlanView(unmapped, [oligoScheme()]);
    expect(view.requiredFieldsUnmet.map((f) => f.value)).toContain('fields.sequence');
    expect(view.canApply).toBe(false);
  });

  it('allows canApply once every required field has a column mapped', async () => {
    const plan = await threeCleanOligos();
    const view = computeImportPlanView(plan, [oligoScheme()]);
    expect(view.requiredFieldsUnmet).toHaveLength(0);
    expect(view.canApply).toBe(true);
  });

  it('ignoring the required column also blocks (ignored ≠ mapped)', async () => {
    const plan = await threeCleanOligos();
    const ignored: LimsImportPlan = {
      ...plan,
      columns: plan.columns.map((column) =>
        column.mappedField === 'fields.sequence'
          ? { ...column, mappingMode: 'ignored', mappedField: undefined }
          : column
      ),
    };
    const view = computeImportPlanView(ignored, [oligoScheme()]);
    expect(view.requiredFieldsUnmet.map((f) => f.value)).toContain('fields.sequence');
    expect(view.canApply).toBe(false);
  });
});

describe('computeImportPlanView — duplicate column mapping is a hard gate', () => {
  it('flags the duplicated field on both columns and blocks canApply', async () => {
    const plan = await threeCleanOligos();
    const dupPlan: LimsImportPlan = {
      ...plan,
      columns: plan.columns.map((column) => ({
        ...column,
        mappingMode: 'mapped',
        mappedField: 'entity.name',
      })),
    };
    const view = computeImportPlanView(dupPlan, [oligoScheme()]);

    expect(view.hasDuplicateMapping).toBe(true);
    expect(view.duplicatedFields.has('entity.name')).toBe(true);
    expect(view.columnsByField.get('entity.name')?.length).toBe(plan.columns.length);
    expect(view.canApply).toBe(false);
  });

  it('does not flag a duplicate when every column maps to a distinct field', async () => {
    const plan = await threeCleanOligos();
    const view = computeImportPlanView(plan, [oligoScheme()]);
    expect(view.hasDuplicateMapping).toBe(false);
    expect(view.duplicatedFields.size).toBe(0);
  });
});

describe('computeImportPlanView — accepted / new / flagged counts', () => {
  it('describes amino-acid FASTA records as proteins', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'proteins.faa',
      text: '>alpha first protein\nMSTNPKPQR\n>beta second protein\nGGHPEVYIL\n',
      forcedKind: 'protein',
    });

    const view = computeImportPlanView(plan, []);
    expect(view.detectedRecordsText).toBe('2 proteins');
    expect(view.newCount).toBe(2);
  });

  it('counts a missing-required flag as accepted + flagged, not blocked', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: ['Name,Sequence', 'OL-clean,ACGTACGTACGT', 'OL-flag,'].join('\n'),
      forcedKind: 'oligo',
    });
    const view = computeImportPlanView(plan, []);
    expect(view.acceptedCount).toBe(2);
    expect(view.flaggedCount).toBe(1);
    expect(view.canApply).toBe(true);
    const flagged = plan.records.find((record) => record.entityDraft.name === 'OL-flag');
    expect(flagged?.entityDraft.registrationStatus).toBe('unresolved');
  });

  it('excludes an intra-file duplicate from the new count and classifies it as a batch dup', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: ['Name,Sequence', 'OL-dup,ACGTACGTACGT', 'OL-dup,ACGTACGTACGT'].join('\n'),
      forcedKind: 'oligo',
    });
    const view = computeImportPlanView(plan, [oligoScheme()]);
    const dupRecord = plan.records.find((record) => record.duplicateCandidates.length > 0);
    expect(dupRecord && importRecordDuplicateKind(dupRecord)).toBe('batch');
    expect(view.newCount).toBeLessThan(plan.records.length);
  });

  it('reports a sequence-file plan as showing no registry-ID column', async () => {
    const plan = await threeCleanOligos();
    const seqPlan: LimsImportPlan = { ...plan, columns: [] };
    const view = computeImportPlanView(seqPlan, [oligoScheme()]);
    expect(view.sequenceFiles).toBe(true);
    expect(view.showRegistryId).toBe(false);
  });
});

describe('computeImportPlanView — "everything is already registered" terminal state ', () => {
  const seqPlan = (records: LimsImportPlan['records']): LimsImportPlan => ({
    id: 'plan-1',
    sourceName: 'pUC19.gb',
    sourceKind: 'genbank',
    detectedKind: 'sequence_file',
    columns: [],
    records,
    aggregateWarnings: [],
    canApply: records.some((r) => r.accepted && r.action === 'create'),
    oracle: { ok: true, checks: [], summary: '' },
  });
  const seqRecord = (
    over: Partial<LimsImportPlan['records'][number]>
  ): LimsImportPlan['records'][number] => ({
    id: 'sequence-file-1',
    accepted: false,
    action: 'skip',
    entityDraft: { kind: 'plasmid', name: 'pUC19', fields: {} },
    requiresRegistrationKind: false,
    duplicateCandidates: [],
    proposedLinks: [],
    unresolvedLinks: [],
    errors: [],
    warnings: [],
    source: {},
    ...over,
  });

  it('flags allAlreadyRegistered when every record is a registry identity duplicate', () => {
    const plan = seqPlan([
      seqRecord({
        duplicateCandidates: [
          {
            entityId: 'plasmid-registered',
            name: 'pUC19',
            reason: 'Existing registry record has the same file-byte hash.',
          },
        ],
      }),
    ]);
    const view = computeImportPlanView(plan, []);
    expect(view.registryDuplicateCount).toBe(1);
    expect(view.acceptedCount).toBe(0);
    expect(view.allAlreadyRegistered).toBe(true);
    expect(view.alreadyRegisteredName).toBe('pUC19');
  });

  it('stays allAlreadyRegistered even when a duplicate row is manually CHECKED (codex P2 — no dead-Next regression)', () => {
    const plan = seqPlan([
      seqRecord({
        accepted: true,
        action: 'create',
        duplicateCandidates: [
          {
            entityId: 'plasmid-registered',
            name: 'pUC19',
            reason: 'Existing registry record has the same file-byte hash.',
          },
        ],
      }),
    ]);
    const view = computeImportPlanView(plan, []);
    expect(view.acceptedCount).toBe(1);
    expect(view.allAlreadyRegistered).toBe(true);
  });

  it('is NOT a terminal-done state when a genuine error is present (a real block, not a dup)', () => {
    const plan = seqPlan([seqRecord({ errors: ['Malformed sequence — could not parse.'] })]);
    const view = computeImportPlanView(plan, []);
    expect(view.allAlreadyRegistered).toBe(false);
  });

  it('is NOT terminal-done when at least one record is new + accepted (a mix)', () => {
    const plan = seqPlan([
      seqRecord({
        duplicateCandidates: [
          {
            entityId: 'x',
            name: 'pUC19',
            reason: 'Existing registry record has the same file-byte hash.',
          },
        ],
      }),
      seqRecord({
        id: 'sequence-file-2',
        accepted: true,
        action: 'create',
        entityDraft: { kind: 'plasmid', name: 'new-plasmid', fields: {} },
      }),
    ]);
    const view = computeImportPlanView(plan, []);
    expect(view.acceptedCount).toBe(1);
    expect(view.allAlreadyRegistered).toBe(false);
  });

  it('is NOT terminal-done for an empty plan (no records to be "already registered")', () => {
    const view = computeImportPlanView(seqPlan([]), []);
    expect(view.allAlreadyRegistered).toBe(false);
  });
});
