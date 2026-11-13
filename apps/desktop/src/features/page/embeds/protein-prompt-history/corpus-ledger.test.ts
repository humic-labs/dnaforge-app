import { describe, expect, it } from 'vitest';
import type {
  MolecularPromptTrialResultRecord,
  MolecularPromptTrialStartRecord,
} from '../../../../db/molecular-prompt-trials';
import { buildProteinCorpusLedger, proteinCorpusEvidenceBundle } from './corpus-ledger';

function trial(
  caseId: string,
  profileId: string,
  guidance: string,
  experimentId: string,
  replicate: number,
  recoveryOfExperimentId?: string
) {
  return {
    caseId,
    profileId,
    profileLabel: 'Visual guidance',
    promptInstructions: `Fixed protein benchmark context (v1): context\nPrompt module ${profileId}:\n${guidance}\nPinned coordinate fixtures for this conversation:\nfixed`,
    experiment: {
      id: experimentId,
      ...(recoveryOfExperimentId ? { recoveryOfExperimentId } : {}),
      replicate,
      replicateCount: 3,
    },
  } as MolecularPromptTrialResultRecord['trial'];
}

function result(
  id: string,
  item: MolecularPromptTrialResultRecord['trial'],
  status: MolecularPromptTrialResultRecord['status'],
  recordedAt: number,
  feedback: MolecularPromptTrialResultRecord['feedback'] = []
): MolecularPromptTrialResultRecord {
  return {
    id,
    trial: item,
    status,
    recordedAt,
    feedback,
    observation: status === 'failed' ? 'provider refusal' : 'rendered',
    referenceIds: status === 'rendered' ? [`view-${id}`] : [],
    coordinateDigests: status === 'rendered' ? ['a'.repeat(64)] : [],
    promptSnapshot: {
      version: 1,
      conversationId: '00000000-0000-4000-8000-000000000001',
      turnId: '00000000-0000-4000-8000-000000000002',
      channel: 'cli-seed',
      prompt: `exact sent prompt for ${id}`,
      continuationPrompt: 'exact continuation',
      additionalAgentInstructions: null,
      scenePolicy: {
        id: 'mvs',
        enforcedConstraints: [{ id: 'x', label: 'x', errorCode: 'x', enforcement: 'x' }],
      },
      capturedAt: recordedAt - 1,
    },
    cameraNodePresent: status === 'rendered',
    cameraChanged: status === 'rendered',
    sceneChanged: status === 'rendered',
    routeKey: 'route',
  };
}

