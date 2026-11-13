import { parseGenBankFull } from '@waypoint/sequence-utils';
import {
  primerFileAuthorityWorkspace,
  PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT,
} from './primer-file-authority';
import type { AppScenario } from './types';
import GFP from '../../../../../test-fixtures/sequences/linear/sfgfp-cds.gb?raw';
import PUC19 from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import PRS416 from '../../../../../test-fixtures/sequences/circular/pRS416.gb?raw';
import CHRV from '../../../../../test-fixtures/genomes/yeast-S288C/NC_001137.3-annotated.gb?raw';

export function agentScientificAuthoringWorkspace(): AppScenario {
  const scenario = primerFileAuthorityWorkspace();
  const controlRoot = '/mock/test/workspace/source-controls';
  return {
    ...scenario,
    workspace: {
      ...scenario.workspace,
      folders: [
        { path: PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT, name: 'Primer development' },
        { path: controlRoot, name: 'Source controls' },
      ],
    },
    files: {
      ...scenario.files,
      [`${controlRoot}/sfGFP.gb`]: GFP,
      [`${controlRoot}/pUC19.gb`]: PUC19,
      [`${controlRoot}/pRS416.gb`]: PRS416,
      [`${controlRoot}/S288C-chromosome-V.gb`]: CHRV,
    },
    sequences: {
      ...scenario.sequences,
      'fixture:authoring-gfp': { ...parseGenBankFull(GFP), id: 'fixture:authoring-gfp' },
      'fixture:authoring-prs416': { ...parseGenBankFull(PRS416), id: 'fixture:authoring-prs416' },
      'fixture:authoring-chrV': { ...parseGenBankFull(CHRV), id: 'fixture:authoring-chrV' },
      'fixture:authoring-puc-control': {
        ...parseGenBankFull(PUC19),
        id: 'fixture:authoring-puc-control',
      },
    },
    sequenceSources: {
      ...scenario.sequenceSources,
      'fixture:authoring-gfp': { sourcePath: `${controlRoot}/sfGFP.gb`, name: 'sfGFP' },
      'fixture:authoring-prs416': { sourcePath: `${controlRoot}/pRS416.gb`, name: 'pRS416' },
      'fixture:authoring-chrV': {
        sourcePath: `${controlRoot}/S288C-chromosome-V.gb`,
        name: 'S288C chromosome V',
      },
      'fixture:authoring-puc-control': { sourcePath: `${controlRoot}/pUC19.gb`, name: 'pUC19' },
    },
  };
}
