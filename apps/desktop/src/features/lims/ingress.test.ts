import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { LimsEntity } from '../../shared/lims';
import { listImportableSheets } from '../../shared/lims';
import {
  applyAcceptedLimsImportPlan,
  applyImportPlanColumnMappings,
  applyImportPlanRecordKind,
  buildWorkbookSheetPreviews,
  createLimsImportPlan,
  describeLimsImportPlanForAgent,
  dryRunLimsImport,
  setImportPlanRecordAccepted,
  setImportRecordAccepted,
} from './ingress';
import { applyLimsImportBatch, queryLimsEntities } from './operations';

vi.mock('../../db', () => ({
  ensureSequenceIdentity: vi.fn(async () => 1),
}));

vi.mock('./operations', () => {
  return {
    queryLimsEntities: vi.fn(async () => []),
    applyLimsImportBatch: vi.fn(async () => ({
      batchId: 'batch-1',
      insertedEntities: 0,
      insertedLinks: 0,
      skipped: 0,
      insertedEntityIds: [],
      insertedLinkIds: [],
      skippedRecordIds: [],
      unresolvedLinks: [],
      errors: [],
    })),
  };
});

describe('LIMS conventional importer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryLimsEntities).mockResolvedValue([]);
  });

  it('parses DNA and RNA oligo order text with entity-specific chemistry', async () => {
    const dna = await createLimsImportPlan({
      fileName: 'dna-oligos.csv',
      text: 'Name,Sequence\nDNA import,/5Phos/acGTacGTac',
      forcedKind: 'oligo',
    });
    expect(dna.records[0]).toMatchObject({ accepted: true, errors: [] });
    expect(dna.records[0].entityDraft.fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'acGTacGTac',
    });

    const rnaNotation = '/5Phos/rarCrgrUrarCrgrUrarC';
    const rna = await createLimsImportPlan({
      fileName: 'rna-oligos.csv',
      text: `Name,Sequence\nRNA import,${rnaNotation}`,
      forcedKind: 'rna_oligo',
    });
    expect(rna.records[0]).toMatchObject({ accepted: true, errors: [] });
    expect(rna.records[0].entityDraft.fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'aCgUaCgUaC',
    });
    expect(rna.records[0].source.Sequence).toBe(rnaNotation);
  });

  it('imports spreadsheet proteins with protein semantics instead of DNA validation', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'proteins.csv',
      text: 'Name,Sequence,Organism,Source CDS\nProtein one,msk x*,E. coli,b0001',
      forcedKind: 'protein',
    });

    expect(plan.records).toHaveLength(1);
    expect(plan.records[0]).toMatchObject({ accepted: true, errors: [] });
    expect(plan.records[0].entityDraft.fields.sequence).toMatchObject({
      mode: 'inline',
      aminoAcids: 'MSKX*',
      length: 5,
    });
    expect(plan.records[0].entityDraft.fields.sequence).not.toHaveProperty('bases');
    expect(plan.records[0].entityDraft.fields).toMatchObject({
      organism: 'E. coli',
      sourceCds: 'b0001',
    });
    expect(plan.records[0].entityDraft.fields).not.toHaveProperty('organismName');
  });

  it('rejects unsupported protein residues through the shared protein validator', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'proteins.csv',
      text: 'Name,Sequence\nInvalid protein,MSKZ',
      forcedKind: 'protein',
    });

    expect(plan.records[0].accepted).toBe(false);
    expect(plan.records[0].errors.join(' ')).toMatch(/one-letter amino-acid/i);
    expect(plan.records[0].entityDraft.fields.sequence).toEqual({ mode: 'unresolved' });
  });

  it('uses portable protein sequence identity for same-import and existing-entity warnings', async () => {
    vi.mocked(queryLimsEntities).mockResolvedValue([
      {
        id: 'existing-protein',
        kind: 'protein',
        name: 'Existing protein',
        fields: { sequence: { mode: 'inline', aminoAcids: 'MSKX*', length: 5 } },
      } as LimsEntity,
    ]);
    const plan = await createLimsImportPlan({
      fileName: 'proteins.csv',
      text: ['Name,Sequence', 'Imported one,MSKX*', 'Imported twice,MSKX*'].join('\n'),
      forcedKind: 'protein',
    });

    expect(plan.records[0].accepted).toBe(true);
    expect(plan.records[0].warnings.join(' ')).toMatch(/already has this sequence/i);
    expect(plan.records[1].accepted).toBe(false);
    expect(plan.records[1].duplicateCandidates[0]?.reason).toMatch(/same inline sequence/i);
  });

  it('imports every protein in a multi-record FASTA without collapsing the source', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'proteome.faa',
      text: ['>alpha first protein', 'MSKX*', '>beta second protein', 'WQH'].join('\n'),
      forcedKind: 'protein',
    });

    expect(preview.recordCount).toBe(2);
    expect(preview.records).toHaveLength(2);
    expect(preview.records.map((record) => record.entity.name)).toEqual(['alpha', 'beta']);
    expect(preview.records.map((record) => record.entity.fields.sequence)).toEqual([
      expect.objectContaining({ mode: 'inline', aminoAcids: 'MSKX*' }),
      expect.objectContaining({ mode: 'inline', aminoAcids: 'WQH' }),
    ]);
    expect(preview.records.map((record) => record.entity.fields.notes)).toEqual([
      'first protein',
      'second protein',
    ]);
    expect(preview.records.every((record) => record.accepted)).toBe(true);
  });

  it('rejects GenBank passed through the protein import door', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const preview = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      sourcePath: fixturePath,
      text: readFileSync(fixturePath, 'utf8'),
      forcedKind: 'protein',
    });

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0].accepted).toBe(false);
    expect(preview.records[0].errors?.join(' ')).toMatch(/GenBank is a nucleic-acid format/i);
  });

  it('rejects U in DNA oligos and DNA-only vendor chemistry in RNA oligos', async () => {
    const dnaWithU = await createLimsImportPlan({
      fileName: 'dna-oligos.csv',
      text: 'Name,Sequence\nWrong DNA,ACGUACGUAC',
      forcedKind: 'oligo',
    });
    expect(dnaWithU.records[0].accepted).toBe(false);
    expect(dnaWithU.records[0].errors.join(' ')).toMatch(/invalid natural primer base U/i);

    const rnaWithDnaOnlyModification = await createLimsImportPlan({
      fileName: 'rna-oligos.csv',
      text: 'Name,Sequence\nWrong RNA,/55HydMe-dC/rArCrGrUrArCrGrUrArC',
      forcedKind: 'rna_oligo',
    });
    expect(rnaWithDnaOnlyModification.records[0].accepted).toBe(false);
    expect(rnaWithDnaOnlyModification.records[0].errors.join(' ')).toMatch(
      /not available for IDT RNA oligos/i
    );
  });

  it('maps primer CSV fields and preserves direction on neutral association payload', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'primers.csv',
      text: [
        'Name,Sequence,Description,Target,Direction',
        'M13-Reverse,CAGGAAACAGCTATGAC,Standard reverse primer,pUC19,Reverse',
      ].join('\n'),
    });

    expect(preview.records).toHaveLength(1);
    const record = preview.records[0];
    expect(record.entity.kind).toBe('oligo');
    expect(record.entity.fields).toMatchObject({
      notes: 'Standard reverse primer',
    });
    expect(record.entity.fields).not.toHaveProperty('direction');
    expect(record.links?.[0]).toMatchObject({
      type: 'associated_with',
      toEntityLookup: { kind: 'plasmid', name: 'pUC19' },
      payload: { orientation: 'reverse', role: 'intended_target' },
    });
    expect(preview.oracle.ok).toBe(true);
  });

  it('imports a DNA sequence whose sequence is too long to resolve inline, flagged (not blocked)', async () => {
    const tooLong = 'A'.repeat(50_001);
    const preview = await dryRunLimsImport({
      fileName: 'plasmids.csv',
      defaultKind: 'sequence',
      text: ['Name,Sequence', `Giant plasmid,${tooLong}`].join('\n'),
    });
    expect(preview.records).toHaveLength(1);
    const record = preview.records[0];
    expect(record.entity.kind).toBe('sequence');
    expect(record.accepted).toBe(true);
    expect(record.errors ?? []).toHaveLength(0);
  });

  it('lets preview records be accepted or rejected before apply', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'primers.csv',
      text: ['Name,Sequence', 'A,GTAAAACGACGGCCAGT'].join('\n'),
    });

    const rejected = setImportRecordAccepted(preview, preview.records[0].id, false);
    expect(rejected.records[0].accepted).toBe(false);
  });

  it('parses primer Excel workbooks through the conventional importer', async () => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'Sequence', 'Target', 'Direction'],
      ['Fwd-1', 'GTAAAACGACGGCCAGT', 'pUC19', 'Forward'],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Primers');
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as
      | ArrayBuffer
      | Uint8Array;

    const preview = await dryRunLimsImport({
      fileName: 'primers.xlsx',
      arrayBuffer: toArrayBuffer(bytes),
    });

    expect(preview.sourceKind).toBe('xlsx');
    expect(preview.columns).toEqual(['Name', 'Sequence', 'Target', 'Direction']);
    expect(preview.records).toHaveLength(1);
    expect(preview.records[0].entity.fields).not.toHaveProperty('use');
    expect(preview.records[0].links?.[0]).toMatchObject({
      type: 'associated_with',
      payload: { orientation: 'forward', role: 'intended_target' },
    });
    expect(preview.oracle.ok).toBe(true);
  });

  it('infers a headerless primer CSV without dropping the first row', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'primers-no-headers.csv',
      text: [
        'M13-Forward,GTAAAACGACGGCCAGT,Standard M13 forward primer',
        'M13-Reverse,CAGGAAACAGCTATGAC,Standard M13 reverse primer',
      ].join('\n'),
      defaultKind: 'oligo',
    });

    expect(preview.columns).toEqual(['Name', 'Sequence', 'Notes']);
    expect(preview.warnings).toContain('No header row detected; inferred primer table columns.');
    expect(preview.records.map((record) => record.sourceRow)).toEqual([1, 2]);
    expect(preview.records.map((record) => record.entity.name)).toEqual([
      'M13-Forward',
      'M13-Reverse',
    ]);
    expect(preview.records[0].entity.fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'GTAAAACGACGGCCAGT',
      length: 17,
    });
    expect(preview.records[0].entity.fields.notes).toBe('Standard M13 forward primer');
    expect(preview.oracle.ok).toBe(true);
  });

  it('infers a raw two-column headerless primer TSV', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'primers.tsv',
      text: [
        'M13uni_F\tGTAAAACGACGGCCAGTACGTTGTAAAACG',
        'M13uni_R\tCAGGAAACAGCTATGACCATGATTACGCC',
      ].join('\n'),
      defaultKind: 'oligo',
    });

    expect(preview.sourceKind).toBe('tsv');
    expect(preview.columns).toEqual(['Name', 'Sequence']);
    expect(preview.records.map((record) => record.entity.name)).toEqual(['M13uni_F', 'M13uni_R']);
    expect(preview.records[0].entity.fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'GTAAAACGACGGCCAGTACGTTGTAAAACG',
    });
    expect(preview.oracle.ok).toBe(true);
  });

  it('infers a headerless plate workbook with well, name, and sequence columns', async () => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['A1', 'M13uni_F', 'GTAAAACGACGGCCAGTACGTTGTAAAACG'],
      ['A6', 'M13uni_R', 'CAGGAAACAGCTATGACCATGATTACGCC'],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as
      | ArrayBuffer
      | Uint8Array;

    const preview = await dryRunLimsImport({
      fileName: 'plate1_forward_primers.xlsx',
      arrayBuffer: toArrayBuffer(bytes),
      defaultKind: 'oligo',
    });

    expect(preview.columns).toEqual(['Well', 'Name', 'Sequence']);
    expect(preview.records.map((record) => record.entity.name)).toEqual(['M13uni_F', 'M13uni_R']);
    expect(preview.records[0].source).toMatchObject({ Well: 'A1' });
    expect(preview.records[0].entity.fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'GTAAAACGACGGCCAGTACGTTGTAAAACG',
    });
    expect(preview.oracle.ok).toBe(true);
  });

  it('maps the Benchling primer export COLUMN SHAPE without preformatting', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'benchling-style-primers.csv',
      text: [
        [
          'Registry ID 1',
          'Registry ID 2',
          'Name',
          'Author',
          'Alias',
          'Sequence',
          'Link',
          'Purpose',
          'Use(s)',
          'Sequence with mods (optional)',
          'Location',
          'Target',
          'Gene',
          'Reference',
          'Source/date',
          'Tm',
        ].join(','),
        ['demo-1', 'demo-1b', 'M13uni_F', 'demo', '', 'GTAAAACGACGGCCAGTACGTTGTAAAACG'].join(','),
        ['demo-2', 'demo-2b', 'M13uni_R', 'demo', '', 'CAGGAAACAGCTATGACCATGATTACGCC'].join(','),
      ].join('\n'),
      defaultKind: 'oligo',
    });

    expect(preview.columns).toEqual(
      expect.arrayContaining(['Registry ID 1', 'Registry ID 2', 'Name', 'Sequence'])
    );
    expect(preview.records).toHaveLength(2);
    expect(preview.records[0].entity.name).toBe('M13uni_F');
    expect(preview.records[0].entity.fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'GTAAAACGACGGCCAGTACGTTGTAAAACG',
    });
    expect(preview.records[1].entity.name).toBe('M13uni_R');
    expect(preview.oracle.ok).toBe(true);
  });

  it('classifies dropped sequence content as a DNA sequence without inventing a subtype', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const preview = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      text: readFileSync(fixturePath, 'utf8'),
    });

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      accepted: true,
      requiresRegistrationKind: false,
      entity: {
        kind: 'sequence',
        fields: { sequence: { mode: 'unresolved' } },
        registrationStatus: 'unresolved',
      },
    });
    expect(preview.records[0].suggestedKind).toBeUndefined();
    expect(preview.records[0].kindEvidence).toBeUndefined();
    expect(preview.records[0].errors ?? []).toHaveLength(0);
    expect(preview.oracle.ok).toBe(true);
  });

  it('keeps a durable sequence path while retaining the base DNA sequence type', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const preview = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      sourcePath: fixturePath,
      text: readFileSync(fixturePath, 'utf8'),
    });

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      accepted: true,
      requiresRegistrationKind: false,
      entity: { kind: 'sequence' },
    });
    expect(preview.records[0].entity.fields.sequence).toMatchObject({
      mode: 'file',
      relPath: fixturePath,
      topology: 'circular',
    });
    expect(preview.oracle.ok).toBe(true);
  });

  it('does not turn linear topology into a chromosome or genome import type', async () => {
    const fixturePath = join(
      __dirname,
      '../../../../../test-fixtures/sequences/linear/ecoli-mg1655-region.gb'
    );
    const preview = await dryRunLimsImport({
      fileName: 'ecoli-mg1655-region.gb',
      sourcePath: fixturePath,
      text: readFileSync(fixturePath, 'utf8'),
    });

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      accepted: true,
      requiresRegistrationKind: false,
      entity: {
        kind: 'sequence',
        fields: {
          sequence: {
            mode: 'file',
            relPath: fixturePath,
            topology: 'linear',
          },
        },
      },
    });
    expect(preview.records[0].errors ?? []).toHaveLength(0);
    expect(preview.records[0].suggestedKind).toBeUndefined();
    expect(preview.records[0].kindEvidence).toBeUndefined();
  });

  it('does not turn a complete-genome description into a separate import type', async () => {
    const chromosomeGenBank = [
      'LOCUS       SYNTH_CHR                120 bp    DNA     linear   BCT 20-JUL-2026',
      'DEFINITION  Synthetic organism strain X, complete genome.',
      'ACCESSION   SYNTH_CHR',
      'FEATURES             Location/Qualifiers',
      '     source          1..120',
      '                     /organism="synthetic construct"',
      'ORIGIN',
      '        1 atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc',
      '       61 atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc',
      '//',
      '',
    ].join('\n');
    const preview = await dryRunLimsImport({ fileName: 'synth-chr.gb', text: chromosomeGenBank });

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      accepted: true,
      requiresRegistrationKind: false,
      entity: { kind: 'sequence' },
    });
    expect(preview.records[0].suggestedKind).toBeUndefined();
    expect(preview.records[0].errors ?? []).toHaveLength(0);
    expect(preview.oracle.ok).toBe(true);
  });

  it('materializes the base sequence type directly into the import plan', async () => {
    const fixturePath = join(
      __dirname,
      '../../../../../test-fixtures/sequences/linear/ecoli-mg1655-region.gb'
    );
    const plan = await createLimsImportPlan({
      fileName: 'ecoli-mg1655-region.gb',
      sourcePath: fixturePath,
      text: readFileSync(fixturePath, 'utf8'),
    });

    expect(plan.canApply).toBe(true);
    expect(plan.records[0]).toMatchObject({
      accepted: true,
      requiresRegistrationKind: false,
      entityDraft: {
        kind: 'sequence',
        fields: {
          sequence: {
            mode: 'file',
            relPath: fixturePath,
            topology: 'linear',
          },
        },
      },
      errors: [],
    });
  });

  it('a forced sequence type needs no per-row type choice', async () => {
    const fixturePath = join(
      __dirname,
      '../../../../../test-fixtures/sequences/linear/ecoli-mg1655-region.gb'
    );
    const plan = await createLimsImportPlan({
      fileName: 'ecoli-mg1655-region.gb',
      sourcePath: fixturePath,
      text: readFileSync(fixturePath, 'utf8'),
      forcedKind: 'sequence',
    });

    expect(plan.canApply).toBe(true);
    expect(plan.records[0]).toMatchObject({
      accepted: true,
      requiresRegistrationKind: false,
      entityDraft: { kind: 'sequence' },
      errors: [],
    });
  });

  it('rejects sequence-file registration kinds that are not sequence-compatible', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const preview = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      sourcePath: fixturePath,
      defaultKind: 'oligo',
      text: readFileSync(fixturePath, 'utf8'),
    });

    expect(preview.records[0]).toMatchObject({
      accepted: false,
      requiresRegistrationKind: false,
      entity: { kind: 'sequence' },
    });
    expect(preview.records[0].errors?.join('\n')).toMatch(
      /Sequence files must be imported as DNA sequences/
    );
    expect(preview.oracle.ok).toBe(false);
  });

  it('a wrong-door sequence record stays blocked even if a sequence choice is forced through', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const plan = await createLimsImportPlan({
      fileName: 'pUC19.gb',
      sourcePath: fixturePath,
      defaultKind: 'oligo',
      text: readFileSync(fixturePath, 'utf8'),
    });
    expect(plan.canApply).toBe(false);
    expect(plan.records[0].errors.join('\n')).toMatch(/must be imported as DNA sequences/i);

    const afterPick = await applyImportPlanRecordKind(plan, plan.records[0].id, 'sequence');
    expect(afterPick.records[0].errors.join('\n')).toMatch(/must be imported as DNA sequences/i);
    expect(afterPick.records[0].accepted).toBe(false);
    expect(afterPick.canApply).toBe(false);
  });

  it('an IGNORED column is dropped from the record — not mapped, not kept as source metadata', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: ['Name,Sequence,Freezer Box', 'OL-a,ACGTACGTACGT,Box A'].join('\n'),
      forcedKind: 'oligo',
      columnMappings: [
        { sourceColumn: 'Freezer Box', mappingMode: 'ignored', confidence: 'user_overridden' },
      ],
    });
    expect(plan.columns.find((c) => c.sourceColumn === 'Freezer Box')?.mappingMode).toBe('ignored');
    expect(plan.records[0].source).not.toHaveProperty('Freezer Box');
    expect(plan.records[0].source).toHaveProperty('Name');
  });

  it('uses a durable source path for sequence-file imports when an explicit kind is chosen', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const preview = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      sourcePath: fixturePath,
      defaultKind: 'sequence',
      text: readFileSync(fixturePath, 'utf8'),
    });

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      accepted: true,
      entity: {
        kind: 'sequence',
        fields: {
          sequence: {
            mode: 'file',
            relPath: fixturePath,
            topology: 'circular',
            length: 2686,
            sourceFormat: 'gb',
            contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            fileContentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            normalizedSequenceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          },
        },
        registrationStatus: 'registered',
      },
    });
    const sequence = preview.records[0].entity.fields.sequence as {
      contentHash?: string;
      fileContentHash?: string;
      normalizedSequenceHash?: string;
    };
    expect(sequence.fileContentHash).toBe(sequence.contentHash);
    expect(sequence.normalizedSequenceHash).not.toBe(sequence.fileContentHash);
    expect(preview.oracle.ok).toBe(true);
  });

  it('WARNS on a normalized-sequence match but still imports it : matches warn, never block)', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const text = readFileSync(fixturePath, 'utf8');
    const baseline = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      sourcePath: fixturePath,
      defaultKind: 'sequence',
      text,
    });
    const sequence = baseline.records[0].entity.fields.sequence as {
      normalizedSequenceHash?: string;
    };
    expect(sequence.normalizedSequenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    vi.mocked(queryLimsEntities).mockResolvedValue([
      existingEntity('plasmid-same-sequence', 'plasmid', 'Different registered plasmid', {
        sequence: {
          mode: 'file',
          relPath: '/registered/different-name.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          fileContentHash:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          normalizedSequenceHash: sequence.normalizedSequenceHash,
          sourceFormat: 'gb',
        },
      }),
    ]);

    const duplicatePreview = await dryRunLimsImport({
      fileName: 'pUC19-renamed.gb',
      sourcePath: fixturePath,
      defaultKind: 'sequence',
      text,
    });

    expect(duplicatePreview.records[0].accepted).toBe(true);
    expect(duplicatePreview.records[0].duplicateOf).toBeUndefined();
    expect(duplicatePreview.records[0].warnings?.join(' ')).toMatch(/already has this sequence/i);
  });

  it('classifies an exact source-record reimport before a normalized-sequence warning', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const text = readFileSync(fixturePath, 'utf8');
    const baseline = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      sourcePath: fixturePath,
      defaultKind: 'sequence',
      text,
    });
    const sequence = baseline.records[0].entity.fields.sequence as {
      normalizedSequenceHash: string;
    };
    const source = baseline.records[0].source as {
      fileContentHash: string;
      recordCount: number;
    };
    vi.mocked(queryLimsEntities).mockResolvedValue([
      existingEntity('same-original-source', 'plasmid', 'Managed pUC19', {
        sequence: {
          mode: 'file',
          relPath: '/managed/pUC19.gb',
          fileContentHash: `sha256:${'a'.repeat(64)}`,
          normalizedSequenceHash: sequence.normalizedSequenceHash,
        },
        sourceMetadata: {
          origin: { type: 'file_import', sourceName: 'pUC19.gb' },
          values: {
            sourceFileContentHash: source.fileContentHash,
            sourceRecordIndex: 0,
            sourceRecordCount: source.recordCount,
          },
        },
      }),
    ]);

    const preview = await dryRunLimsImport({
      fileName: 'pUC19-renamed.gb',
      sourcePath: fixturePath,
      defaultKind: 'sequence',
      text,
    });

    expect(preview.records[0]).toMatchObject({
      accepted: false,
      duplicateOf: 'same-original-source',
    });
    expect(preview.records[0].duplicateReason).toMatch(/original source-file record/i);
    expect(preview.records[0].warnings?.join(' ') ?? '').not.toMatch(/already has this sequence/i);
  });

  it('detects a DROPPED (pathless) sequence as an identity duplicate via its content hash ', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const text = readFileSync(fixturePath, 'utf8');

    const baseline = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      defaultKind: 'sequence',
      text,
    });
    expect((baseline.records[0].entity.fields.sequence as { mode?: string }).mode).toBe(
      'unresolved'
    );
    const source = baseline.records[0].source as { fileContentHash?: string };
    expect(source.fileContentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    vi.mocked(queryLimsEntities).mockResolvedValue([
      existingEntity('plasmid-registered', 'plasmid', 'pUC19', {
        sequence: {
          mode: 'file',
          relPath: '/managed/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: source.fileContentHash,
          fileContentHash: source.fileContentHash,
          normalizedSequenceHash: `sha256:${'b'.repeat(64)}`,
          sourceFormat: 'gb',
        },
      }),
    ]);

    const dropped = await dryRunLimsImport({ fileName: 'pUC19.gb', defaultKind: 'sequence', text });
    expect(dropped.records[0]).toMatchObject({
      accepted: false,
      duplicateOf: 'plasmid-registered',
      duplicateName: 'pUC19',
    });
    expect(dropped.records[0].duplicateReason).toMatch(/file-byte hash/i);
    expect(dropped.records[0].entity.name).not.toMatch(/\(\d+\)/);
  });

  it('honors GenBank CONTENT even when the file has a .fasta extension (real-corpus data loss)', async () => {
    const genbankText = readFileSync(
      join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb'),
      'utf8'
    );
    const plan = await createLimsImportPlan({
      fileName: 'Data_Sheet_2.FASTA',
      text: genbankText,
      defaultKind: 'sequence',
    });
    expect(plan.detectedKind).toBe('sequence_file');
    expect(plan.records).toHaveLength(1);
    expect(plan.records[0].accepted).toBe(true);
    expect(JSON.stringify(plan.records[0].errors ?? [])).not.toMatch(
      /invalid sequence characters/i
    );
  });

  it('preserves BOTH columns when headers collide (case-variant duplicate) — no silent drop', async () => {
    const csv = ['Name,Well position,Well Position', 'oPNC1,A1,PlateHigh'].join('\n');
    const plan = await createLimsImportPlan({
      fileName: 'primers.csv',
      text: csv,
      forcedKind: 'oligo',
    });
    const values = Object.values(plan.records[0].source);
    expect(values).toContain('A1');
    expect(values).toContain('PlateHigh');
  });

  it('preserves trailing cells of a RAGGED row wider than the header (no silent drop)', async () => {
    const csv = ['Name,A,B', 'oPNC1,x,y,extra1,extra2'].join('\n');
    const plan = await createLimsImportPlan({
      fileName: 'ragged.csv',
      text: csv,
      forcedKind: 'oligo',
    });
    const values = Object.values(plan.records[0].source);
    expect(values).toContain('extra1');
    expect(values).toContain('extra2');
  });

  it('detects a SEMICOLON-delimited .csv instead of collapsing it to one truncated column', async () => {
    const csv = ['Name;Value;Note', 'oPNC1;151,14;ok'].join('\n');
    const plan = await createLimsImportPlan({
      fileName: 'euro.csv',
      text: csv,
      forcedKind: 'oligo',
    });
    const source = plan.records[0].source;
    expect(Object.keys(source).length).toBeGreaterThanOrEqual(3);
    expect(Object.values(source)).toContain('151,14');
  });

  it('produces an explicit primer-table import plan and warns on optional unresolved targets', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'primers.csv',
      text: [
        'Name,Sequence,Description,Target,Direction',
        'M13-Reverse,CAGGAAACAGCTATGAC,Standard reverse primer,pUC19,Reverse',
      ].join('\n'),
    });

    expect(plan.detectedKind).toBe('primer_table');
    expect(plan.canApply).toBe(true);
    expect(plan.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceColumn: 'Target',
          mappedField: 'links.associated_with.target',
          confidence: 'deterministic',
        }),
        expect.objectContaining({
          sourceColumn: 'Direction',
          mappedField: 'links.associated_with.orientation',
          confidence: 'deterministic',
        }),
      ])
    );
    expect(plan.records[0]).toMatchObject({
      id: 'row-2',
      action: 'create',
      accepted: true,
      entityDraft: {
        kind: 'oligo',
        name: 'M13-Reverse',
      },
      proposedLinks: [
        {
          type: 'associated_with',
          toEntityLookup: { kind: 'plasmid', name: 'pUC19' },
          payload: { orientation: 'reverse', role: 'intended_target' },
        },
      ],
      unresolvedLinks: [
        {
          label: 'pUC19',
          kind: 'plasmid',
          type: 'associated_with',
          severity: 'advisory',
          reason: 'No exact registry match for associated target.',
        },
      ],
    });

    await applyAcceptedLimsImportPlan(plan);

    expect(vi.mocked(applyLimsImportBatch)).toHaveBeenCalledWith(
      expect.objectContaining({
        records: [
          expect.objectContaining({
            id: 'row-2',
            accepted: true,
            links: [],
            unresolvedLinks: [
              expect.objectContaining({
                label: 'pUC19',
                type: 'associated_with',
                severity: 'advisory',
              }),
            ],
            errors: undefined,
          }),
        ],
      }),
      undefined
    );
  });

  it('forces the wizard-chosen kind over content inference, and keeps it across a re-map', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'mystery.csv',
      text: ['Name,Sequence', 'thing-1,ACGTACGT'].join('\n'),
      forcedKind: 'strain',
    });
    expect(plan.forcedKind).toBe('strain');
    expect(plan.detectedKind).toBe('strain_table');
    expect(plan.records.every((record) => record.entityDraft.kind === 'strain')).toBe(true);

    const remapped = await applyImportPlanColumnMappings(plan, [
      { sourceColumn: 'Sequence', mappedField: 'fields.notes', mappingMode: 'mapped' },
    ]);
    expect(remapped.forcedKind).toBe('strain');
    expect(remapped.records.every((record) => record.entityDraft.kind === 'strain')).toBe(true);
  });

  it('errors a record whose value cannot go in the schema (bad enum) — good rows still import', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: [
        'Name,Sequence,Status',
        'GoodOligo,ACGTACGT,ordered',
        'BadOligo,ACGTACGT,not-a-real-status',
      ].join('\n'),
      forcedKind: 'oligo',
      columnMappings: [
        { sourceColumn: 'Status', mappedField: 'fields.status', mappingMode: 'mapped' },
      ],
    });
    const good = plan.records.find((record) => record.entityDraft.name === 'GoodOligo')!;
    const bad = plan.records.find((record) => record.entityDraft.name === 'BadOligo')!;

    expect(bad.errors.join(' ')).toMatch(/status must be one of/i);
    expect(bad.accepted).toBe(false);
    expect(good.errors).toHaveLength(0);
    expect(good.accepted).toBe(true);
  });

  it('rejects an out-of-enum value on a second column too (use), per-record', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: ['Name,Sequence,Use', 'X,ACGT,not-a-use'].join('\n'),
      forcedKind: 'oligo',
      columnMappings: [{ sourceColumn: 'Use', mappedField: 'fields.use', mappingMode: 'mapped' }],
    });
    const record = plan.records[0];
    expect(record.errors.join(' ')).toMatch(/use must be one of/i);
    expect(record.accepted).toBe(false);
  });

  it('stores EVERY mapped schema field, not a hardcoded subset (Source/Species/Markers now land)', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'strains.csv',
      text: [
        'Strain,Genotype,Species,Source,Markers',
        'S1,MATa,Escherichia coli,ATCC 12345,ampR;kanR',
      ].join('\n'),
      forcedKind: 'strain',
      columnMappings: [
        { sourceColumn: 'Species', mappedField: 'fields.species', mappingMode: 'mapped' },
        { sourceColumn: 'Source', mappedField: 'fields.source', mappingMode: 'mapped' },
        { sourceColumn: 'Markers', mappedField: 'fields.markers', mappingMode: 'mapped' },
      ],
    });
    expect(plan.records[0].entityDraft.fields).toMatchObject({
      genotypeCanonical: 'MATa',
      species: 'Escherichia coli',
      source: 'ATCC 12345',
      markers: ['ampR', 'kanR'],
    });
    expect(plan.records[0].accepted).toBe(true);
  });

  it('a carried_by reference to a not-yet-imported plasmid HANGS — it does not block the import', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'strains.csv',
      text: ['Name,Genotype,Plasmid Carried', 'S1,MATa,pUC19', 'S2,MATalpha,'].join('\n'),
      forcedKind: 'strain',
    });
    expect(plan.canApply).toBe(true);
    const s1 = plan.records.find((record) => record.entityDraft.name === 'S1')!;
    expect(s1.accepted).toBe(true);
    expect(s1.errors).toHaveLength(0);
    expect(
      s1.unresolvedLinks.some((l) => l.type === 'carried_by' && l.severity === 'advisory')
    ).toBe(true);
  });

  it('rematerializes import records from explicit table-to-schema column mappings', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'weird-primer-export.csv',
      text: [
        'Primer Label,Bases,Comment,Template Bottle,Polarity,Notebook Only',
        'Mapped Primer,GTAAAACGACGGCCAGT,manual mapping,pUC19,Forward,do not import',
      ].join('\n'),
      defaultKind: 'oligo',
    });

    expect(plan.canApply).toBe(false);
    expect(plan.records[0].accepted).toBe(false);
    expect(plan.records[0].errors).toEqual(['Missing name']);
    expect(plan.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceColumn: 'Primer Label', mappingMode: 'source_only' }),
        expect.objectContaining({ sourceColumn: 'Bases', mappingMode: 'source_only' }),
      ])
    );

    const remapped = await applyImportPlanColumnMappings(plan, [
      { sourceColumn: 'Primer Label', mappedField: 'entity.name', mappingMode: 'mapped' },
      { sourceColumn: 'Bases', mappedField: 'fields.sequence', mappingMode: 'mapped' },
      { sourceColumn: 'Comment', mappedField: 'fields.notes', mappingMode: 'mapped' },
      {
        sourceColumn: 'Template Bottle',
        mappedField: 'links.associated_with.target',
        mappingMode: 'mapped',
      },
      {
        sourceColumn: 'Polarity',
        mappedField: 'links.associated_with.orientation',
        mappingMode: 'mapped',
      },
      { sourceColumn: 'Notebook Only', mappingMode: 'source_only' },
    ]);

    expect(remapped.canApply).toBe(true);
    expect(remapped.detectedKind).toBe('primer_table');
    expect(remapped.records[0]).toMatchObject({
      accepted: true,
      entityDraft: {
        kind: 'oligo',
        name: 'Mapped Primer',
        fields: {
          notes: 'manual mapping',
          sequence: {
            mode: 'inline',
            bases: 'GTAAAACGACGGCCAGT',
            length: 17,
          },
        },
      },
      proposedLinks: [
        {
          type: 'associated_with',
          toEntityLookup: { kind: 'plasmid', name: 'pUC19' },
          payload: {
            role: 'intended_target',
            orientation: 'forward',
            sourceColumn: 'Template Bottle',
          },
        },
      ],
      errors: [],
      source: expect.objectContaining({
        'Primer Label': 'Mapped Primer',
        Bases: 'GTAAAACGACGGCCAGT',
        'Notebook Only': 'do not import',
      }),
    });
    expect(remapped.oracle.ok).toBe(true);
  });

  it('describes import plans for agent-assisted mapping without accepting unknown targets', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'weird-primer-export.csv',
      text: [
        'Primer Label,Bases,Notebook Only',
        'Mapped Primer,GTAAAACGACGGCCAGT,agent-visible provenance',
      ].join('\n'),
      defaultKind: 'oligo',
    });

    const context = describeLimsImportPlanForAgent(plan);
    expect(context.columns).toContainEqual(
      expect.objectContaining({
        sourceColumn: 'Bases',
        mappingMode: 'source_only',
        sampleValues: ['GTAAAACGACGGCCAGT'],
      })
    );
    expect(context.targetOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'fields.sequence' })])
    );

    const remapped = await applyImportPlanColumnMappings(plan, [
      { sourceColumn: 'Primer Label', mappedField: 'entity.name', mappingMode: 'mapped' },
      { sourceColumn: 'Bases', mappedField: 'fields.sequenceTypo', mappingMode: 'mapped' },
    ]);

    expect(remapped.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceColumn: 'Bases',
          mappedField: undefined,
          mappingMode: 'source_only',
          warnings: ['Unsupported mapping target "fields.sequenceTypo" was ignored.'],
        }),
      ])
    );
    expect(remapped.canApply).toBe(true);
    expect(remapped.records[0].accepted).toBe(true);
    expect(remapped.records[0].errors ?? []).toEqual([]);
  });

  it('blocks unresolved strain evidence links because they are required evidence references', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'strains.csv',
      text: [
        'Name,Genotype,Parent Genome,Supplied Hypothesis Genome,Verified WGS Genome',
        'Demo strain,argFΔ,Missing parent,Missing hypothesis,Missing WGS',
      ].join('\n'),
    });

    expect(plan.detectedKind).toBe('strain_table');
    expect(plan.canApply).toBe(false);
    expect(plan.records[0].unresolvedLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Missing parent',
          kind: 'genome',
          type: 'references',
          severity: 'blocking',
        }),
        expect.objectContaining({
          label: 'Missing hypothesis',
          kind: 'genome',
          type: 'has_genome',
          severity: 'blocking',
        }),
        expect.objectContaining({
          label: 'Missing WGS',
          kind: 'genome',
          type: 'has_genome',
          severity: 'blocking',
        }),
      ])
    );
  });

  it('resolves primer targets in the import plan before converting to the batch primitive', async () => {
    vi.mocked(queryLimsEntities).mockImplementation(async (input = {}) => {
      if (input.kind === 'plasmid') return [existingEntity('plasmid-puc19', 'plasmid', 'pUC19')];
      return [];
    });

    const plan = await createLimsImportPlan({
      fileName: 'primers.csv',
      text: [
        'Name,Sequence,Description,Target,Direction',
        'M13-Forward,GTAAAACGACGGCCAGT,Standard forward primer,pUC19,Forward',
      ].join('\n'),
    });

    expect(plan.canApply).toBe(true);
    expect(plan.records[0].proposedLinks[0]).toMatchObject({
      type: 'associated_with',
      toEntityId: 'plasmid-puc19',
    });

    await applyAcceptedLimsImportPlan(plan);

    expect(vi.mocked(applyLimsImportBatch)).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'csv',
        records: [
          expect.objectContaining({
            id: 'row-2',
            action: 'register_entity',
            accepted: true,
            entity: expect.objectContaining({ kind: 'oligo', name: 'M13-Forward' }),
            links: [
              expect.objectContaining({
                type: 'associated_with',
                toEntityId: 'plasmid-puc19',
                payload: expect.objectContaining({
                  orientation: 'forward',
                  role: 'intended_target',
                }),
              }),
            ],
          }),
        ],
      }),
      undefined
    );
  });

  it('maps strain-table evidence columns into deterministic import-plan links', async () => {
    vi.mocked(queryLimsEntities).mockImplementation(async (input = {}) => {
      const fixtures = [
        existingEntity('genome-parent', 'genome', 'MG1655 parent region'),
        existingEntity('genome-hypothesis', 'genome', 'Demo supplied hypothesis'),
        existingEntity('genome-wgs', 'genome', 'Demo verified WGS'),
        existingEntity('plasmid-puc19', 'plasmid', 'pUC19'),
      ];
      return fixtures.filter((entity) => !input.kind || entity.kind === input.kind);
    });

    const plan = await createLimsImportPlan({
      fileName: 'strains.csv',
      text: [
        [
          'Name',
          'Genotype',
          'Organism',
          'Parent Genome',
          'Supplied Hypothesis Genome',
          'Verified WGS Genome',
          'Plasmid Carried',
        ].join(','),
        [
          'Demo strain',
          'argFΔ; g.1414A>T',
          'Escherichia coli K-12 MG1655',
          'MG1655 parent region',
          'Demo supplied hypothesis',
          'Demo verified WGS',
          'pUC19',
        ].join(','),
      ].join('\n'),
    });

    expect(plan.detectedKind).toBe('strain_table');
    expect(plan.canApply).toBe(true);
    expect(plan.records[0].entityDraft).toMatchObject({
      kind: 'strain',
      name: 'Demo strain',
      fields: {
        genotypeCanonical: 'argFΔ; g.1414A>T',
        organismName: 'Escherichia coli K-12 MG1655',
      },
    });
    expect(plan.records[0].proposedLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'references',
          toEntityId: 'genome-parent',
          payload: expect.objectContaining({ role: 'parent_genome' }),
        }),
        expect.objectContaining({
          type: 'has_genome',
          toEntityId: 'genome-hypothesis',
          payload: expect.objectContaining({ confidence: 'hypothesis_supplied' }),
        }),
        expect.objectContaining({
          type: 'has_genome',
          toEntityId: 'genome-wgs',
          payload: expect.objectContaining({ confidence: 'WGS_verified' }),
        }),
        expect.objectContaining({
          type: 'carried_by',
          fromEntityId: 'plasmid-puc19',
          payload: expect.objectContaining({ role: 'carried_plasmid' }),
        }),
      ])
    );
  });

  it('updates import-plan accept state without losing the explicit skip action', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'primers.csv',
      text: ['Name,Sequence', 'A,GTAAAACGACGGCCAGT'].join('\n'),
    });

    const rejected = setImportPlanRecordAccepted(plan, plan.records[0].id, false);

    expect(rejected.records[0]).toMatchObject({ accepted: false, action: 'skip' });
    expect(rejected.canApply).toBe(false);
  });

  it('inlines a short plasmid sequence pasted in a CSV instead of silently dropping it', async () => {
    const bases = 'ATGCGT'.repeat(20);
    const preview = await dryRunLimsImport({
      fileName: 'plasmids.csv',
      text: ['Name,Type,Sequence', `pMini,plasmid,${bases}`].join('\n'),
    });

    const record = preview.records[0];
    expect(record.entity.kind).toBe('plasmid');
    expect(record.entity.fields.sequence).toMatchObject({
      mode: 'inline',
      bases,
      length: bases.length,
    });
    expect(record.entity.registrationStatus).toBe('registered');
    expect(record.accepted).toBe(true);
    expect(record.warnings?.some((warning) => /topology/i.test(warning))).toBe(true);
  });

  it('leaves an over-ceiling genome sequence unresolved and warns instead of marking it registered', async () => {
    const bases = 'ACGT'.repeat(20000);
    const preview = await dryRunLimsImport({
      fileName: 'genomes.csv',
      text: ['Name,Type,Sequence', `bigGenome,genome,${bases}`].join('\n'),
    });

    const record = preview.records[0];
    expect(record.entity.kind).toBe('genome');
    expect(record.entity.fields.sequence).toEqual({ mode: 'unresolved' });
    expect(record.entity.registrationStatus).toBe('unresolved');
    expect(record.warnings?.some((warning) => /inline limit/i.test(warning))).toBe(true);
    expect(record.source).toMatchObject({ Sequence: bases });
  });

  it('keeps the name column when a headerless row has a leading empty cell', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'primers-leading-blank.csv',
      text: [',M13-Forward,GTAAAACGACGGCCAGT', ',M13-Reverse,CAGGAAACAGCTATGAC'].join('\n'),
      defaultKind: 'oligo',
    });

    expect(preview.records.map((record) => record.entity.name)).toEqual([
      'M13-Forward',
      'M13-Reverse',
    ]);
    expect(preview.records[0].entity.fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'GTAAAACGACGGCCAGT',
    });
    expect(preview.records.every((record) => !(record.errors ?? []).includes('Missing name'))).toBe(
      true
    );
  });

  it('keeps a quoted multiline field in one record instead of fabricating a phantom row', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'primers-multiline.csv',
      text: 'Name,Sequence,Notes\nP1,GTAAAACGACGGCCAGT,"line one\nline two"\nP2,CAGGAAACAGCTATGAC,ok',
    });

    expect(preview.records).toHaveLength(2);
    expect(preview.records.map((record) => record.entity.name)).toEqual(['P1', 'P2']);
    expect(preview.records[0].entity.fields.notes).toBe('line one\nline two');
  });

  it('flags a second identical row in the same import as an intra-batch duplicate', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'primers-dupe.csv',
      text: [
        'Name,Sequence',
        'M13-Forward,GTAAAACGACGGCCAGT',
        'M13-Forward,GTAAAACGACGGCCAGT',
      ].join('\n'),
    });

    expect(preview.records).toHaveLength(2);
    expect(preview.records[0].accepted).toBe(true);
    expect(preview.records[1]).toMatchObject({
      accepted: false,
      duplicateOf: preview.records[0].id,
    });
    expect(preview.records[1].duplicateReason).toMatch(
      /same name|same inline sequence|same exact oligo order notation/i
    );
  });

  it('keeps equal natural oligo bases when their exact order chemistry differs', async () => {
    const preview = await createLimsImportPlan({
      fileName: 'chemistry-twins.csv',
      text: ['Name,Sequence', 'unmodified,ACGTACGTAC', 'phosphorylated,/5Phos/ACGTACGTAC'].join(
        '\n'
      ),
      forcedKind: 'oligo',
    });

    expect(preview.records).toHaveLength(2);
    expect(preview.records.map((record) => record.accepted)).toEqual([true, true]);
    expect(preview.records.map((record) => record.entityDraft.fields.sequence)).toEqual([
      expect.objectContaining({ mode: 'inline', bases: 'ACGTACGTAC' }),
      expect.objectContaining({ mode: 'inline', bases: 'ACGTACGTAC' }),
    ]);
    expect(preview.records[1].duplicateOf).toBeUndefined();
  });

  it('uses only the mapped sequence column when distinguishing exact oligo chemistry', async () => {
    const preview = await createLimsImportPlan({
      fileName: 'chemistry-twins-with-helper.csv',
      text: [
        'Name,Natural,Order sequence',
        'unmodified,ACGTACGTAC,ACGTACGTAC',
        'phosphorylated,ACGTACGTAC,/5Phos/ACGTACGTAC',
      ].join('\n'),
      forcedKind: 'oligo',
      columnMappings: [
        { sourceColumn: 'Natural', mappingMode: 'source_only' },
        {
          sourceColumn: 'Order sequence',
          mappedField: 'fields.sequence',
          mappingMode: 'mapped',
        },
      ],
    });

    expect(preview.records.map((record) => record.accepted)).toEqual([true, true]);
    expect(preview.records[1].duplicateOf).toBeUndefined();
  });

  it('does not invent a primer use for a generic DNA or RNA oligo import', async () => {
    const dna = await createLimsImportPlan({
      fileName: 'dna-oligos.csv',
      text: 'Name,Sequence\nDNA oligo,ACGTACGTAC',
      forcedKind: 'oligo',
    });
    const rna = await createLimsImportPlan({
      fileName: 'rna-oligos.csv',
      text: 'Name,Sequence\nRNA oligo,rArCrGrUrArC',
      forcedKind: 'rna_oligo',
    });

    expect(dna.records[0].entityDraft.fields).not.toHaveProperty('use');
    expect(rna.records[0].entityDraft.fields).not.toHaveProperty('use');
  });

  it('records no strand for an unrecognized orientation, and maps reverse synonyms', async () => {
    const preview = await dryRunLimsImport({
      fileName: 'primers.csv',
      text: [
        'Name,Sequence,Target,Direction',
        'P-unknown,CAGGAAACAGCTATGAC,pUC19,sideways',
        'P-antisense,GTAAAACGACGGCCAGT,pUC19,antisense',
      ].join('\n'),
    });

    const unknown = preview.records.find((r) => r.entity.name === 'P-unknown');
    const antisense = preview.records.find((r) => r.entity.name === 'P-antisense');
    expect((unknown?.links?.[0]?.payload as { orientation?: unknown }).orientation).toBeNull();
    expect((antisense?.links?.[0]?.payload as { orientation?: unknown }).orientation).toBe(
      'reverse'
    );
  });

  it('demotes a second column mapping to the same field, with a warning (no silent drop)', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'primers.csv',
      text: ['Name,Primer Name,Sequence', 'Alpha,AlphaAgain,GTAAAACGACGGCCAGT'].join('\n'),
    });

    const nameCol = plan.columns.find((c) => c.sourceColumn === 'Name');
    const primerNameCol = plan.columns.find((c) => c.sourceColumn === 'Primer Name');
    expect(nameCol).toMatchObject({ mappedField: 'entity.name', mappingMode: 'mapped' });
    expect(primerNameCol?.mappingMode).toBe('source_only');
    expect(primerNameCol?.mappedField).toBeUndefined();
    expect(primerNameCol?.warnings.join(' ')).toMatch(/map to .* keeping "Name"/);
  });

  it('FAILS CLOSED on a multi-record FASTA — never silently registers only the first', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const multiFasta = ['>seqA', 'ACGTACGTAC', '>seqB', 'TTTTGGGGCC', '>seqC', 'AAAACCCCGG'].join(
      '\n'
    );
    const preview = await dryRunLimsImport({
      fileName: 'multi.fasta',
      sourcePath: fixturePath,
      defaultKind: 'sequence',
      text: multiFasta,
    });

    expect(preview.records).toHaveLength(1);
    const record = preview.records[0];
    expect(record.accepted).toBe(false);
    expect(record.entity.registrationStatus).toBe('unresolved');
    expect(record.entity.fields.sequence).toEqual({ mode: 'unresolved' });
    expect(record.errors?.join(' ')).toMatch(/contains 3 sequences/);
    expect(record.errors?.join(' ')).toMatch(/Multi-record FASTA/i);
    expect(record.errors?.join(' ')).toMatch(/Nothing was registered/i);
    expect(record.warnings ?? []).toHaveLength(0);
    expect(preview.oracle.ok).toBe(false);
  });

  it('FAILS CLOSED on a multi-record GenBank — never silently registers only the first', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const singleGenBank = readFileSync(fixturePath, 'utf8');
    const multiGenBank = `${singleGenBank}\n${singleGenBank}`;
    const preview = await dryRunLimsImport({
      fileName: 'multi.gb',
      sourcePath: fixturePath,
      defaultKind: 'sequence',
      text: multiGenBank,
    });

    expect(preview.records).toHaveLength(1);
    const record = preview.records[0];
    expect(record.accepted).toBe(false);
    expect(record.entity.registrationStatus).toBe('unresolved');
    expect(record.entity.fields.sequence).toEqual({ mode: 'unresolved' });
    expect(record.errors?.join(' ')).toMatch(/contains 2 sequences/);
    expect(record.errors?.join(' ')).toMatch(/Multi-record GenBank/i);
    expect(record.errors?.join(' ')).toMatch(/Nothing was registered/i);
    expect(record.warnings ?? []).toHaveLength(0);
    expect(preview.oracle.ok).toBe(false);
  });

  it('still registers a genuine SINGLE-record sequence file (fail-closed does not over-trigger)', async () => {
    const fixturePath = join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
    const preview = await dryRunLimsImport({
      fileName: 'pUC19.gb',
      sourcePath: fixturePath,
      defaultKind: 'sequence',
      text: readFileSync(fixturePath, 'utf8'),
    });

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0].accepted).toBe(true);
    expect(preview.records[0].entity.fields.sequence).toMatchObject({ mode: 'file' });
    expect(preview.oracle.ok).toBe(true);
  });

  it('applyAcceptedLimsImportPlan threads fileProvenance into every accepted record.source  destination)', async () => {
    const csv = ['Name,Sequence', 'P1,ACGTACGTACGT', 'P2,TTTTGGGGCCCC'].join('\n');
    let plan = await createLimsImportPlan({
      fileName: 'primers.csv',
      text: csv,
      forcedKind: 'oligo',
    });
    if (!plan.canApply) {
      for (const r of plan.records) plan = setImportPlanRecordAccepted(plan, r.id, true);
    }
    expect(plan.canApply).toBe(true);

    const provenance = { managedRelPath: 'primers.csv', workspaceRootPath: '/ws/managed/repo' };
    await applyAcceptedLimsImportPlan(plan, { fileProvenance: provenance });
    const req = vi.mocked(applyLimsImportBatch).mock.calls.at(-1)![0];
    const accepted = req.records.filter((r) => r.accepted);
    expect(accepted.length).toBeGreaterThan(0);
    for (const r of accepted) {
      expect(r.source).toMatchObject(provenance);
    }

    await applyAcceptedLimsImportPlan(plan, {});
    const bare = vi.mocked(applyLimsImportBatch).mock.calls.at(-1)![0];
    expect(bare.records[0].source).not.toHaveProperty('managedRelPath');
  });
});

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function existingEntity(
  id: string,
  kind: LimsEntity['kind'],
  name: string,
  fields: LimsEntity['fields'] = {}
): LimsEntity {
  return {
    id,
    kind,
    schemaId: `schema-${kind}`,
    schemaRevisionId: `schema-${kind}-v1`,
    name,
    fields,
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: null,
    actor: 'test',
    eventSeq: null,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}

describe('LIMS xlsx real-file + .xls + perf-cap hardening ', () => {
  const fixture = (name: string) =>
    join(__dirname, '../../../../../test-fixtures/lims-import', name);
  const itWithWorkbook = it.skipIf(!existsSync(fixture('primers-and-strains-multitab.xlsx')));

  itWithWorkbook(
    'parses a REAL .xlsx read from disk (realm-robust; the parse path a dropped file hits)',
    async () => {
      const bytes = readFileSync(fixture('primers-and-strains-multitab.xlsx'));
      const preview = await dryRunLimsImport({
        fileName: 'primers-and-strains-multitab.xlsx',
        arrayBuffer: toArrayBuffer(bytes),
      });
      expect(preview.sourceKind).toBe('xlsx');
      const sheetNames = (preview.sheetDispositions ?? []).map((s) => s.sheetName);
      expect(sheetNames).toContain('Primers');
      expect(sheetNames).toContain('Strains');
      expect(preview.records.length).toBeGreaterThanOrEqual(5);
    }
  );

  itWithWorkbook(
    'enumerates BOTH data sheets of a multi-tab workbook (loop targets — no silent drop)',
    async () => {
      const bytes = readFileSync(fixture('primers-and-strains-multitab.xlsx'));
      const preview = await dryRunLimsImport({
        fileName: 'multitab.xlsx',
        arrayBuffer: toArrayBuffer(bytes),
      });
      expect(listImportableSheets(preview.sheetDispositions).map((s) => s.sheetName)).toEqual([
        'Primers',
        'Strains',
      ]);
      expect(preview.selectedSheet).toBe('Primers');

      const strains = await dryRunLimsImport({
        fileName: 'multitab.xlsx',
        arrayBuffer: toArrayBuffer(bytes),
        sheetName: 'Strains',
      });
      expect(strains.selectedSheet).toBe('Strains');
      expect(strains.records.length).toBeGreaterThanOrEqual(30);
      expect(strains.records[0].entity.kind).toBe('strain');
    }
  );

  itWithWorkbook(
    'builds a per-tab PREVIEW (real header + first rows) for the multi-tab choose step',
    () => {
      const bytes = readFileSync(fixture('primers-and-strains-multitab.xlsx'));
      const previews = buildWorkbookSheetPreviews(toArrayBuffer(bytes), ['Primers', 'Strains']);
      expect(previews.Primers.headers).toContain('Primer ID');
      expect(previews.Primers.rows.length).toBeGreaterThan(0);
      expect(previews.Primers.rows[0].length).toBe(previews.Primers.headers.length);
      expect(previews.Strains.headers).toEqual(expect.arrayContaining(['Name', 'Genotype']));
      expect(previews.Strains.rows.length).toBeLessThanOrEqual(5);
      expect(previews.Strains.sampledRows).toBeGreaterThan(previews.Strains.rows.length);
    }
  );

  it('imports a legacy .xls workbook instead of silently importing NOTHING', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Strain', 'Genotype', 'Source'],
        ['MG1655', 'wild type', 'CGSC'],
        ['DH5a', 'endA1 recA1', 'lab'],
      ]),
      'Sheet1'
    );
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xls' }) as ArrayBuffer | Uint8Array;
    const preview = await dryRunLimsImport({
      fileName: 'strains-legacy.xls',
      arrayBuffer: toArrayBuffer(bytes),
    });
    expect(preview.sourceKind).toBe('xlsx');
    expect(preview.records.length).toBe(2);
    expect(preview.warnings).not.toContain('Empty source');
  });

  it('caps an over-wide sheet and WARNS loudly rather than freezing / silently dropping columns', async () => {
    const header = Array.from({ length: 600 }, (_v, i) => `col${i + 1}`);
    const row = Array.from({ length: 600 }, (_v, i) => `v${i + 1}`);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, row]), 'Wide');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array;
    const preview = await dryRunLimsImport({
      fileName: 'wide.xlsx',
      arrayBuffer: toArrayBuffer(bytes),
    });
    expect(preview.warnings.some((w) => w.includes('exceeds the import cap'))).toBe(true);
    expect(preview.warnings.some((w) => w.includes('88 column(s)'))).toBe(true);
    expect(preview.columns.length).toBe(512);
  });
});

