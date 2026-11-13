import { describe, expect, it } from 'vitest';
import {
  createMolecularRoundReview,
  requireCurrentMolecularRoundReview,
} from './molecular-round-review';

const decisions = {
  systemPrompt: 'Keep the general prompt after reviewing its scope.',
  harness: 'Use compiler-enforced preferences and exact source ownership.',
  guidance: 'Keep the current guidance; evaluate the changed whole system.',
};
const corpus = { starts: [], results: [] };
const plan = {
  cases: ['control'],
  variants: [{ id: 'v', instructions: 'General guidance' }],
  renderProfile: 'default',
};

describe('evidence-bound round admission', () => {
  it('requires an explicit review of all three instruction boundaries even when the prompt is unchanged', async () => {
    const current = await createMolecularRoundReview(corpus, 'Base prompt', plan, decisions);
    expect(() => requireCurrentMolecularRoundReview(undefined, current)).toThrow(
      /Review the corpus/
    );
    expect(() =>
      requireCurrentMolecularRoundReview(
        { ...current, decisions: { ...decisions, harness: '' } },
        current
      )
    ).toThrow(/Review the corpus/);
    expect(requireCurrentMolecularRoundReview(current, current)).toEqual(current);
    expect(current.corpus.unassessedRenderedSlots).toBe(0);
  });

  it('rejects a forged corpus summary even when its digests match', async () => {
    const current = await createMolecularRoundReview(corpus, 'Prompt', plan, decisions);
    expect(() =>
      requireCurrentMolecularRoundReview(
        { ...current, corpus: { ...current.corpus, attempts: 99 } },
        current
      )
    ).toThrow(/summary/);
  });

  it('binds the same frozen plan independently of object-key insertion order', async () => {
    const first = await createMolecularRoundReview(
      corpus,
      'Prompt',
      { a: 1, b: { x: 2, y: 3 } },
      decisions
    );
    const second = await createMolecularRoundReview(
      corpus,
      'Prompt',
      { b: { y: 3, x: 2 }, a: 1 },
      decisions
    );
    expect(first.runPlanSha256).toBe(second.runPlanSha256);
  });

  it('rejects changed prompt, guidance, fixtures or presentation profile before dispatch', async () => {
    const reviewed = await createMolecularRoundReview(corpus, 'Base prompt', plan, decisions);
    for (const changed of [
      await createMolecularRoundReview(corpus, 'New base prompt', plan, decisions),
      await createMolecularRoundReview(
        corpus,
        'Base prompt',
        { ...plan, renderProfile: 'new' },
        decisions
      ),
      await createMolecularRoundReview(
        corpus,
        'Base prompt',
        { ...plan, variants: [{ id: 'v', instructions: 'Changed guidance' }] },
        decisions
      ),
      await createMolecularRoundReview(
        corpus,
        'Base prompt',
        { ...plan, fixtures: { control: 'other' } },
        decisions
      ),
    ])
      expect(() => requireCurrentMolecularRoundReview(reviewed, changed)).toThrow(
        /changed after this review/
      );
  });
});
