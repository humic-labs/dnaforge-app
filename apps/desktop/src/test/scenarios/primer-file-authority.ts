import { parseGenBankFull } from '@waypoint/sequence-utils';
import { sidecarScenarios } from './sidecar';
import type { AppScenario } from './types';
import REAL_PUC19_GB from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';

export const PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT = '/mock/test/workspace/primer-file-authority';
export const PRIMER_FILE_AUTHORITY_SEQUENCE_PATH = `${PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT}/pUC19.gb`;
export const PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID =
  'fixture:sequence:primer-file-authority-puc19';
export const PRIMER_FILE_AUTHORITY_GUIDE_PATH = `${PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT}/PROOF.md`;

const PRIMER_FILE_AUTHORITY_GUIDE = `# Primer file authority proof

This regular project was created and mounted through the app's project workflow by the **primerFileAuthorityWorkspace** DevPanel scenario. It contains a byte-stable pUC19 source file and uses the same saving, library, and Git lifecycle as user projects.

## Create and save the primer

1. pUC19 is already open. Switch to the **2D** sequence view if necessary.
2. Drag-select a primer-sized range on the plasmid map (roughly 18-30 bases).
3. Right-click the selected range and choose **Create Forward Primer →**.
4. Name it \`pUC19_manual_F1\`.
5. Fill the required Name, Sequence and Schema fields (marked with an asterisk).
6. Click **Save Primer**. The picker starts in the sequence's folder. The authoritative \`.primer.json\` artifact is saved there and registered automatically.

## Inspect the proof

1. In **Files**, open the new \`.primer.json\` file in the selected save folder. This is the authoritative primer record.
2. In the primer drawer's **Attached** tab, confirm the primer is related to pUC19.
3. Open **LIMS** and confirm the same primer exists as a registered oligo with use \`primer\`.
4. Detach it from pUC19. The artifact remains, its revision increases, and only the relationship disappears.
5. Use **Find** to attach the same registry primer again. The same identity returns with another artifact revision.
6. Open **Git History**. The initial workspace commit and primer artifact commits provide the version history.

## What success looks like

- The \`.primer.json\` file is the source of truth.
- LIMS is a projection of that file, not the only copy.
- The pUC19 association is a relationship stored in the primer artifact.
- The original \`pUC19.gb\` remains byte-for-byte unchanged.
- Selecting this DevPanel scenario again creates another clean workspace, so an earlier run cannot make the next run pass accidentally.
`;

const PRIMER_DIRECTORY_GUIDE = `# Primer artifacts

Primer files created by the proof workflow are saved in this directory.
They are committed independently from the source GenBank file.
`;

export function primerFileAuthorityWorkspace(): AppScenario {
  const sequence = parseGenBankFull(REAL_PUC19_GB);

  return {
    dev: {
      scenarioId: `primer-file-authority-${crypto.randomUUID()}`,
      initializeGit: true,
      initialGitCommitMessage: 'Initialize primer file authority proof workspace',
    },
    sidecar: sidecarScenarios.fullyReady(),
    workspace: {
      folders: [
        {
          path: PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT,
          name: 'Primer development',
        },
      ],
      selectedPath: PRIMER_FILE_AUTHORITY_SEQUENCE_PATH,
    },
    files: {
      [PRIMER_FILE_AUTHORITY_SEQUENCE_PATH]: REAL_PUC19_GB,
      [PRIMER_FILE_AUTHORITY_GUIDE_PATH]: PRIMER_FILE_AUTHORITY_GUIDE,
      [`${PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT}/primers/README.md`]: PRIMER_DIRECTORY_GUIDE,
    },
    sequences: {
      [PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID]: {
        ...sequence,
        id: PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID,
      },
    },
    sequenceSources: {
      [PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID]: {
        sourcePath: PRIMER_FILE_AUTHORITY_SEQUENCE_PATH,
        name: 'pUC19',
      },
    },
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID,
          label: 'pUC19',
          sequenceDocument: {
            kind: 'catalog-sequence',
            entityId: PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID,
          },
        },
      ],
      activeTabIndex: 0,
      layout: 'single',
    },
  };
}
