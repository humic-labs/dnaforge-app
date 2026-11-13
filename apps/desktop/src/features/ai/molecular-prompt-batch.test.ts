/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readMolecularPromptTrial,
  writeMolecularTrialSentPromptSnapshot,
} from './molecular-prompt-trials';
import { MVS_AGENT_SCENE_POLICY } from '../page/public/embeds/structure3d/molstar/agentScenePolicy';

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(),
  listResults: vi.fn(),
  listStarts: vi.fn(),
  saveStart: vi.fn(),
  saveResult: vi.fn(),
  getReferences: vi.fn(),
  getScene: vi.fn(),
  getMessages: vi.fn(),
  getChatTurns: vi.fn(),
  getMessageReferences: vi.fn(),
  sendMessage: vi.fn(),
  agentConfiguration: vi.fn(),
  openChatTab: vi.fn(),
  prepareWorker: vi.fn(),
  releaseWorker: vi.fn(),
  canvasState: {
    panels: {} as Record<
      string,
      { activeTabId: string | null; tabs: Array<{ id: string; entityId: string }> }
    >,
    findTab: vi.fn(),
    agentContentPlacement: vi.fn(),
    splitPanel: vi.fn(),
    openTab: vi.fn(),
    closeTab: vi.fn(),
    closePanel: vi.fn(),
    setActiveTab: vi.fn(),
    focusPanel: vi.fn(),
    openChatTab: vi.fn(),
  },
}));

vi.mock('../../db/molecular-prompt-trials', () => ({
  listMolecularFixtureCandidates: mocks.listCandidates,
  listMolecularPromptTrialResults: mocks.listResults,
  listMolecularPromptTrialStarts: mocks.listStarts,
  saveMolecularPromptTrialStart: mocks.saveStart,
  saveMolecularPromptTrialResult: mocks.saveResult,
}));
vi.mock('../../db/entity-references', () => ({ getEntityReferencesByIds: mocks.getReferences }));
vi.mock('../../db', () => ({
  getMessages: mocks.getMessages,
  getChatTurns: mocks.getChatTurns,
  getMessageReferencesForMessages: mocks.getMessageReferences,
}));
vi.mock('../agent-bridge/public/structure-tools', () => ({ handleMolGetScene: mocks.getScene }));
vi.mock('../../services/sidecar-session', () => ({
  rendererSidecarRequestAuthorityState: async () => 'ready',
}));
vi.mock('./hooks/useChat', () => ({
  useChatStore: { getState: () => ({ sendMessage: mocks.sendMessage }) },
}));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: { getState: () => mocks.canvasState },
}));
vi.mock('../page/public/embeds/structure3d/molecularView', async () => ({
  molecularViewSourceDigests: (await import('../page/public/embeds/structure3d/molecularView'))
    .molecularViewSourceDigests,
  coordinateDigest: vi.fn(async (text: string) => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(text).digest('hex');
  }),
  molecularViewAttrs: (id: string) => ({ structureViewId: id }),
  molecularViewFromReferenceData: (data: string) => JSON.parse(data),
  validateMolecularViewCoordinates: vi.fn(async () => undefined),
}));

import {
  runMolecularPromptBatch as runUnreviewedBatch,
  prepareMolecularBatchRoundReview,
  type MolecularBatchInput,
} from './molecular-prompt-batch';

const decisions = {
  systemPrompt: 'Keep the general prompt after reviewing the corpus.',
  harness: 'Use exact native coordinate ownership and preserved inputs.',
  guidance: 'Keep guidance fixed for this controlled unit fixture.',
};
async function runMolecularPromptBatch(input: MolecularBatchInput) {
  input = { ...input, sourceCommit: 'a'.repeat(40) };
  return runUnreviewedBatch({
    ...input,
    roundReview: await prepareMolecularBatchRoundReview(input, decisions),
  });
}

const fixtureScene =
  '{"kind":"single","metadata":{"version":"1.0"},"root":{"kind":"root","children":[{"kind":"download","params":{"url":"structure.cif"},"children":[{"kind":"parse","params":{"format":"mmcif"},"children":[{"kind":"structure","params":{"type":"assembly","assembly_id":"1"}}]}]}]}}';
const fixtureId = '748e6760-42fb-4704-94af-240286343123';

