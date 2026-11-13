import type { AppScenario } from './types';

export const LIMS_PRIMER_CSV_IMPORT_SCENARIO_ID = 'lims-primer-csv-import';
export const LIMS_PRIMER_CSV_IMPORT_BATCH_ID = 'dev-scenario-lims-primer-csv-import';
export const LIMS_PRIMER_CSV_FIXTURE_RELATIVE_PATH =
  'test-data/import-fixtures/primers-alt-headers.csv';
export const LIMS_PRIMER_CSV_FIXTURE_SOURCE_NAME = 'primers-alt-headers.csv';
export const LIMS_HEADERLESS_PRIMER_TSV_SCENARIO_ID = 'lims-headerless-primer-tsv-import';
export const LIMS_HEADERLESS_PRIMER_TSV_BATCH_ID = 'dev-scenario-lims-headerless-primer-tsv';
export const LIMS_HEADERLESS_PRIMER_TSV_RELATIVE_PATH =
  'test-data/assembly/active/00-pcr+digest-with-unrelated-homology/primers.tsv';
export const LIMS_HEADERLESS_PRIMER_TSV_SOURCE_NAME = 'primers.tsv';
export const LIMS_MESSY_PRIMER_CSV_IMPORT_SCENARIO_ID = 'lims-messy-primer-csv-import';
export const LIMS_MESSY_PRIMER_CSV_IMPORT_BATCH_ID = 'dev-scenario-lims-messy-primer-csv-import';
export const LIMS_MESSY_PRIMER_CSV_SOURCE_NAME = 'messy-primer-order-sheet.csv';

export const LIMS_PRIMER_CSV_FIXTURE_TEXT = [
  'Primer ID,Oligo Sequence,Notes,Melting Temp',
  'OL001,ATGCGATCGATCGATCG,Colony PCR forward,54.2',
  'OL002,GCTAGCTAGCTAGCTAG,Colony PCR reverse,52.8',
  'OL003,AATTCCGGAATTCCGG,Restriction site check,51.5',
  'OL004,GGATCCGGATCCGGATCC,BamHI site verification,58.3',
  'OL005,GAATTCGAATTCGAATTC,EcoRI site verification,52.1',
  'OL006,CTCGAGCTCGAGCTCGAG,XhoI site verification,58.0',
  'OL007,AAGCTTAAGCTTAAGCTT,HindIII site verification,50.4',
  'OL008,GCGGCCGCGGCCGCGGCC,NotI site verification,72.5',
].join('\n');

export const LIMS_HEADERLESS_PRIMER_TSV_FALLBACK_TEXT = [
  'M13uni_F\tGTAAAACGACGGCCAGTACGTTGTAAAACG',
  'M13uni_R\tCAGGAAACAGCTATGACCATGATTACGCC',
].join('\n');

export const LIMS_MESSY_PRIMER_CSV_FIXTURE_TEXT = [
  'Primer ID,Oligo Sequence,Owner,Order Date,Supplier,Plate,Well,Project,Notes,Melting Temp,QC Flag,Freezer Box,Legacy ID',
  'MP001,GTAAAACGACGGCCAGT,Peter,2026-06-01,IDT,Plate-7,A01,pUC19 checks,M13 forward control,54.1,pass,Box A,old-001',
  'MP002,CAGGAAACAGCTATGAC,Peter,2026-06-01,IDT,Plate-7,A02,pUC19 checks,M13 reverse control,52.9,pass,Box A,old-002',
  'MP003,ATGACCATGATTACGCCAAG,Alex,2026-06-03,IDT,Plate-8,B01,colony PCR,Screening forward,58.4,review,Box C,legacy-F3',
].join('\n');

export function limsPrimerCsvImportScenario(): AppScenario {
  return {
    dev: {
      scenarioId: LIMS_PRIMER_CSV_IMPORT_SCENARIO_ID,
    },
    lims: {
      imports: [
        {
          sourceName: LIMS_PRIMER_CSV_FIXTURE_SOURCE_NAME,
          text: LIMS_PRIMER_CSV_FIXTURE_TEXT,
          defaultKind: 'oligo',
          batchId: LIMS_PRIMER_CSV_IMPORT_BATCH_ID,
          actor: 'dev-scenario',
          allowExisting: true,
        },
      ],
    },
  };
}

export function limsHeaderlessPrimerTsvScenario(): AppScenario {
  return {
    dev: {
      scenarioId: LIMS_HEADERLESS_PRIMER_TSV_SCENARIO_ID,
    },
    lims: {
      imports: [
        {
          sourceName: LIMS_HEADERLESS_PRIMER_TSV_SOURCE_NAME,
          text: LIMS_HEADERLESS_PRIMER_TSV_FALLBACK_TEXT,
          defaultKind: 'oligo',
          batchId: LIMS_HEADERLESS_PRIMER_TSV_BATCH_ID,
          actor: 'dev-scenario',
          allowExisting: true,
        },
      ],
    },
  };
}

export function limsMessyPrimerCsvImportScenario(): AppScenario {
  return {
    dev: {
      scenarioId: LIMS_MESSY_PRIMER_CSV_IMPORT_SCENARIO_ID,
    },
    lims: {
      imports: [
        {
          sourceName: LIMS_MESSY_PRIMER_CSV_SOURCE_NAME,
          text: LIMS_MESSY_PRIMER_CSV_FIXTURE_TEXT,
          defaultKind: 'oligo',
          batchId: LIMS_MESSY_PRIMER_CSV_IMPORT_BATCH_ID,
          actor: 'dev-scenario',
          allowExisting: true,
        },
      ],
    },
  };
}
