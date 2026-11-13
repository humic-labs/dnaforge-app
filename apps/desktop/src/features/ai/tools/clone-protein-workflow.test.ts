import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  createSession: vi.fn(),
  prepare: vi.fn(),
  register: vi.fn(),
  viewState: vi.fn(),
  sessions: [] as Array<{
    id: string;
    alignmentOperation: { id: string; status: string };
    tracks: unknown[];
  }>,
  listeners: new Set<() => void>(),
  checkStaleness: vi.fn(),
}));
vi.mock('./path-utils', () => ({
  loadSequenceDocumentBiologyFile: mocks.load,
  getUserFolders: (folders: unknown) => folders,
  resolveMultiRootPath: (_folders: unknown, path: string) => ({
    absolutePath: `/project/${path}`,
    folder: { path: '/project' },
  }),
}));
vi.mock('../../../platform', () => ({ platform: () => ({ fs: { stat: mocks.stat } }) }));
vi.mock('./open-tab', () => ({ openTabInCanvas: mocks.open }));
vi.mock('../../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({
      findTab: () => ({ panelId: 'panel', tabId: 'tab' }),
      setTabViewState: mocks.viewState,
    }),
    subscribe: () => () => undefined,
  },
}));
vi.mock('../../alignment-manager/public/store', () => ({
  useVerificationStore: {
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
    getState: () => ({
      verificationState: { reference: { sessions: mocks.sessions } },
      registerReferenceSource: mocks.register,
      createSession: mocks.createSession,
      prepareSessionAlignments: mocks.prepare,
      checkStaleness: mocks.checkStaleness,
      staleReferences: {},
      staleSessionIds: {},
    }),
  },
}));
vi.mock('../../../services/managed-operations', () => ({ managedOperations: {} }));
vi.mock('../../alignment-manager/public/inspect-mutation-protein', () => ({
  inspectMutationProtein: vi.fn(),
}));
vi.mock('../../structure-drawer/public/state/selected-codon-registry', () => ({
  getWorkspaceResidueSelectionsStore: vi.fn(),
}));
vi.mock('../../structure-drawer/public/structure-inspection', () => ({
  structureInspectionId: vi.fn(),
}));
vi.mock('../../structure-drawer/public/inspection-allele', () => ({
  selectInspectionProteinProduct: vi.fn(),
  inspectionProteinProductSummary: vi.fn(),
}));
import {
  createAnalyzeCloneTool as originalCreateAnalyzeCloneTool,
  createGetCloneAnalysisTool as originalCreateGetCloneAnalysisTool,
} from './clone-protein-workflow';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { analyzeCloneOutputSchema, getCloneAnalysisOutputSchema } from './sequence-output-schemas';
const createAnalyzeCloneTool = checkedSequenceToolFactory(
  originalCreateAnalyzeCloneTool,
  analyzeCloneOutputSchema
);
const createGetCloneAnalysisTool = checkedSequenceToolFactory(
  originalCreateGetCloneAnalysisTool,
  getCloneAnalysisOutputSchema
);

describe('clone analysis reference identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions = [];
    mocks.listeners.clear();
    mocks.load.mockResolvedValue({
      documentId: 'reference',
      sourcePath: '/project/reference.gb',
      biology: { sequence: { name: 'Reference', sequence: 'ACGT', length: 4, circular: true } },
    });
    mocks.stat.mockImplementation(async (path: string) => ({
      isFile: path !== '/project',
      canonicalPath: path,
    }));
    mocks.open.mockResolvedValue({});
    mocks.createSession.mockReturnValue('session');
    mocks.prepare.mockResolvedValue({
      referenceSequence: 'ACGT',
      queries: [{ id: 'query', sequence: 'ACGT' }],
    });
  });
  afterEach(() => vi.useRealTimers());
  const run = (query: string) =>
    createAnalyzeCloneTool([]).execute!(
      { documentId: 'reference', queryPaths: [query], name: 'Clone comparison' },
      { toolCallId: 'compare', messages: [] }
    );

  it('refuses the reference file as its own clone before any UI or analysis mutation', async () => {
    const result = await run('reference.gb');
    expect(result).toMatchObject({
      ok: false,
      stateChanged: false,
      error: expect.stringMatching(/same.*reference|reference.*same/i),
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('also refuses an alias resolving to the reference source', async () => {
    mocks.stat.mockImplementation(async (path: string) => ({
      isFile: path !== '/project',
      canonicalPath: path === '/project/alias.fasta' ? '/project/reference.gb' : path,
    }));
    expect(await run('alias.fasta')).toMatchObject({ ok: false, stateChanged: false });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('admits a distinct source even when its sequence could be an identical control', async () => {
    expect(await run('clone.fasta')).toMatchObject({
      ok: true,
      documentId: 'reference',
      sessionId: 'session',
    });
    expect(mocks.prepare).toHaveBeenCalledWith('reference', 'session', ['/project/clone.fasta']);
  });

  const read = (abortSignal?: AbortSignal) =>
    createGetCloneAnalysisTool([]).execute!(
      { documentId: 'reference', sessionId: 'session' },
      { toolCallId: 'read-analysis', messages: [], abortSignal }
    );
  function active() {
    mocks.sessions = [
      { id: 'session', alignmentOperation: { id: 'job', status: 'active' }, tracks: [] },
    ];
  }

  it('waits for durable mutation materialization instead of returning repeated empty reads', async () => {
    vi.useFakeTimers();
    active();
    let settled = false;
    const pending = read().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    mocks.sessions[0].alignmentOperation.status = 'succeeded';
    mocks.sessions[0].tracks = [
      {
        id: 'track',
        label: 'Clone',
        status: 'variants',
        alignment: { identity: 99 },
        mutations: [
          {
            id: 'mutation',
            position: 7008,
            type: 'substitution',
            referenceBase: 'A',
            alternateBase: 'G',
            length: 1,
          },
        ],
      },
    ];
    mocks.listeners.forEach((listener) => listener());
    expect(await pending).toMatchObject({
      ok: true,
      status: 'succeeded',
      tracks: [
        {
          mutationCount: 1,
          mutations: [
            {
              id: 'mutation',
              position: 7008,
              inspection: {
                tool: 'inspect_sequence_variant',
                arguments: {
                  documentId: 'reference',
                  sessionId: 'session',
                  trackId: 'track',
                  mutationId: 'mutation',
                  proteinProduct: 'reference',
                },
              },
            },
          ],
        },
      ],
    });
    expect(mocks.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the wait and explicitly tells the agent to continue the same active job', async () => {
    vi.useFakeTimers();
    active();
    const pending = read();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({
      ok: true,
      status: 'active',
      tracks: [],
      message: expect.stringMatching(/call get_clone_analysis again/i),
    });
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('stops observing on cancellation without canceling or restarting the alignment', async () => {
    vi.useFakeTimers();
    active();
    const controller = new AbortController();
    const pending = read(controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: expect.stringMatching(/stopped waiting/i),
    });
    expect(mocks.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.sessions[0].alignmentOperation.status).toBe('active');
  });
});
