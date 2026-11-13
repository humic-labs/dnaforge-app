import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readMolecularPromptTrial,
  writeMolecularTrialSentPromptSnapshot,
} from './molecular-prompt-trials';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn(),
  saveStart: vi.fn(),
  saveResult: vi.fn(),
  candidates: vi.fn(),
  starts: vi.fn(),
  results: vi.fn(),
  references: vi.fn(),
  messages: vi.fn(),
  turns: vi.fn(),
  messageReferences: vi.fn(),
  send: vi.fn(),
  canvas: {
    findTab: vi.fn(),
    openTab: vi.fn(),
    splitPanel: vi.fn(),
    setActiveTab: vi.fn(),
    focusPanel: vi.fn(),
  },
}));
vi.mock('../../db/molecular-prompt-trials', () => ({
  listMolecularFixtureCandidates: mocks.candidates,
  listMolecularPromptTrialStarts: mocks.starts,
  listMolecularPromptTrialResults: mocks.results,
  saveMolecularPromptTrialStart: mocks.saveStart,
  saveMolecularPromptTrialResult: mocks.saveResult,
}));
vi.mock('../../db/entity-references', () => ({ getEntityReferencesByIds: mocks.references }));
vi.mock('../../db', () => ({
  getMessages: mocks.messages,
  getChatTurns: mocks.turns,
  getMessageReferencesForMessages: mocks.messageReferences,
}));
vi.mock('../../services/sidecar-session', () => ({
  rendererSidecarRequestAuthorityState: async () => 'ready',
}));
vi.mock('../canvas/public/store', () => ({ useCanvasStore: { getState: () => mocks.canvas } }));
vi.mock('./hooks/useChat', () => ({
  useChatStore: { getState: () => ({ sendMessage: mocks.send }) },
}));
vi.mock('../agent-bridge/public/structure-tools', () => ({
  handleMolGetScene: vi.fn(async () => ({ ok: true, scene: '' })),
}));
vi.mock('../page/public/embeds/structure3d/molecularView', () => ({
  coordinateDigest: vi.fn(async (text: string) => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(text).digest('hex');
  }),
  molecularViewSourceDigests: (view: { coordinates: { sha256: string } }) => [
    view.coordinates.sha256,
  ],
  molecularViewAttrs: (_id: string, view: unknown) => view,
  molecularViewFromReferenceData: (data: string) => JSON.parse(data),
  validateMolecularViewCoordinates: vi.fn(async () => undefined),
}));
import {
  runMolecularPromptBatch as runBatch,
  prepareMolecularBatchRoundReview,
  type MolecularBatchInput,
} from './molecular-prompt-batch';
async function runMolecularPromptBatch(input: MolecularBatchInput) {
  input = { ...input, sourceCommit: 'a'.repeat(40) };
  return runBatch({
    ...input,
    roundReview: await prepareMolecularBatchRoundReview(input, {
      systemPrompt: 'Keep the reviewed general prompt.',
      harness: 'Keep this test comparison controlled.',
      guidance: 'Keep the fixed test guidance.',
    }),
  });
}

const fixtureId = '748e6760-42fb-4704-94af-240286343123';
const scene =
  '{"kind":"single","metadata":{"version":"1.0"},"root":{"kind":"root","children":[{"kind":"download","params":{"url":"structure.cif"},"children":[{"kind":"parse","params":{"format":"mmcif"},"children":[{"kind":"structure","params":{"type":"assembly","assembly_id":"1"}}]}]}]}}';
const variants = Array.from({ length: 3 }, (_, index) => ({
  id: `custom:version-${index}`,
  label: `Version ${index}`,
  instructions: 'Fixed general guidance.',
}));