describe('protein corpus evidence ledger', () => {
  it('retains failures and recoveries while counting one effective replicate slot', () => {
    const original = result(
      'failed',
      trial('rsv-f-d25', 'v14', 'Show relationship.', 'exp-1', 2),
      'failed',
      10
    );
    const recovered = result(
      'recovered',
      trial('rsv-f-d25', 'v14', 'Show relationship.', 'exp-2', 2, 'exp-1'),
      'rendered',
      20,
      [{ id: 'note-1', viewReferenceId: 'view-recovered', text: 'Good camera.', recordedAt: 21 }]
    );
    const refusal = result(
      'refusal',
      trial('pgt128', 'v14', 'Show relationship.', 'exp-1', 1),
      'failed',
      11
    );
    const ledger = buildProteinCorpusLedger({
      starts: [],
      results: [recovered, refusal, original],
    });
    const version = ledger.versions[0];
    expect(version).toMatchObject({
      attempts: 3,
      slots: 2,
      renderedSlots: 1,
      failedSlots: 1,
      recoveredSlots: 1,
      reviewedRenderedSlots: 1,
      feedbackNotes: 1,
    });
    expect(ledger.attempts.map((attempt) => attempt.resultId)).toEqual([
      'failed',
      'refusal',
      'recovered',
    ]);
    expect(ledger.slots.find((slot) => slot.caseId === 'rsv-f-d25')?.attemptIds).toEqual([
      'failed',
      'recovered',
    ]);
    expect(ledger.slots.find((slot) => slot.caseId === 'pgt128')?.effectiveStatus).toBe('failed');
  });

  it('does not rescue a later failed attempt with an earlier lucky render', () => {
    const first = result('first', trial('kcsa', 'v14', 'Guidance.', 'exp-1', 1), 'rendered', 10);
    const retry = result(
      'retry',
      trial('kcsa', 'v14', 'Guidance.', 'exp-2', 1, 'exp-1'),
      'failed',
      20
    );
    const ledger = buildProteinCorpusLedger({ starts: [], results: [first, retry] });
    expect(ledger.versions[0]).toMatchObject({
      attempts: 2,
      slots: 1,
      renderedSlots: 0,
      failedSlots: 1,
      recoveredSlots: 0,
    });
  });

  it('separates the same label with different guidance and never infers visual quality', () => {
    const first = result('first', trial('kcsa', 'v14', 'Style A.', 'exp-1', 1), 'rendered', 10);
    const second = result('second', trial('kcsa', 'v14', 'Style B.', 'exp-2', 1), 'rendered', 20);
    const ledger = buildProteinCorpusLedger({ starts: [], results: [first, second] });
    expect(ledger.versions).toHaveLength(2);
    expect(ledger.versions.every((version) => version.unreviewedRenderedSlots === 1)).toBe(true);
    expect(JSON.stringify(ledger)).not.toMatch(/qualityScore|passRate/);
  });

  it('shows when two recorded variant IDs reuse the identical guidance', () => {
    const first = result('first', trial('kcsa', 'v10-a', 'Same body.', 'exp-1', 1), 'rendered', 10);
    const second = result(
      'second',
      trial('kcsa', 'v10-b', 'Same body.', 'exp-2', 1),
      'rendered',
      20
    );
    first.trial.profileLabel = 'Earlier cohort';
    second.trial.profileLabel = 'Later cohort';
    const ledger = buildProteinCorpusLedger({ starts: [], results: [first, second] });
    expect(ledger.versions).toHaveLength(2);
    expect(ledger.distinctGuidanceBodies).toBe(1);
    expect(ledger.versions[0].sameGuidanceAs).toEqual(['Later cohort']);
    expect(ledger.versions[1].sameGuidanceAs).toEqual(['Earlier cohort']);
  });

  it('requires explicit assessments of every saved output and retains later corrections', () => {
    const item = result(
      'paired',
      trial('rsv-f-d25', 'v14', 'Compare conformations.', 'exp-1', 1),
      'rendered',
      10,
      [
        {
          id: 'a1',
          viewReferenceId: 'view-paired',
          text: 'First view works.',
          assessment: 'acceptable',
          recordedAt: 11,
        },
        {
          id: 'a2',
          viewReferenceId: 'other-view',
          text: 'Second view is confusing.',
          assessment: 'needs-work',
          recordedAt: 12,
        },
        {
          id: 'a3',
          viewReferenceId: 'other-view',
          text: 'After closer review, this works.',
          assessment: 'acceptable',
          recordedAt: 13,
        },
      ] as MolecularPromptTrialResultRecord['feedback']
    );
    item.referenceIds.push('other-view');
    const accepted = buildProteinCorpusLedger({ starts: [], results: [item] });
    expect(accepted.versions[0]).toMatchObject({
      assessedRenderedSlots: 1,
      acceptableRenderedSlots: 1,
      needsWorkRenderedSlots: 0,
      uncertainRenderedSlots: 0,
      unassessedRenderedSlots: 0,
    });
    item.feedback.pop();
    const rejected = buildProteinCorpusLedger({ starts: [], results: [item] });
    expect(rejected.versions[0]).toMatchObject({
      assessedRenderedSlots: 1,
      acceptableRenderedSlots: 0,
      needsWorkRenderedSlots: 1,
    });
    item.feedback.splice(1);
    const partial = buildProteinCorpusLedger({ starts: [], results: [item] });
    expect(partial.versions[0]).toMatchObject({
      assessedRenderedSlots: 0,
      acceptableRenderedSlots: 0,
      unassessedRenderedSlots: 1,
    });
    item.feedback = [
      {
        id: 'free-text',
        viewReferenceId: 'view-paired',
        text: 'This is the best one.',
        recordedAt: 14,
      },
    ];
    expect(
      buildProteinCorpusLedger({ starts: [], results: [item] }).versions[0].assessedRenderedSlots
    ).toBe(0);
  });

  it('shows an isolation-failed label as an alias when valid runs used the same guidance', () => {
    const failed = result(
      'failed',
      trial('kcsa', 'v10', 'Same guidance.', 'exp-1', 1),
      'failed',
      10
    );
    failed.trial.profileLabel = 'V10 · isolation failed';
    const valid = result(
      'valid',
      trial('kcsa', 'v10', 'Same guidance.', 'exp-2', 1),
      'rendered',
      20
    );
    valid.trial.profileLabel = 'V10';
    const ledger = buildProteinCorpusLedger({ starts: [], results: [failed, valid] });
    expect(ledger.versions).toHaveLength(1);
    expect(ledger.versions[0].label).toBe('V10');
    expect(ledger.versions[0].labels).toContain('V10 · isolation failed');
  });

  it('exports exact prompts, feedback and incomplete starts without rewriting source records', () => {
    const rendered = result(
      'rendered',
      trial('kcsa', 'v14', 'Style A.', 'exp-1', 1),
      'rendered',
      10,
      [{ id: 'note', viewReferenceId: 'view-rendered', text: 'Looks good.', recordedAt: 12 }]
    );
    const start = {
      id: 'orphan',
      trial: trial('groel', 'v14', 'Style A.', 'exp-1', 2),
    } as MolecularPromptTrialStartRecord;
    const input = { starts: [start], results: [rendered] };
    const before = JSON.stringify(input);
    const bundle = proteinCorpusEvidenceBundle(input, 30);
    expect(bundle.starts).toEqual([start]);
    expect(bundle.results).toEqual([rendered]);
    expect(bundle.ledger.incompleteStarts).toEqual(['orphan']);
    expect(bundle.ledger.versions[0].startsWithoutResult).toBe(1);
    expect(bundle.results[0].promptSnapshot?.prompt).toBe('exact sent prompt for rendered');
    expect(bundle.results[0].feedback[0].text).toBe('Looks good.');
    expect(JSON.stringify(input)).toBe(before);
  });
});
