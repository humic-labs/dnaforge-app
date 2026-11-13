import { withUserMessage, userMessagePayload, userMessageValue } from '@waypoint/user-messages';
import {
  listMolecularPromptTrialResults,
  listMolecularPromptTrialStarts,
  type MolecularPromptTrialResultRecord,
} from '../../db/molecular-prompt-trials';
import { getEntityReferencesByIds } from '../../db/entity-references';
import {
  molecularViewFromReferenceData,
  molecularViewSourceDigests,
  validateMolecularViewCoordinates,
} from '../page/public/embeds/structure3d/molecularView';
import type { MolecularRoundSlot } from './molecular-prompt-trials';

export const molecularRoundSlotKey = (slot: MolecularRoundSlot): string =>
  JSON.stringify([slot.caseId, slot.variantId, slot.replicate]);

export type MolecularRoundCompletion = {
  experimentId: string;
  requiredSlots: MolecularRoundSlot[];
  completedSlots: Array<MolecularRoundSlot & { resultId: string; referenceIds: string[] }>;
  incompleteSlots: Array<MolecularRoundSlot & { reasons: string[] }>;
  complete: boolean;
};

export class MolecularRoundIncompleteError extends Error {
  constructor(readonly completion: MolecularRoundCompletion) {
    super(
      `Round incomplete: ${completion.completedSlots.length}/${completion.requiredSlots.length} required saved runs. ` +
        completion.incompleteSlots
          .map(
            (slot) =>
              `${slot.caseId} · ${slot.variantId} · run ${slot.replicate}: ${slot.reasons.join('; ')}`
          )
          .join(' | ')
    );
    this.name = 'MolecularRoundIncompleteError';
    withUserMessage(
      this,
      userMessagePayload('assistant.roundIncomplete', {
        completed: userMessageValue(completion.completedSlots.length),
        required: userMessageValue(completion.requiredSlots.length),
      })
    );
  }
}

export async function inspectMolecularRoundCompletion(
  experimentId: string,
  legacyDeclaredSlots?: readonly MolecularRoundSlot[]
): Promise<MolecularRoundCompletion> {
  const [starts, results] = await Promise.all([
    listMolecularPromptTrialStarts(),
    listMolecularPromptTrialResults(),
  ]);
  const experimentIds = new Set([experimentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { trial } of starts) {
      const exp = trial.experiment;
      if (
        exp?.recoveryOfExperimentId &&
        experimentIds.has(exp.recoveryOfExperimentId) &&
        !experimentIds.has(exp.id)
      ) {
        experimentIds.add(exp.id);
        changed = true;
      }
    }
  }
  const roundStarts = starts.filter(
    ({ trial }) => trial.experiment && experimentIds.has(trial.experiment.id)
  );
  const recordedPlans = roundStarts.flatMap(({ trial }) =>
    trial.experiment?.requiredSlots ? [trial.experiment.requiredSlots] : []
  );
  const requiredSlots = recordedPlans[0] ?? (legacyDeclaredSlots ? [...legacyDeclaredSlots] : null);
  if (!requiredSlots?.length)
    throw new Error(
      'No frozen round plan is recorded. Declare the full historical slots explicitly; started attempts cannot define completion.'
    );
  const keys = requiredSlots.map(molecularRoundSlotKey);
  if (new Set(keys).size !== keys.length)
    throw new Error('The frozen round plan contains duplicate slots.');
  const signature = JSON.stringify([...keys].sort());
  for (const plan of [
    ...recordedPlans,
    ...(legacyDeclaredSlots ? [[...legacyDeclaredSlots]] : []),
  ]) {
    if (JSON.stringify(plan.map(molecularRoundSlotKey).sort()) !== signature)
      throw new Error(
        'The original round plan and repair plan disagree; completion cannot be established.'
      );
  }
  const roundResults = results.filter(
    ({ trial }) => trial.experiment && experimentIds.has(trial.experiment.id)
  );
  const completedSlots: MolecularRoundCompletion['completedSlots'] = [];
  const incompleteSlots: MolecularRoundCompletion['incompleteSlots'] = [];
  const rows = await getEntityReferencesByIds([
    ...new Set(roundResults.flatMap((result) => result.referenceIds)),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  async function validateOutput(result: MolecularPromptTrialResultRecord): Promise<string[]> {
    if (result.status !== 'rendered')
      return [result.observation || `Attempt ended ${result.status}.`];
    if (!result.referenceIds.length) return ['Completed conversation saved no structure view.'];
    if (
      new Set(result.referenceIds).size !== result.referenceIds.length ||
      result.referenceIds.length !== result.coordinateDigests.length
    )
      return ['Saved structure references are missing, duplicated or inconsistent.'];
    if (!result.sceneChanged || !result.cameraNodePresent || !result.routeKey)
      return ['Saved output lacks the recorded authored scene, camera or agent route.'];
    const coverage = new Set<string>();
    for (let i = 0; i < result.referenceIds.length; i++) {
      const row = byId.get(result.referenceIds[i]);
      const view =
        row?.entity_type === 'structure' ? molecularViewFromReferenceData(row.data) : null;
      if (!view || !row?.locator?.startsWith('entity://structure/saved-view:'))
        return [`Saved structure ${result.referenceIds[i]} no longer resolves.`];
      if (view.coordinates.sha256 !== result.coordinateDigests[i])
        return ['Saved coordinate identity differs from its recorded output.'];
      try {
        await validateMolecularViewCoordinates(view);
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
      for (const digest of molecularViewSourceDigests(view)) coverage.add(digest);
      const review = view.scientificReview as
        | { questionCoverage?: { unanswered?: string[] } }
        | undefined;
      if (result.trial.execution?.startPolicyVersion === 1 && !review?.questionCoverage)
        return ['Independent trial saved no account of direct question coverage.'];
      if (review?.questionCoverage?.unanswered?.length)
        return [`Question remains unanswered: ${review.questionCoverage.unanswered.join('; ')}`];
    }
    if (!result.trial.fixtures.every((fixture) => coverage.has(fixture.coordinateSha256)))
      return ['Saved scenes do not cover every declared coordinate source.'];
    return [];
  }

  for (const slot of requiredSlots) {
    const attempts = roundResults
      .filter(
        (result) =>
          result.trial.caseId === slot.caseId &&
          result.trial.profileId === slot.variantId &&
          result.trial.experiment?.replicate === slot.replicate
      )
      .sort((a, b) => a.recordedAt - b.recordedAt);
    const reasons: string[] = [];
    let completed: MolecularPromptTrialResultRecord | undefined;
    for (const result of attempts) {
      const errors = await validateOutput(result);
      if (!errors.length) {
        completed = result;
        break;
      }
      reasons.push(...errors);
    }
    if (completed)
      completedSlots.push({
        ...slot,
        resultId: completed.id,
        referenceIds: [...completed.referenceIds],
      });
    else
      incompleteSlots.push({
        ...slot,
        reasons: [
          ...new Set(reasons.length ? reasons : ['No completed saved-output result is recorded.']),
        ],
      });
  }
  return {
    experimentId,
    requiredSlots,
    completedSlots,
    incompleteSlots,
    complete: incompleteSlots.length === 0,
  };
}

export async function requireMolecularRoundCompletion(
  experimentId: string,
  legacyDeclaredSlots?: readonly MolecularRoundSlot[]
): Promise<MolecularRoundCompletion> {
  const completion = await inspectMolecularRoundCompletion(experimentId, legacyDeclaredSlots);
  if (!completion.complete) throw new MolecularRoundIncompleteError(completion);
  return completion;
}
