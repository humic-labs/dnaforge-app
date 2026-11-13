import { parseGenBankFull } from '@waypoint/sequence-utils';
import REFERENCE from '../../../../../test-fixtures/alignments/cds-mutation-gallery/reference.gb?raw';
import QUERY from '../../../../../test-fixtures/alignments/cds-mutation-gallery/all-edits.fasta?raw';
import type { AppScenario } from './types';

export const CDS_MUTATION_GALLERY_ID = 'cds-mutation-gallery';
const DOCUMENT = 'fixture:sequence:cds-mutation-gallery';
const ROOT = '/mock/test/cds-mutation-gallery';
const REFERENCE_PATH = `${ROOT}/CDS-mutation-gallery.gb`;
const QUERY_PATH = `${ROOT}/all-edits.fasta`;

export function cdsMutationGallery(): AppScenario {
  return {
    dev: { scenarioId: CDS_MUTATION_GALLERY_ID },
    openSequenceDrawer: 'alignments',
    workspace: {
      folders: [{ path: ROOT, name: 'CDS mutation comparison — 29 cases' }],
      selectedPath: ROOT,
    },
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: DOCUMENT,
          label: 'Mutation gallery — all cases',
          sequenceDocument: { kind: 'catalog-sequence', entityId: DOCUMENT },
        },
      ],
      activeTabIndex: 0,
    },
    sequences: {
      [DOCUMENT]: { ...parseGenBankFull(REFERENCE, { featurePolicy: 'preserve' }), id: DOCUMENT },
    },
    sequenceSources: { [DOCUMENT]: { sourcePath: REFERENCE_PATH, name: 'CDS mutation gallery' } },
    files: { [REFERENCE_PATH]: REFERENCE, [QUERY_PATH]: QUERY },
    attachAlignmentQueries: {
      documentId: DOCUMENT,
      sourcePath: REFERENCE_PATH,
      queryPaths: [QUERY_PATH],
      sessionName: 'All mutation cases — combined query',
      mode: 'one-per-clone',
    },
  };
}
