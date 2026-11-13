import { describe, expect, it } from 'vitest';
import { buildProteinRunIndex, sortProteinRunEntries, groupProteinRunVersions } from './run-index';

const trial = {
  version: 1 as const,
  caseId: 'kcsa' as const,
  profileId: 'appearance-v1' as const,
  conversationId: 'chat-kcsa',
  question: 'What replaces water in the KcsA filter?',
  context: 'Pinned 1K4C coordinates',
  promptInstructions: 'Emphasize the filter geometry.',
  fixtures: [],
  startedAt: 100,
  startRecordId: 'start-kcsa',
};

describe('protein run index', () => {
  it('keeps the round review attached to its recorded attempt and out of the sent prompt', () => {
    const roundReview = {
      version: 1 as const,
      reviewedAt: 1,
      corpusSha256: 'a'.repeat(64),
      systemPromptSha256: 'b'.repeat(64),
      runPlanSha256: 'c'.repeat(64),
      decisions: {
        systemPrompt: 'Keep general prompt',
        harness: 'Exact native source checks',
        guidance: 'Keep fixed guidance',
      },
      corpus: {
        starts: 2,
        attempts: 1,
        incompleteStarts: 1,
        versions: 1,
        feedbackNotes: 0,
        unassessedRenderedSlots: 1,
      },
    };
    const index = buildProteinRunIndex({
      starts: [{ id: 'start-kcsa', trial: { ...trial, roundReview } }],
      results: [],
      harnessRecords: [],
      savedViews: [],
    });
    expect(index.promptTrials[0].roundReview).toEqual(roundReview);
    expect(index.promptTrials[0].promptInstructions).not.toContain(roundReview.decisions.harness);
  });
  it('carries successful sibling recoveries into the latest triplicate without rewriting original history', () => {
    const original = [1, 2, 3].map((replicate) => ({
      id: `original-${replicate}`,
      promptLabel: 'V13',
      promptInstructions: 'Same guidance',
      createdAt: replicate,
      status: replicate === 2 ? 'rendered' : 'noncomparable',
      experiment: { id: 'original', replicate, replicateCount: 3 },
    }));
    const entries = [
      {
        ...original[2],
        id: 'second-retry-3',
        createdAt: 20,
        status: 'rendered',
        experiment: {
          id: 'second',
          recoveryOfExperimentId: 'original',
          replicate: 3,
          replicateCount: 3,
        },
      },
      {
        ...original[0],
        id: 'first-retry-1',
        createdAt: 10,
        status: 'rendered',
        experiment: {
          id: 'first',
          recoveryOfExperimentId: 'original',
          replicate: 1,
          replicateCount: 3,
        },
      },
      {
        ...original[2],
        id: 'first-retry-3',
        createdAt: 11,
        experiment: {
          id: 'first',
          recoveryOfExperimentId: 'original',
          replicate: 3,
          replicateCount: 3,
        },
      },
      ...original,
    ];
    const groups = groupProteinRunVersions({ id: 'case', versions: entries } as Parameters<
      typeof groupProteinRunVersions
    >[0]);
    expect(groups[0].runs.map((r) => r.id)).toEqual([
      'first-retry-1',
      'original-2',
      'second-retry-3',
    ]);
    expect(groups.at(-1)!.runs.map((r) => r.id)).toEqual([
      'original-1',
      'original-2',
      'original-3',
    ]);
  });

  it('completes a partial technical recovery with the unchanged successful parent slots', () => {
    const entries = [1, 2, 3].map((replicate) => ({
      id: `original-${replicate}`,
      promptLabel: 'V12',
      promptInstructions: 'Same guidance',
      createdAt: replicate,
      experiment: { id: 'original', replicate, replicateCount: 3 },
      status: replicate === 1 ? 'noncomparable' : 'rendered',
    }));
    entries.push({
      ...entries[0],
      id: 'retry-1',
      createdAt: 10,
      status: 'rendered',
      experiment: {
        id: 'recovery',
        recoveryOfExperimentId: 'original',
        replicate: 1,
        replicateCount: 3,
      },
    } as (typeof entries)[number]);
    const groups = groupProteinRunVersions({ id: 'case', versions: entries } as Parameters<
      typeof groupProteinRunVersions
    >[0]);
    expect(groups.map((group) => group.runs.map((run) => run.id))).toEqual([
      ['retry-1', 'original-2', 'original-3'],
      ['original-1', 'original-2', 'original-3'],
    ]);
    expect(groups[0]).toMatchObject({ id: 'retry-1', experimentId: 'original' });
    expect(groups[1].runs[0].status).toBe('noncomparable');
  });

  it('groups prompt versions separately from their explicit repeat numbers', () => {
    const entries = ['V10', 'V11'].flatMap((promptLabel, version) =>
      [3, 1, 2].map((replicate) => ({
        id: `${promptLabel}-${replicate}`,
        promptLabel,
        promptInstructions: promptLabel,
        createdAt: version * 100 + replicate,
        experiment: { id: 'experiment-one', replicate, replicateCount: 3 },
      }))
    ) as Parameters<typeof sortProteinRunEntries>[0];
    const groups = groupProteinRunVersions({ id: 'kcsa', versions: entries });
    expect(groups.map((group) => group.label)).toEqual(['V11', 'V10']);
    expect(groups.map((group) => group.runs.map((run) => run.experiment?.replicate))).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(new Set(groups.flatMap((group) => group.runs.map((run) => run.id))).size).toBe(6);
  });

  it('joins prompt trials, deduplicated harness outcomes, and unassigned saved views without inventing chats', () => {
    const index = buildProteinRunIndex({
      starts: [{ id: 'start-kcsa', trial }],
      results: [
        {
          id: 'result-kcsa',
          trial,
          status: 'rendered',
          observation: 'Scene saved.',
          referenceIds: ['view-prompt'],
          routeKey: '["cli","codex-sdk"]',
          recordedAt: 120,
          promptSnapshot: {
            version: 1,
            conversationId: trial.conversationId,
            turnId: 'turn-kcsa',
            channel: 'cli-seed',
            prompt: 'Exact app-sent prompt',
            continuationPrompt: 'Exact continuation prompt',
            additionalAgentInstructions: null,
            capturedAt: 110,
            scenePolicy: {
              id: 'mvs-agent-scene-v1',
              enforcedConstraints: [
                {
                  id: 'background-locked',
                  label: 'Background locked',
                  errorCode: 'MVS_BACKGROUND_LOCKED',
                  enforcement: 'Agent scene application',
                },
              ],
            },
          },
        },
      ],
      harnessRecords: [
        {
          id: 'batch-new',
          title: 'New comparison',
          createdAt: 300,
          comparison: {
            version: 2,
            cases: [
              {
                id: 'kcsa',
                title: 'KcsA',
                question: trial.question,
                outcomes: [
                  {
                    id: 'molstar',
                    label: 'Molstar-MCP',
                    provenance: 'native-code',
                    referenceId: 'view-harness',
                    sourceUrl: 'https://example.org/molstar',
                    runEvidence: 'Executed native scene builder.',
                  },
                ],
              },
            ],
          },
        },
        {
          id: 'batch-old',
          title: 'Old comparison',
          createdAt: 200,
          comparison: {
            version: 2,
            cases: [
              {
                id: 'kcsa',
                title: 'KcsA',
                question: trial.question,
                outcomes: [
                  {
                    id: 'molstar',
                    label: 'Molstar-MCP',
                    provenance: 'native-code',
                    referenceId: 'view-harness',
                    sourceUrl: 'https://example.org/molstar',
                    runEvidence: 'Earlier record.',
                  },
                ],
              },
            ],
          },
        },
      ],
      savedViews: [
        {
          id: 'view-prompt',
          label: 'Prompt output',
          createdAt: 120,
          pdbId: '1K4C',
          conversationId: 'chat-kcsa',
          conversationCount: 1,
        },
        {
          id: 'view-harness',
          label: 'Harness output',
          createdAt: 200,
          pdbId: '1K4C',
          conversationId: null,
          conversationCount: 0,
        },
        {
          id: 'view-older',
          label: 'Older saved view',
          createdAt: 50,
          pdbId: '1K4C',
          conversationId: 'chat-older',
          conversationCount: 1,
        },
      ],
    });

    expect(index.promptTrials).toHaveLength(1);
    expect(index.promptTrials[0]).toMatchObject({
      id: 'prompt:start-kcsa',
      conversationId: 'chat-kcsa',
      outputIds: ['view-prompt'],
      promptCapture: 'sent-prompt',
      sentPrompt: 'Exact app-sent prompt',
      status: 'rendered',
      continuationPrompt: 'Exact continuation prompt',
      promptLabel: 'Claim + camera + appearance · v1',
      harnessLabel: 'DNAForge MolViewSpec',
      routeLabel: 'cli · codex-sdk',
      scenePolicy: expect.objectContaining({ id: 'mvs-agent-scene-v1' }),
    });
    expect(index.harnessOutcomes).toHaveLength(1);
    expect(index.harnessOutcomes[0]).toMatchObject({
      id: 'harness:view-harness',
      conversationId: null,
      outputIds: ['view-harness'],
      recordCount: 2,
      evidence: 'Executed native scene builder.',
      promptLabel: 'Prompt not recorded',
      harnessLabel: 'Molstar-MCP',
    });
    expect(index.otherSavedViews).toEqual([
      expect.objectContaining({
        id: 'saved:view-older',
        conversationId: 'chat-older',
        outputIds: ['view-older'],
      }),
    ]);
  });

  it('keeps a started trial visible even when no result or saved view exists', () => {
    const index = buildProteinRunIndex({
      starts: [{ id: 'start-kcsa', trial }],
      results: [],
      harnessRecords: [],
      savedViews: [],
    });
    expect(index.promptTrials[0]).toMatchObject({
      status: 'started',
      outputIds: [],
      conversationId: 'chat-kcsa',
    });
  });

  it('shows the first authored sentence for an editable prompt variant', () => {
    const custom = {
      ...trial,
      profileId: 'custom:visual-evidence',
      profileLabel: 'Visual evidence first',
      promptInstructions:
        'Fixed protein benchmark context (v1): use 1K4C.\nPrompt module custom:visual-evidence:\nBefore saving, inspect screenshots at chat-card size. Remove labels that cover the molecular evidence.\nPinned coordinate fixtures for this conversation:\n1K4C',
    };
    const index = buildProteinRunIndex({
      starts: [{ id: 'start-custom', trial: custom }],
      results: [],
      harnessRecords: [],
      savedViews: [],
    });
    expect(index.promptTrials[0].promptSummary).toBe(
      'Before saving, inspect screenshots at chat-card size.'
    );
  });

  it('sorts independent run columns without changing which view belongs to a row', () => {
    const entries = [
      {
        id: 'older',
        question: 'Z question',
        createdAt: 10,
        promptLabel: 'Camera',
        harnessLabel: 'Burette',
        status: 'failed',
        outputIds: ['old-view'],
      },
      {
        id: 'newer',
        question: 'A question',
        createdAt: 20,
        promptLabel: 'Appearance',
        harnessLabel: 'Molstar-MCP',
        status: 'rendered',
        outputIds: ['new-view'],
      },
    ] as Parameters<typeof sortProteinRunEntries>[0];
    expect(sortProteinRunEntries(entries, 'run', 'desc').map((entry) => entry.id)).toEqual([
      'newer',
      'older',
    ]);
    expect(sortProteinRunEntries(entries, 'question', 'desc').map((entry) => entry.id)).toEqual([
      'older',
      'newer',
    ]);
    expect(
      sortProteinRunEntries(entries, 'prompt', 'asc').map((entry) => entry.outputIds[0])
    ).toEqual(['new-view', 'old-view']);
    expect(sortProteinRunEntries(entries, 'harness', 'asc').map((entry) => entry.id)).toEqual([
      'older',
      'newer',
    ]);
  });
});
