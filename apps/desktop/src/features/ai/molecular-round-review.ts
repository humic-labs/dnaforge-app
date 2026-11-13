import {
  molecularRoundDecisionsSchema,
  molecularRoundReviewSchema,
  type MolecularRoundDecisions,
  type MolecularRoundReview,
} from '../../shared/molecular-round-review';
export {
  molecularRoundDecisionsSchema,
  molecularRoundReviewSchema,
  type MolecularRoundDecisions,
  type MolecularRoundReview,
} from '../../shared/molecular-round-review';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';
import {
  buildProteinCorpusLedger,
  type ProteinCorpusInput,
} from '../page/public/embeds/protein-prompt-history/corpus-ledger';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)])
    );
  return value;
}

export async function createMolecularRoundReview(
  input: ProteinCorpusInput,
  baseSystemPrompt: string,
  runPlan: unknown,
  decisions: MolecularRoundDecisions
): Promise<MolecularRoundReview> {
  const ledger = buildProteinCorpusLedger(input);
  return molecularRoundReviewSchema.parse({
    version: 1,
    reviewedAt: Date.now(),
    corpusSha256: await coordinateDigest(
      JSON.stringify(
        canonical({
          starts: [...input.starts].sort((a, b) => a.id.localeCompare(b.id)),
          results: [...input.results].sort((a, b) => a.id.localeCompare(b.id)),
        })
      )
    ),
    systemPromptSha256: await coordinateDigest(baseSystemPrompt),
    runPlanSha256: await coordinateDigest(JSON.stringify(canonical(runPlan))),
    decisions: molecularRoundDecisionsSchema.parse(decisions),
    corpus: {
      starts: input.starts.length,
      attempts: input.results.length,
      incompleteStarts: ledger.incompleteStarts.length,
      versions: ledger.versions.length,
      feedbackNotes: input.results.reduce((sum, r) => sum + r.feedback.length, 0),
      unassessedRenderedSlots: ledger.versions.reduce(
        (sum, v) => sum + v.unassessedRenderedSlots,
        0
      ),
    },
  });
}

export function requireCurrentMolecularRoundReview(
  review: unknown,
  current: MolecularRoundReview
): MolecularRoundReview {
  const parsed = molecularRoundReviewSchema.safeParse(review);
  if (!parsed.success)
    throw new Error(
      'Review the corpus, system prompt, harness and guidance before starting this round. No agent was dispatched.'
    );
  const value = parsed.data;
  if (
    value.corpusSha256 !== current.corpusSha256 ||
    value.systemPromptSha256 !== current.systemPromptSha256 ||
    value.runPlanSha256 !== current.runPlanSha256
  )
    throw new Error(
      'The corpus, prompt or run plan changed after this review. Refresh the round review before dispatch.'
    );
  if (JSON.stringify(value.corpus) !== JSON.stringify(current.corpus))
    throw new Error('The review summary does not match the recorded corpus.');
  return structuredClone(value);
}