describe('notebook protein prompt batch', () => {
  it('refuses a round without an evidence-bound review before opening a worker or dispatching an agent', async () => {
    await expect(
      runUnreviewedBatch({
        caseId: 'kcsa',
        fixtureSelection: { '1K4C': fixtureId },
        variants: [{ id: 'control', label: 'Control', instructions: 'General guidance' }],
        notebookPageId: 'page-protein-prompt-trials-v1',
      })
    ).rejects.toThrow(/Review the corpus/);
    expect(mocks.prepareWorker).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects a stale review after feedback or run controls change without dispatch', async () => {
    const input: MolecularBatchInput = {
      caseId: 'kcsa',
      fixtureSelection: { '1K4C': fixtureId },
      variants: [{ id: 'control', label: 'Control', instructions: 'General guidance' }],
      notebookPageId: 'page-protein-prompt-trials-v1',
    };
    const roundReview = await prepareMolecularBatchRoundReview(input, decisions);
    await expect(runUnreviewedBatch({ ...input, repeats: 3, roundReview })).rejects.toThrow(
      /changed after this review/
    );
    expect(mocks.prepareWorker).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects replaced fixture bytes even when the saved reference ID stays the same', async () => {
    const input: MolecularBatchInput = {
      caseId: 'kcsa',
      fixtureSelection: { '1K4C': fixtureId },
      variants: [{ id: 'control', label: 'Control', instructions: 'Fixed guidance' }],
      notebookPageId: 'page-protein-prompt-trials-v1',
    };
    const roundReview = await prepareMolecularBatchRoundReview(input, decisions);
    const read = mocks.getReferences.getMockImplementation()!;
    mocks.getReferences.mockImplementation(async (ids: string[]) => {
      const rows = await read(ids);
      return rows.map((row: { data: string; id: string }) => {
        const view = JSON.parse(row.data);
        view.coordinates.sha256 = 'c'.repeat(64);
        return { ...row, data: JSON.stringify(view) };
      });
    });
    mocks.sendMessage.mockResolvedValue('not-started');
    await expect(runUnreviewedBatch({ ...input, roundReview })).rejects.toThrow(
      /changed after this review/
    );
    expect(mocks.saveStart).not.toHaveBeenCalled();
    expect(mocks.prepareWorker).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.agentConfiguration.mockReturnValue(undefined);
    vi.stubGlobal('electronAPI', {
      proteinExperimentWorkers: {
        checkAdmission: vi.fn(async () => undefined),
        prepare: mocks.prepareWorker,
        release: mocks.releaseWorker,
      },
    });
    mocks.prepareWorker.mockImplementation(async (request) => ({
      jobId: request.jobId,
      workerId: request.jobId,
    }));
    mocks.releaseWorker.mockResolvedValue(undefined);
    mocks.listCandidates.mockResolvedValue([
      {
        referenceId: fixtureId,
        savedViewId: 'saved-view:fixed-kcsa',
        label: 'Pinned KcsA',
        pdbId: '1K4C',
        coordinateSha256: 'a'.repeat(64),
        scene: fixtureScene,
      },
    ]);
    mocks.listResults.mockImplementation(async () =>
      mocks.saveResult.mock.calls.map(([result]) => ({
        ...result,
        id: result.trial.conversationId,
        feedback: [],
      }))
    );
    mocks.listStarts.mockImplementation(async () =>
      mocks.saveStart.mock.calls.map(([trial]) => ({ id: trial.conversationId, trial }))
    );
    const panels: Record<
      string,
      { activeTabId: string | null; tabs: Array<{ id: string; entityId: string }> }
    > = {
      left: {
        activeTabId: 'notebook',
        tabs: [{ id: 'notebook', entityId: 'page-protein-prompt-trials-v1' }],
      },
      right: {
        activeTabId: 'original',
        tabs: [{ id: 'original', entityId: 'saved-view:original' }],
      },
    };
    mocks.canvasState = {
      panels,
      findTab: vi.fn(() => ({ panelId: 'left', tabId: 'notebook' })),
      agentContentPlacement: vi.fn(() => ({ targetPanelId: 'right' })),
      splitPanel: vi.fn(() => {
        panels.worker = { activeTabId: null, tabs: [] };
        return 'worker';
      }),
      openTab: vi.fn((panelId: string, data: { entityId: string }) => {
        const tabId = data.entityId;
        panels[panelId].tabs.push({ id: tabId, entityId: data.entityId });
        panels[panelId].activeTabId = tabId;
        return tabId;
      }),
      closeTab: vi.fn((panelId: string, tabId: string) => {
        panels[panelId].tabs = panels[panelId].tabs.filter((tab) => tab.id !== tabId);
      }),
      closePanel: vi.fn((panelId: string) => {
        delete panels[panelId];
      }),
      setActiveTab: vi.fn((panelId: string, tabId: string) => {
        panels[panelId].activeTabId = tabId;
      }),
      focusPanel: vi.fn(),
      openChatTab: mocks.openChatTab,
    };
    mocks.saveStart.mockImplementation(async () => crypto.randomUUID());
    mocks.saveResult.mockImplementation(async () => crypto.randomUUID());
    mocks.getReferences.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        entity_type: 'structure',
        locator: `entity://structure/saved-view:${id}`,
        data: JSON.stringify({
          coordinates: {
            sha256: 'a'.repeat(64),
            format: 'cif',
            text: 'unit-test-pinned-coordinate-bytes',
          },
          source: { sourceId: '1K4C' },
          scientificReview: { questionCoverage: { unanswered: [] } },
          scene:
            id === fixtureId
              ? fixtureScene
              : fixtureScene.replace(
                  '\"children\":[',
                  '\"children\":[{\"kind\":\"camera\",\"params\":{\"position\":[0,0,30],\"target\":[0,0,0],\"up\":[0,1,0]}},'
                ),
        }),
      }))
    );
    mocks.getScene.mockResolvedValue({ ok: true, scene: fixtureScene });
    mocks.getMessageReferences.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, [`output-${id}`]]))
    );
    mocks.getMessages.mockImplementation(async (id: string) => [
      {
        id: `message-${id}`,
        role: 'user',
        content: readMolecularPromptTrial(id)?.question,
      },
    ]);
    mocks.getChatTurns.mockImplementation(async (id: string) => [
      {
        id: '00000000-0000-4000-8000-000000000007',
        conversation_id: id,
        status: 'completed',
        route_kind: 'cli',
        host_id: 'codex-sdk',
        provider: null,
        model: null,
        transport: null,
        authority_profile_id: null,
        permission_mode: null,
      },
    ]);
    let sendCount = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    mocks.sendMessage.mockImplementation(async (question: string, _workspace: null, id: string) => {
      sendCount++;
      if (sendCount === 2) releaseBoth();
      await Promise.race([
        bothStarted,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The two agent turns did not start in parallel.')),
            1000
          )
        ),
      ]);
      writeMolecularTrialSentPromptSnapshot({
        version: 1,
        conversationId: id,
        turnId: '00000000-0000-4000-8000-000000000007',
        channel: 'hosted-system',
        prompt: `Exact prompt for ${readMolecularPromptTrial(id)?.profileLabel}: ${question}`,
        additionalAgentInstructions: null,
        ...(mocks.agentConfiguration(readMolecularPromptTrial(id))
          ? { agentConfiguration: mocks.agentConfiguration(readMolecularPromptTrial(id)) }
          : {}),
        capturedAt: Date.now(),
      });
      return 'accepted';
    });
  });

  it.each([
    { error: "You've hit your usage limit.", expectedStarts: 1 },
    { error: 'This content was flagged for possible biological risk.', expectedStarts: 3 },
  ])(
    'bounds dispatch after a terminal provider outcome: $error',
    async ({ error, expectedStarts }) => {
      const readTurns = mocks.getChatTurns.getMockImplementation()!;
      mocks.getChatTurns.mockImplementation(async (id: string) =>
        (await readTurns(id)).map((turn: object) => ({ ...turn, status: 'failed', error }))
      );
      mocks.sendMessage.mockImplementation(
        async (question: string, _workspace: null, id: string) => {
          writeMolecularTrialSentPromptSnapshot({
            version: 1,
            conversationId: id,
            turnId: '00000000-0000-4000-8000-000000000007',
            channel: 'hosted-system',
            prompt: question,
            additionalAgentInstructions: null,
            capturedAt: Date.now(),
          });
          return 'accepted';
        }
      );
      await expect(
        runMolecularPromptBatch({
          caseId: 'kcsa',
          fixtureSelection: { '1K4C': fixtureId },
          variants: [{ id: 'control', label: 'Control', instructions: 'General guidance' }],
          repeats: 3,
          concurrency: 1,
          notebookPageId: 'page-protein-prompt-trials-v1',
        })
      ).rejects.toThrow(/Round incomplete/);
      expect(mocks.sendMessage).toHaveBeenCalledTimes(expectedStarts);
      expect(mocks.prepareWorker).toHaveBeenCalledTimes(expectedStarts);
      expect(mocks.releaseWorker).toHaveBeenCalledTimes(expectedStarts);
      expect(mocks.saveResult).toHaveBeenCalledTimes(expectedStarts);
      expect(mocks.saveStart.mock.calls[0][0].experiment.requiredSlots).toHaveLength(3);
    }
  );

  it.each(['declared-effort', 'unplanned-model', 'incorrect-effort'] as const)(
    'compares immutable effort assignments while retaining configuration guards: %s',
    async (scenario) => {
      mocks.agentConfiguration.mockImplementation((trial) => ({
        transport: 'codex-sdk',
        model:
          scenario === 'unplanned-model' && trial.profileId === 'custom:xhigh'
            ? 'different-model'
            : 'gpt-6-astra',
        reasoningEffort:
          scenario === 'incorrect-effort' && trial.profileId === 'custom:xhigh'
            ? 'high'
            : trial.execution.reasoningEffort,
        serviceTier: null,
        personality: null,
      }));
      const input: MolecularBatchInput = {
        caseId: 'kcsa',
        fixtureSelection: { '1K4C': fixtureId },
        variants: ['high', 'xhigh'].map((effort) => ({
          id: `custom:${effort}`,
          label: effort,
          instructions: 'Use identical scientific guidance.',
        })),
        reasoningEffortByVariant: { 'custom:high': 'high', 'custom:xhigh': 'xhigh' },
        notebookPageId: 'page-protein-prompt-trials-v1',
      };
      const running = runMolecularPromptBatch(input);
      if (scenario === 'declared-effort') {
        expect((await running).completed).toBe(2);
        expect(mocks.saveResult.mock.calls.map(([record]) => record.status)).toEqual([
          'rendered',
          'rendered',
        ]);
        const routeKeys = mocks.saveResult.mock.calls.map(([record]) => record.routeKey);
        expect(routeKeys[0]).not.toBe(routeKeys[1]);
      } else {
        await expect(running).rejects.toThrow(/Round incomplete/);
        expect(
          mocks.saveResult.mock.calls.some(([record]) => record.status === 'noncomparable')
        ).toBe(true);
      }
      expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    }
  );

  it('dispatches two prompt variants concurrently to isolated workers while preserving the visible panes', async () => {
    const stages: string[] = [];
    const result = await runMolecularPromptBatch({
      caseId: 'kcsa',
      fixtureSelection: { '1K4C': fixtureId },
      variants: [
        { id: 'custom:one', label: 'One', instructions: 'Focus on the carbonyl ring.' },
        { id: 'custom:two', label: 'Two', instructions: 'Show waters at the pore entrance.' },
      ],
      notebookPageId: 'page-protein-prompt-trials-v1',
      onProgress: (progress) => stages.push(`${progress.index}:${progress.stage}`),
    });
    expect(result.completed).toBe(2);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.saveResult).toHaveBeenCalledTimes(2);
    expect(mocks.openChatTab).not.toHaveBeenCalled();
    expect(mocks.prepareWorker).toHaveBeenCalledTimes(2);
    expect(mocks.releaseWorker).toHaveBeenCalledTimes(2);
    expect(mocks.canvasState.splitPanel).not.toHaveBeenCalled();
    expect(mocks.canvasState.openTab).not.toHaveBeenCalled();
    const trials = mocks.saveStart.mock.calls.map(([trial]) => trial);
    expect(trials.map((trial) => trial.question)).toEqual([trials[0].question, trials[0].question]);
    expect(trials[0].fixtures[0].coordinateSha256).toBe(trials[1].fixtures[0].coordinateSha256);
    expect(trials[0].fixtures[0].structureViewId).not.toBe(trials[1].fixtures[0].structureViewId);
    expect(trials[0].fixtures[0].savedViewId).toBeUndefined();
    expect(mocks.prepareWorker.mock.calls[0][0].fixtures[0]).toMatchObject({
      structureViewId: trials[0].fixtures[0].structureViewId,
      attrs: { molecularDocumentDraftId: trials[0].fixtures[0].documentDraftId },
    });
    expect(trials[0].promptInstructions).toContain('Focus on the carbonyl ring.');
    expect(trials[1].promptInstructions).toContain('Show waters at the pore entrance.');
    expect(
      mocks.saveResult.mock.calls.map(([record]) => record.promptSnapshot.scenePolicy.id)
    ).toEqual([MVS_AGENT_SCENE_POLICY.id, MVS_AGENT_SCENE_POLICY.id]);
    expect(
      mocks.saveResult.mock.calls.every(([record]) =>
        record.promptSnapshot.scenePolicy.enforcedConstraints.some(
          (rule: { id: string }) => rule.id === 'computed-interaction-contact-retention'
        )
      )
    ).toBe(true);
    expect(stages).toContain('1:recorded');
    expect(stages).toContain('2:recorded');
  });

  it('records three separate attempts per version with fresh conversations and viewer identities', async () => {
    const experimentId = '00000000-0000-4000-8000-000000000008';
    await runMolecularPromptBatch({
      caseId: 'kcsa',
      fixtureSelection: { '1K4C': fixtureId },
      variants: [
        { id: 'custom:baseline', label: 'V10', instructions: 'Baseline guidance.' },
        {
          id: 'custom:candidate',
          label: 'V11',
          instructions: 'Baseline guidance. Conditional detail.',
        },
      ],
      repeats: 3,
      experimentId,
      notebookPageId: 'page-protein-prompt-trials-v1',
    });
    const trials = mocks.saveStart.mock.calls.map(([value]) => value);
    expect(trials).toHaveLength(6);
    expect(new Set(trials.map((t) => t.conversationId)).size).toBe(6);
    expect(new Set(trials.map((t) => t.fixtures[0].structureViewId)).size).toBe(6);
    for (const label of ['V10', 'V11']) {
      const attempts = trials.filter((t) => t.profileLabel === label);
      expect(attempts.map((t) => t.experiment)).toEqual(
        [1, 2, 3].map((replicate) => ({
          id: experimentId,
          mode: 'full-round',
          replicate,
          replicateCount: 3,
          requiredSlots: trials[0].experiment.requiredSlots,
        }))
      );
      expect(
        attempts.map((t) => readMolecularPromptTrial(t.conversationId)?.experiment?.replicate)
      ).toEqual([1, 2, 3]);
    }
    expect(mocks.saveResult).toHaveBeenCalledTimes(6);
    expect(mocks.canvasState.panels.right.activeTabId).toBe('original');
    expect(mocks.canvasState.panels.worker).toBeUndefined();
  });

  it('runs one unchanged prompt across different questions in parallel without treating their fixed inputs as drift', async () => {
    const groelFixtureId = '648e6760-42fb-4704-94af-240286343124';
    const groelScene = fixtureScene.replace(
      '"type":"assembly","assembly_id":"1"',
      '"type":"model"'
    );
    const outputIds = { '1K4C': 'output-kcsa', '1AON': 'output-groel' };
    const viewFor = (pdbId: string, authored: boolean) => ({
      coordinates: {
        sha256: (pdbId === '1K4C' ? 'a' : 'd').repeat(64),
        format: 'cif',
        text: 'unit-test-pinned-coordinate-bytes',
      },
      source: { sourceId: pdbId },
      scientificReview: { questionCoverage: { unanswered: [] } },
      scene: authored
        ? (pdbId === '1K4C' ? fixtureScene : groelScene).replace(
            '"children":[',
            '"children":[{"kind":"camera","params":{"target":[0,0,0],"position":[0,0,30],"up":[0,1,0]},"custom":{"authored":true}},'
          )
        : pdbId === '1K4C'
          ? fixtureScene
          : groelScene,
    });
    mocks.listCandidates.mockResolvedValue([
      {
        referenceId: fixtureId,
        savedViewId: 'saved-view:fixed-kcsa',
        label: 'Pinned KcsA',
        pdbId: '1K4C',
        coordinateSha256: 'a'.repeat(64),
        scene: fixtureScene,
      },
      {
        referenceId: groelFixtureId,
        savedViewId: 'saved-view:fixed-groel',
        label: 'Pinned GroEL',
        pdbId: '1AON',
        coordinateSha256: 'd'.repeat(64),
        scene: groelScene,
      },
    ]);
    mocks.getReferences.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        entity_type: 'structure',
        locator: `entity://structure/saved-view:${id}`,
        data: JSON.stringify(
          viewFor(
            id === fixtureId || id === outputIds['1K4C'] ? '1K4C' : '1AON',
            Object.values(outputIds).includes(id)
          )
        ),
      }))
    );
    mocks.getScene.mockImplementation(async ({ structureViewId }: { structureViewId: string }) => {
      const opened = mocks.canvasState.openTab.mock.calls.find(
        ([, data]: [string, { entityId: string }]) => data.entityId === structureViewId
      );
      return { ok: true, scene: opened?.[1].label?.includes('1AON') ? groelScene : fixtureScene };
    });
    mocks.getMessages.mockImplementation(async (id: string) => {
      const trial = readMolecularPromptTrial(id)!;
      return [{ id: `message-${id}`, role: 'user', content: trial.question }];
    });
    mocks.getMessageReferences.mockImplementation(
      async (messageIds: string[]) =>
        new Map(
          messageIds.map((id) => {
            const trial = readMolecularPromptTrial(id.replace('message-', ''))!;
            return [id, [outputIds[trial.fixtures[0].pdbId as keyof typeof outputIds]]];
          })
        )
    );
    const variant = {
      id: 'custom:shared',
      label: 'Shared guidance',
      instructions: 'Use element colors for atomic detail. Carbon may carry group colors.',
    };
    const result = await runMolecularPromptBatch({
      caseId: 'kcsa',
      fixtureSelection: { '1K4C': fixtureId },
      variants: [variant],
      additionalCases: [
        { caseId: 'groel-asymmetry', fixtureSelection: { '1AON': groelFixtureId } },
      ],
      notebookPageId: 'page-protein-prompt-trials-v1',
    });

    expect(result.completed).toBe(2);
    expect(result.rendered).toBe(2);
    const trials = mocks.saveStart.mock.calls.map(([trial]) => trial);
    expect(trials.map((trial) => trial.caseId)).toEqual(['kcsa', 'groel-asymmetry']);
    expect(trials[0].question).not.toBe(trials[1].question);
    expect(trials.map((trial) => trial.profileId)).toEqual([variant.id, variant.id]);
    for (const trial of trials) expect(trial.promptInstructions).toContain(variant.instructions);
    expect(mocks.saveResult.mock.calls.map(([record]) => record.status)).toEqual([
      'rendered',
      'rendered',
    ]);
    expect(mocks.canvasState.splitPanel).not.toHaveBeenCalled();
    expect(mocks.prepareWorker).toHaveBeenCalledTimes(2);
    expect(mocks.canvasState.panels.right.activeTabId).toBe('original');
    expect(mocks.canvasState.panels.worker).toBeUndefined();
  });

  it('records native preparation failure without dispatching a turn or changing the review panes', async () => {
    mocks.prepareWorker.mockRejectedValueOnce(new Error('Bad scene.'));
    await expect(
      runMolecularPromptBatch({
        caseId: 'kcsa',
        fixtureSelection: { '1K4C': fixtureId },
        variants: [{ id: 'custom:one', label: 'One', instructions: 'Show the filter.' }],
        notebookPageId: 'page-protein-prompt-trials-v1',
      })
    ).rejects.toThrow(/Round incomplete/);
    expect(mocks.saveResult.mock.calls[0][0]).toMatchObject({
      status: 'failed',
      observation: 'Bad scene.',
      failure: { stage: 'preparation', agentDispatched: false },
    });
    expect(mocks.canvasState.closeTab).not.toHaveBeenCalled();
    expect(mocks.releaseWorker).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('releases the prepared worker and retains the failure when the agent turn never starts', async () => {
    mocks.sendMessage.mockResolvedValueOnce('rejected');
    mocks.getChatTurns.mockResolvedValue([]);
    await expect(
      runMolecularPromptBatch({
        caseId: 'kcsa',
        fixtureSelection: { '1K4C': fixtureId },
        variants: [{ id: 'custom:one', label: 'One', instructions: 'Show the filter.' }],
        notebookPageId: 'page-protein-prompt-trials-v1',
      })
    ).rejects.toThrow(/Round incomplete/);
    expect(mocks.saveResult.mock.calls[0][0]).toMatchObject({
      status: 'failed',
      observation: 'The agent could not start this trial.',
    });
    expect(mocks.releaseWorker).toHaveBeenCalledTimes(1);
    expect(mocks.canvasState.closeTab).not.toHaveBeenCalled();
  });
});
