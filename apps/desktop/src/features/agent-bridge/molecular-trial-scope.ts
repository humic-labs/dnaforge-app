import {
  readMolecularPromptTrialForTurn,
  molecularTrialFixtureTarget,
  molecularTrialArgumentTargets,
} from '../ai/public/molecular-prompt-trials';
import { proteinContextSchema } from '../ai/public/tools/protein-context';
import { molecularQuestionCoverageSchema } from '../page/public/embeds/structure3d/molstar/molecularScientificReviewSchema';

const tools = new Set([
  'mol_list_structures',
  'mol_get_state',
  'mol_activate_view',
  'mol_get_scene',
  'mol_align_structures',
  'mol_select_residues',
  'mol_focus',
  'mol_apply_scene',
  'mol_select_story_step',
  'mol_show_interaction_context',
  'mol_capture_screenshot',
  'mol_save_view',
]);

export type MolecularTrialProteinContextBinding = {
  structureViewId: string;
  authorChain: string;
};

export function molecularTrialProteinContextBinding(
  args: unknown,
  turnId?: string
): MolecularTrialProteinContextBinding | null {
  const trial = readMolecularPromptTrialForTurn(turnId);
  if (!trial) return null;
  const parsed = proteinContextSchema.safeParse(args);
  const input = parsed.success ? parsed.data : null;
  const fixture = input?.pdbId
    ? trial.fixtures.find((item) => item.pdbId.toUpperCase() === input.pdbId!.toUpperCase())
    : undefined;
  if (
    !fixture ||
    input?.source !== 'protein-mcp' ||
    input.operation !== 'annotations' ||
    !input.chain
  )
    throw new Error(
      'This isolated trial permits only annotations for a pinned PDB and protein author chain.'
    );
  return { structureViewId: molecularTrialFixtureTarget(fixture), authorChain: input.chain };
}

export function validateMolecularTrialProteinAuthorChain(
  binding: MolecularTrialProteinContextBinding,
  chains: ReadonlyArray<{ authAsymId?: string; polymerType?: string }>
): void {
  if (
    !chains.some(
      (chain) => chain.authAsymId === binding.authorChain && chain.polymerType === 'protein'
    )
  )
    throw new Error('Pinned annotation requests require an observed protein author chain.');
}

export function molecularTrialToolScope(
  name: string,
  args: unknown,
  turnId?: string
): string[] | null {
  const trial = readMolecularPromptTrialForTurn(turnId);
  if (!trial) return null;
  const owned = trial.fixtures.map(molecularTrialFixtureTarget);
  if (name === 'protein_get_context') {
    const binding = molecularTrialProteinContextBinding(args, turnId)!;
    return [binding.structureViewId];
  }
  if (!tools.has(name)) throw new Error('This isolated trial cannot use outside-context tools.');
  if (name === 'mol_list_structures') return owned;
  const input = args as Record<string, unknown>;
  if (name === 'mol_save_view') {
    const review = input?.scientificReview as
      | { question?: unknown; questionCoverage?: unknown }
      | undefined;
    if (!review)
      throw Object.assign(
        new Error('Trial saves require scientificReview for every final step and display group.'),
        { code: 'MVS_SCIENTIFIC_REVIEW_REQUIRED' }
      );
    if (review.question !== trial.question)
      throw Object.assign(
        new Error('Scientific review must answer the exact original trial question.'),
        {
          code: 'MVS_SCIENTIFIC_REVIEW_QUESTION_MISMATCH',
        }
      );
    if (review.questionCoverage === undefined)
      throw Object.assign(
        new Error(
          'Trial saves require scientificReview.questionCoverage for direct evidence, supporting evidence and unanswered requirements.'
        ),
        { code: 'MVS_SCIENTIFIC_REVIEW_COVERAGE_REQUIRED' }
      );
    molecularQuestionCoverageSchema.parse(review.questionCoverage);
  }
  if (
    (name === 'mol_apply_scene' || name === 'mol_show_interaction_context') &&
    trial.execution &&
    input?.renderProfile !== undefined &&
    JSON.stringify(input.renderProfile) !== JSON.stringify(trial.execution.renderProfile)
  )
    throw new Error('This comparison keeps its recorded render profile fixed.');
  const targets = molecularTrialArgumentTargets(input ?? {});
  if (!targets.length) throw new Error('An isolated trial must specify its own structure target.');
  if (targets.some((target) => !owned.includes(target as string)))
    throw new Error('This isolated trial cannot read or change another viewer.');
  return owned;
}

export function filterMolecularTrialStructures(result: unknown, owned: string[] | null): unknown {
  if (!owned || !result || typeof result !== 'object') return result;
  const input = result as { structures?: Array<{ structureViewId?: string }> };
  if (!Array.isArray(input.structures)) return result;
  return {
    ...input,
    structures: input.structures.filter(
      (structure) => !!structure.structureViewId && owned.includes(structure.structureViewId)
    ),
  };
}