describe('paste header toggle — hasHeader override ', () => {
  it('hasHeader:true — the first row IS the header (N rows → N-1 records)', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'pasted-oligo.csv',
      text: 'Name,Sequence\nprimer-1,ACGTACGTACGTACGT\nprimer-2,TTTTGGGGCCCCAAAA',
      forcedKind: 'oligo',
      hasHeader: true,
    });
    expect(plan.records.length).toBe(2);
    expect(plan.columns.map((c) => c.sourceColumn)).toEqual(
      expect.arrayContaining(['Name', 'Sequence'])
    );
  });

  it('hasHeader:false — EVERY row is data (N rows → N records) with synthesized labels', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'pasted-oligo.csv',
      text: 'primer-1,ACGTACGTACGTACGT\nprimer-2,TTTTGGGGCCCCAAAA',
      forcedKind: 'oligo',
      hasHeader: false,
    });
    expect(plan.records.length).toBe(2);
    expect(plan.columns.map((c) => c.sourceColumn)).toEqual(expect.arrayContaining(['Sequence']));
  });

  it('the SAME two data rows → 1 record with a header vs 2 without — the toggle is load-bearing', async () => {
    const text = 'primer-1,ACGTACGTACGTACGT\nprimer-2,TTTTGGGGCCCCAAAA';
    const withHeader = await createLimsImportPlan({
      fileName: 'p.csv',
      text,
      forcedKind: 'oligo',
      hasHeader: true,
    });
    const noHeader = await createLimsImportPlan({
      fileName: 'p.csv',
      text,
      forcedKind: 'oligo',
      hasHeader: false,
    });
    expect(withHeader.records.length).toBe(1);
    expect(noHeader.records.length).toBe(2);
  });
});
