import { MINI_PLASMID, PUC19, GFP_LINEAR, PUC19_GENBANK, GFP_FASTA } from '../fixtures/sequences';
import { withSequenceTab } from './canvas';
import { withSequenceFile } from './sequence-files';
import type { AppScenario } from './types';

export { createSequenceFixture, withSequenceFile } from './sequence-files';

export function withPUC19(scenario: AppScenario): AppScenario {
  const documentId = 'fixture:sequence:puc19';
  return withSequenceFile(
    withSequenceTab(scenario, {
      documentId,
      sourcePath: '/workspace/pUC19.gb',
      label: 'pUC19',
    }),
    {
      documentId,
      sourcePath: '/workspace/pUC19.gb',
      sequence: PUC19,
      fileContent: PUC19_GENBANK,
    }
  );
}

export function withGFP(scenario: AppScenario): AppScenario {
  const documentId = 'fixture:sequence:gfp';
  return withSequenceFile(
    withSequenceTab(scenario, {
      documentId,
      sourcePath: '/workspace/gfp.fasta',
      label: 'GFP',
    }),
    {
      documentId,
      sourcePath: '/workspace/gfp.fasta',
      sequence: GFP_LINEAR,
      fileContent: GFP_FASTA,
    }
  );
}

export function withMiniPlasmid(scenario: AppScenario): AppScenario {
  const documentId = 'fixture:sequence:mini-plasmid';
  return withSequenceFile(
    withSequenceTab(scenario, {
      documentId,
      sourcePath: '/workspace/mini.gb',
      label: 'Mini Plasmid',
    }),
    {
      documentId,
      sourcePath: '/workspace/mini.gb',
      sequence: MINI_PLASMID,
    }
  );
}

export { MINI_PLASMID, PUC19, GFP_LINEAR, PUC19_GENBANK, GFP_FASTA };
