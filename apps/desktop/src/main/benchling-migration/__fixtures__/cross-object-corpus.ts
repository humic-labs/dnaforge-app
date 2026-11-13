import {
  buildSyntheticNativeExportZip,
  type SyntheticZipEntry,
  type SyntheticZipFixture,
} from './native-export-zip-fixture';

const ROOT = 'Controlled Corpus';
const DUPLICATE_NAME = 'Duplicate display name';
const SEQUENCE = 'ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT';

const notebookA: SyntheticZipEntry = {
  path: `${ROOT}/Controlled Corpus A (etr_DNA2347A).html`,
  bytes: `<!doctype html>
<html data-file-id="etr_DNA2347A">
  <body>
    <h1>Controlled Corpus A</h1>
    <a href="https://benchling.com/dnaforge-fixture/f/lib_DNA2347-controlled/etr_DNA2347B-linked-notebook/edit" data-internal-link='{"type":"entry","id":"etr_DNA2347B"}'>Linked notebook</a>
    <a href="https://benchling.com/dnaforge-fixture/f/lib_DNA2347-controlled/seq_DNA2347TARGET-duplicate-display-name/edit" data-internal-link='{"type":"sequence","id":"seq_DNA2347TARGET"}'>Linked sequence</a>
  </body>
</html>
`,
};

const notebookB: SyntheticZipEntry = {
  path: `${ROOT}/Controlled Corpus B (etr_DNA2347B).html`,
  bytes: `<!doctype html>
<html data-file-id="etr_DNA2347B">
  <body><h1>Controlled Corpus B</h1><p>Synthetic linked notebook target.</p></body>
</html>
`,
};

const targetSequence: SyntheticZipEntry = {
  path: `${ROOT}/${DUPLICATE_NAME} (seq_DNA2347TARGET).gb`,
  bytes: genbank(DUPLICATE_NAME),
};

const collisionTwin: SyntheticZipEntry = {
  path: `${ROOT}/${DUPLICATE_NAME} (seq_DNA2347TWIN).gb`,
  bytes: genbank(DUPLICATE_NAME),
};

const idStrippedTarget: SyntheticZipEntry = {
  path: `${ROOT}/${DUPLICATE_NAME}.gb`,
  bytes: genbank(DUPLICATE_NAME),
};

export type ControlledCrossObjectCorpus = {
  complete: SyntheticZipFixture;
  notebooksFirst: SyntheticZipFixture;
  sequencesFirst: SyntheticZipFixture;
  idStripped: SyntheticZipFixture;
};

export const CONTROLLED_CORPUS_GROUND_TRUTH = {
  objects: {
    sourceNotebookId: 'etr_DNA2347A',
    targetNotebookId: 'etr_DNA2347B',
    targetSequenceId: 'seq_DNA2347TARGET',
    collisionTwinId: 'seq_DNA2347TWIN',
  },
  relationships: [
    {
      sourceId: 'etr_DNA2347A',
      targetId: 'etr_DNA2347B',
      targetType: 'notebook_entry',
      expectedResolution: 'exact',
    },
    {
      sourceId: 'etr_DNA2347A',
      targetId: 'seq_DNA2347TARGET',
      targetType: 'dna_sequence',
      expectedResolution: 'exact',
    },
  ],
  forbiddenMatches: [
    {
      sourceId: 'etr_DNA2347A',
      targetId: 'seq_DNA2347TWIN',
      reason: 'Same display name and sequence bytes are not an identity key.',
    },
  ],
  importOrders: {
    notebooksFirst: {
      beforeSequenceImport: 'unresolved_with_missing_source_indicator',
      afterSequenceImport: 'exact_target_repaired',
    },
    sequencesFirst: {
      beforeNotebookImport: 'target_available',
      afterNotebookImport: 'exact_target_linked',
    },
    idStripped: 'unresolved_review_required',
  },
} as const;

export function buildControlledCrossObjectCorpus(): ControlledCrossObjectCorpus {
  return {
    complete: buildSyntheticNativeExportZip([notebookA, notebookB, targetSequence, collisionTwin]),
    notebooksFirst: buildSyntheticNativeExportZip([notebookA, notebookB]),
    sequencesFirst: buildSyntheticNativeExportZip([targetSequence, collisionTwin]),
    idStripped: buildSyntheticNativeExportZip([
      notebookA,
      notebookB,
      idStrippedTarget,
      collisionTwin,
    ]),
  };
}

function genbank(name: string): string {
  return `LOCUS       DNA2347_FIXTURE        60 bp    DNA     linear
DEFINITION  ${name}.
ORIGIN
        1 ${SEQUENCE.toLowerCase()}
//
`;
}