describe('isolated background protein prompt batch', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal('electronAPI', {
      proteinExperimentWorkers: {
        checkAdmission: vi.fn(async () => undefined),
        prepare: mocks.prepare,
        release: mocks.release,
      },
    });
    mocks.canvas.findTab.mockReturnValue({ panelId: 'left', tabId: 'notebook' });
    mocks.prepare.mockImplementation(async (request) => ({
      jobId: request.jobId,
      workerId: 'background-1',
    }));
    mocks.release.mockResolvedValue(undefined);
    mocks.saveStart.mockImplementation(async () => crypto.randomUUID());
    mocks.saveResult.mockResolvedValue(crypto.randomUUID());
    mocks.starts.mockImplementation(async () =>
      mocks.saveStart.mock.calls.map(([trial]) => ({ id: trial.conversationId, trial }))
    );
    mocks.results.mockImplementation(async () =>
      mocks.saveResult.mock.calls.map(([result]) => ({
        ...result,
        id: result.trial.conversationId,
        feedback: [],
      }))
    );
    mocks.candidates.mockResolvedValue([
      {
        referenceId: fixtureId,
        savedViewId: 'saved-view:pin',
        pdbId: '1K4C',
        coordinateSha256: 'a'.repeat(64),
        scene,
      },
    ]);
    mocks.references.mockImplementation(async (ids: string[]) =>
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
              ? scene
              : scene.replace(
                  '\"children\":[',
                  '\"children\":[{\"kind\":\"camera\",\"params\":{\"position\":[0,0,30],\"target\":[0,0,0],\"up\":[0,1,0]}},'
                ),
        }),
      }))
    );
    mocks.messages.mockImplementation(async (id: string) => [
      { id: `message-${id}`, role: 'user', content: readMolecularPromptTrial(id)?.question },
    ]);
    mocks.turns.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000007',
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
    mocks.messageReferences.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, [`output-${id}`]]))
    );
    mocks.send.mockImplementation(async (_question: string, _workspace: null, id: string) => {
      writeMolecularTrialSentPromptSnapshot({
        version: 1,
        conversationId: id,
        turnId: '00000000-0000-4000-8000-000000000007',
        channel: 'hosted-system',
        prompt: 'Exact sent prompt',
        additionalAgentInstructions: null,
        capturedAt: Date.now(),
      });
      return 'accepted';
    });
  });

  it('refuses round completion when completed agent turns only produced chat', async () => {
    mocks.messageReferences.mockResolvedValue(new Map());
    await expect(
      runMolecularPromptBatch({
        caseId: 'kcsa',
        fixtureSelection: { '1K4C': fixtureId },
        variants,
        concurrency: 3,
        notebookPageId: 'notebook',
      })
    ).rejects.toThrow(/round incomplete/i);
    expect(mocks.saveResult).toHaveBeenCalledTimes(3);
    expect(mocks.saveResult.mock.calls.every(([result]) => result.referenceIds.length === 0)).toBe(
      true
    );
    expect(mocks.release).toHaveBeenCalledTimes(3);
  });

  it('runs three attempts concurrently without opening, splitting or activating visible panes', async () => {
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const send = mocks.send.getMockImplementation()!;
    mocks.send.mockImplementation(async (...args: Parameters<typeof send>) => {
      if (++count === 3) release();
      await Promise.race([
        allStarted,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Only two slots started')), 100)
        ),
      ]);
      return send(...args);
    });
    const result = await runMolecularPromptBatch({
      caseId: 'kcsa',
      fixtureSelection: { '1K4C': fixtureId },
      variants,
      concurrency: 3,
      notebookPageId: 'notebook',
    });
    expect(result.completed).toBe(3);
    expect(mocks.prepare).toHaveBeenCalledTimes(3);
    expect(mocks.release).toHaveBeenCalledTimes(3);
    expect(mocks.canvas.openTab).not.toHaveBeenCalled();
    expect(mocks.canvas.splitPanel).not.toHaveBeenCalled();
    expect(mocks.canvas.setActiveTab).not.toHaveBeenCalled();
    expect(mocks.canvas.focusPanel).not.toHaveBeenCalled();
    const trials = mocks.saveStart.mock.calls.map(([trial]) => trial);
    expect(new Set(trials.map((trial) => trial.conversationId)).size).toBe(3);
    expect(new Set(trials.map((trial) => trial.fixtures[0].structureViewId)).size).toBe(3);
    expect(trials.every((trial) => trial.execution?.kind === 'background-worker')).toBe(true);
    expect(trials.every((trial) => trial.execution?.renderProfile?.id === 'dnaforge-detail')).toBe(
      true
    );
  });

  it('resolves an explicitly pinned historical view outside the recent candidate list', async () => {
    mocks.candidates.mockResolvedValue([]);
    const result = await runMolecularPromptBatch({
      caseId: 'kcsa',
      fixtureSelection: { '1K4C': fixtureId },
      variants: variants.slice(0, 1),
      concurrency: 1,
      notebookPageId: 'notebook',
    });
    expect(result.completed).toBe(1);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.saveStart.mock.calls[0][0].fixtures[0]).toMatchObject({
      referenceId: fixtureId,
      coordinateSha256: 'a'.repeat(64),
      structureSignature: '["assembly:1"]',
    });
  });

  it('records a preparation failure and continues the queue without dispatching that failed scene', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('No native canvas'));
    await expect(
      runMolecularPromptBatch({
        caseId: 'kcsa',
        fixtureSelection: { '1K4C': fixtureId },
        variants,
        concurrency: 1,
        notebookPageId: 'notebook',
      })
    ).rejects.toThrow(/Round incomplete: 2\/3/);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.saveResult).toHaveBeenCalledTimes(3);
    expect(mocks.saveResult.mock.calls[0][0]).toMatchObject({
      status: 'failed',
      observation: expect.stringContaining('No native canvas'),
      referenceIds: [],
      promptSnapshot: null,
      failure: { stage: 'preparation', agentDispatched: false },
    });
    expect(mocks.saveResult.mock.calls.slice(1).every(([result]) => !result.failure)).toBe(true);
  });

  it('recovers only requested slots as fresh isolated chats with their original replicate numbers', async () => {
    const input = {
      caseId: 'kcsa' as const,
      fixtureSelection: { '1K4C': fixtureId },
      variants,
      repeats: 3,
      concurrency: 2,
      notebookPageId: 'notebook',
    };
    await expect(
      runMolecularPromptBatch({
        ...input,
        attempts: [{ caseId: 'kcsa', variantId: variants[0].id, replicate: 4 }],
      })
    ).rejects.toThrow('unique members');
    expect(mocks.prepare).not.toHaveBeenCalled();
    await expect(
      runMolecularPromptBatch({
        ...input,
        attempts: [
          { caseId: 'kcsa', variantId: variants[0].id, replicate: 2 },
          { caseId: 'kcsa', variantId: variants[2].id, replicate: 3 },
        ],
      })
    ).rejects.toThrow(/Round incomplete: 2\/9/);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const trials = mocks.saveStart.mock.calls.map(([trial]) => trial);
    expect(trials.map((trial) => trial.experiment.replicate)).toEqual([2, 3]);
    expect(trials.every((trial) => trial.experiment.replicateCount === 3)).toBe(true);
    expect(new Set(trials.map((trial) => trial.conversationId)).size).toBe(2);
  });
});
