import { PUC19_GENBANK, GFP_FASTA } from '../fixtures/sequences';
import { withSequenceWorkspace } from './workspace-files';
import type { AppScenario } from './types';

export { withWorkspaceFolder, withEmptyWorkspace } from './workspace-files';

export function withStandardWorkspace(scenario: AppScenario): AppScenario {
  return withSequenceWorkspace(scenario, {
    puc19Genbank: PUC19_GENBANK,
    gfpFasta: GFP_FASTA,
  });
}
