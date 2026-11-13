/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listStarts: vi.fn(),
  listResults: vi.fn(),
  listHarness: vi.fn(),
  listSavedViews: vi.fn(),
  listPreviews: vi.fn(),
  getConversation: vi.fn(),
  getReference: vi.fn(),
  getReferencesByIds: vi.fn(),
  createComparison: vi.fn(),
  navigate: vi.fn(),
  findTab: vi.fn(),
  setActiveTab: vi.fn(),
  focusPanel: vi.fn(),
  openTab: vi.fn(),
  updateTab: vi.fn(),
  closeTab: vi.fn(),
  moveTab: vi.fn(),
  rightTabs: [] as Array<{
    id: string;
    type: string;
    proteinRunPreview?: boolean;
  }>,
}));

vi.mock('../../../../db/molecular-prompt-trials', () => ({
  listMolecularPromptTrialStarts: mocks.listStarts,
  listMolecularPromptTrialResults: mocks.listResults,
  listMolecularPromptTrialViewPreviews: mocks.listPreviews,
  listMolecularSavedViewsForIndex: mocks.listSavedViews,
  MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT: 'dnaforge:protein-prompt-trial-change',
}));
vi.mock('../../../../db/molecular-harness-comparisons', () => ({
  listMolecularHarnessComparisonRecords: mocks.listHarness,
}));
vi.mock('../../../../db', () => ({ getConversation: mocks.getConversation }));
vi.mock('../../../../db/entity-references', () => ({
  getEntityReference: mocks.getReference,
  getEntityReferencesByIds: mocks.getReferencesByIds,
}));
vi.mock('./RunVersionSwitcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./RunVersionSwitcher')>()),
  getOrCreateProteinComparisonReference: mocks.createComparison,
}));
vi.mock('../../../ai/public/navigate-to-reference', () => ({
  navigateToReference: mocks.navigate,
}));
vi.mock('../../../ai/public/molecular-prompt-notebook', () => ({
  MOLECULAR_PROMPT_NOTEBOOK_ID: 'page-protein-prompt-trials-v1',
  ensureMolecularPromptNotebookCurrent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./BatchControls', () => ({ MolecularPromptBatchControls: () => null }));
vi.mock('../../../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({
      layout: {
        type: 'split',
        direction: 'horizontal',
        children: [
          { type: 'panel', panelId: 'left' },
          { type: 'panel', panelId: 'right' },
        ],
      },
      panels: {
        left: {
          id: 'left',
          tabs: [{ id: 'notebook', type: 'page', entityId: 'page-protein-prompt-trials-v1' }],
        },
        right: { id: 'right', tabs: mocks.rightTabs },
      },
      findTab: mocks.findTab,
      setActiveTab: mocks.setActiveTab,
      focusPanel: mocks.focusPanel,
      openTab: mocks.openTab,
      updateTab: mocks.updateTab,
      closeTab: mocks.closeTab,
      moveTab: mocks.moveTab,
    }),
  },
}));

import { ProteinPromptHistoryRenderer } from './Renderer';

const question = 'What replaces water in the KcsA selectivity filter?';
const trial = {
  version: 1,
  caseId: 'kcsa',
  profileId: 'appearance-v1',
  conversationId: 'chat-kcsa',
  question,
  context: 'Pinned 1K4C',
  promptInstructions:
    'Fixed protein benchmark context (v1): use 1K4C.\nPrompt module appearance-v1:\nChoose the visual claim.\nEmphasize filter geometry.\nPinned coordinate fixtures for this conversation:\n1K4C',
  fixtures: [],
  startedAt: 10,
  startRecordId: 'start-kcsa',
};

function addRecordedVersion(label = 'Context + chemistry · v10') {
  const nextTrial = {
    ...trial,
    profileId: 'custom:context-chemistry',
    profileLabel: label,
    conversationId: 'chat-kcsa-v10',
    startedAt: 40,
    startRecordId: 'start-kcsa-v10',
    promptInstructions:
      'Shared setup.\nPrompt module custom:context-chemistry:\nRetain useful molecular context.\nUse element colors with distinct carbons.\nPinned coordinate fixtures for this conversation:\n1K4C',
  };
  mocks.listStarts.mockResolvedValue([
    { id: 'start-kcsa-v10', trial: nextTrial },
    { id: 'start-kcsa', trial },
  ]);
  mocks.listResults.mockResolvedValue([
    {
      id: 'result-kcsa-v10',
      trial: nextTrial,
      status: 'rendered',
      referenceIds: ['view-v10'],
      recordedAt: 50,
      promptSnapshot: {
        version: 1,
        conversationId: nextTrial.conversationId,
        turnId: 'turn-v10',
        channel: 'hosted-system',
        prompt:
          'Shared system prompt.\nRetain useful molecular context.\nUse element colors with distinct carbons.',
        additionalAgentInstructions: null,
        capturedAt: 45,
        scenePolicy: { id: 'mvs-agent-scene-v1', enforcedConstraints: [] },
      },
    },
    {
      id: 'result-kcsa',
      trial,
      status: 'rendered',
      referenceIds: ['view-prompt'],
      recordedAt: 20,
      promptSnapshot: {
        version: 1,
        conversationId: trial.conversationId,
        turnId: 'turn-old',
        channel: 'hosted-system',
        prompt: 'Shared system prompt.\nChoose the visual claim.\nEmphasize filter geometry.',
        additionalAgentInstructions: null,
        capturedAt: 15,
        scenePolicy: { id: 'mvs-agent-scene-v1', enforcedConstraints: [] },
      },
    },
  ]);
  mocks.listPreviews.mockResolvedValue([
    { id: 'view-v10', label: 'New filter view', preview: 'data:image/png;base64,BB==' },
    { id: 'view-prompt', label: 'Earlier filter view', preview: 'data:image/png;base64,AA==' },
  ]);
}

describe('protein run comparison notebook', () => {
  it('offers comparison only when at least two distinct saved structures exist', async () => {
    mocks.listPreviews.mockResolvedValue([
      { id: 'view-prompt', label: 'KcsA', coordinateSha256: 'a'.repeat(64) },
    ]);
    render(
      <ProteinPromptHistoryRenderer
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
      />
    );
    const row = await screen.findByTestId('protein-run-row');
    expect(within(row).getByRole('button', { name: 'View KcsA' })).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Compare structures for KcsA' })).toBeNull();
  });
  it('shows the saved round decisions and evidence binding beside the exact attempt', async () => {
    const roundReview = {
      version: 1,
      reviewedAt: 1,
      corpusSha256: 'a'.repeat(64),
      systemPromptSha256: 'b'.repeat(64),
      runPlanSha256: 'c'.repeat(64),
      decisions: {
        systemPrompt: 'Preserve the general global prompt.',
        harness: 'Use exact source ownership.',
        guidance: 'Keep the reviewed control.',
      },
      corpus: {
        starts: 445,
        attempts: 393,
        incompleteStarts: 52,
        versions: 30,
        feedbackNotes: 77,
        unassessedRenderedSlots: 287,
      },
    };
    mocks.listStarts.mockResolvedValue([{ id: 'start-kcsa', trial: { ...trial, roundReview } }]);
    render(
      <ProteinPromptHistoryRenderer
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
      />
    );
    const review = await screen.findByTestId('protein-recorded-round-review');
    expect(review).toHaveTextContent('445 starts');
    expect(review).toHaveTextContent('393 attempts');
    expect(review).toHaveTextContent(roundReview.decisions.systemPrompt);
    expect(review).toHaveTextContent(roundReview.decisions.harness);
    expect(review).toHaveTextContent(roundReview.decisions.guidance);
    expect(review).toHaveTextContent(roundReview.corpusSha256);
    expect(review).toHaveTextContent(roundReview.systemPromptSha256);
    expect(review).toHaveTextContent(roundReview.runPlanSha256);
  });
  it('shows the complete version trajectory without treating saved views as quality judgments', async () => {
    addRecordedVersion('V12');
    render(
      <ProteinPromptHistoryRenderer
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const trajectory = await screen.findByTestId('protein-corpus-trajectory');
    expect(trajectory).toHaveTextContent('2 recorded variants · 2 guidance bodies · 2 attempts');
    fireEvent.click(within(trajectory).getByText(/Corpus trajectory/));
    const table = within(trajectory).getByRole('table', { name: 'Protein corpus trajectory' });
    expect(within(table).getByRole('row', { name: /V12/ })).toHaveTextContent('1 / 1');
    expect(within(table).getByRole('row', { name: /appearance-v1/ })).toHaveTextContent('1 / 1');
    expect(trajectory).toHaveTextContent('Saved means a view exists');
    expect(
      within(trajectory).getByRole('button', { name: 'Download trial records JSON' })
    ).toBeVisible();
  });

  it('shows both RSV coordinate structures without hiding one behind a views menu', async () => {
    const rsvTrial = {
      ...trial,
      caseId: 'rsv-f-d25',
      conversationId: 'chat-rsv',
      question: 'Why does D25 lose its epitope after RSV F refolds?',
      startRecordId: 'start-rsv',
    };
    mocks.listStarts.mockResolvedValue([{ id: 'start-rsv', trial: rsvTrial }]);
    mocks.listResults.mockResolvedValue([
      {
        id: 'result-rsv',
        trial: rsvTrial,
        status: 'rendered',
        referenceIds: ['rsv-prefusion', 'rsv-postfusion'],
        recordedAt: 20,
        promptSnapshot: {
          version: 1,
          conversationId: 'chat-rsv',
          turnId: 'turn-rsv',
          channel: 'hosted-system',
          prompt: 'Saved prompt',
          scenePolicy: { id: 'policy', enforcedConstraints: [] },
        },
      },
    ]);
    mocks.listPreviews.mockResolvedValue([
      {
        id: 'rsv-prefusion',
        label: 'D25 recognizes the assembled prefusion apex',
        preview: 'data:image/png;base64,AA==',
        coordinateSha256: 'a'.repeat(64),
      },
      {
        id: 'rsv-postfusion',
        label: 'Postfusion F no longer presents the D25 apex',
        preview: 'data:image/png;base64,BB==',
        coordinateSha256: 'b'.repeat(64),
      },
    ]);
    await act(async () => {
      render(
        <ProteinPromptHistoryRenderer
          attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
          selected={false}
          onRemove={() => {}}
        />
      );
    });
    const row = await screen.findByTestId('protein-run-row');
    const structures = within(row).getByRole('group', {
      name: 'Saved structures for RSV F and D25',
    });
    expect(structures).toHaveTextContent('2 saved structures');
    const prefusion = within(structures).getByRole('button', {
      name: '1. D25 recognizes the assembled prefusion apex',
    });
    const postfusion = within(structures).getByRole('button', {
      name: '2. Postfusion F no longer presents the D25 apex',
    });
    expect(prefusion).toBeVisible();
    expect(postfusion).toBeVisible();
    expect(
      within(row).getByRole('button', { name: 'Compare structures for RSV F and D25' })
    ).toBeVisible();
    expect(prefusion).toHaveAttribute('aria-pressed', 'true');
    fireEvent(
      window,
      new CustomEvent('dnaforge:protein-run-structure-navigated', {
        detail: { referenceId: 'rsv-postfusion' },
      })
    );
    await waitFor(() => expect(postfusion).toHaveAttribute('aria-pressed', 'true'));
    expect(
      within(row).getByAltText('Postfusion F no longer presents the D25 apex preview')
    ).toBeInTheDocument();
    mocks.getReferencesByIds.mockResolvedValue([
      {
        id: 'rsv-prefusion',
        locator: 'entity://structure/saved-view:prefusion',
        display_label: 'Prefusion',
      },
      {
        id: 'rsv-postfusion',
        locator: 'entity://structure/saved-view:postfusion',
        display_label: 'Postfusion',
      },
    ]);
    mocks.createComparison.mockResolvedValue({
      reference: { id: 'rsv-comparison', entity_type: 'structure' },
    });
    fireEvent.click(
      within(row).getByRole('button', { name: 'Compare structures for RSV F and D25' })
    );
    await waitFor(() =>
      expect(mocks.createComparison).toHaveBeenCalledWith([
        expect.objectContaining({ referenceId: 'rsv-prefusion', coordinateSha256: 'a'.repeat(64) }),
        expect.objectContaining({
          referenceId: 'rsv-postfusion',
          coordinateSha256: 'b'.repeat(64),
        }),
      ])
    );
    expect(mocks.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'rsv-comparison' }),
      { sourceNotebookPageId: 'page-protein-prompt-trials-v1' }
    );
    fireEvent.click(prefusion);
    await waitFor(() => expect(prefusion).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(postfusion);
    await waitFor(() => expect(mocks.getReference).toHaveBeenLastCalledWith('rsv-postfusion'));
    expect(postfusion).toHaveAttribute('aria-pressed', 'true');
    expect(prefusion).toHaveAttribute('aria-pressed', 'false');
    expect(
      within(row).getByAltText('Postfusion F no longer presents the D25 apex preview')
    ).toBeInTheDocument();
  });

  it('keeps the opened run selected when another batch result arrives', async () => {
    addRecordedVersion('V12');
    render(
      <ProteinPromptHistoryRenderer
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const row = await screen.findByTestId('protein-run-row');
    fireEvent.click(within(row).getByRole('button', { name: 'View New filter view' }));
    await waitFor(() => expect(mocks.getReference).toHaveBeenLastCalledWith('view-v10'));
    const starts = await mocks.listStarts();
    const results = await mocks.listResults();
    const newest = {
      ...starts[0].trial,
      profileLabel: 'V13',
      conversationId: 'newest',
      startRecordId: 'start-newest',
      startedAt: 1000,
    };
    mocks.listStarts.mockResolvedValue([{ id: 'start-newest', trial: newest }, ...starts]);
    mocks.listResults.mockResolvedValue([
      {
        ...results[0],
        id: 'result-newest',
        trial: newest,
        promptSnapshot: { ...results[0].promptSnapshot, conversationId: newest.conversationId },
        referenceIds: ['view-newest'],
        recordedAt: 1001,
      },
      ...results,
    ]);
    fireEvent(window, new Event('dnaforge:protein-prompt-trial-change'));
    await within(row).findByRole('option', { name: 'V13' });
    expect(row).toHaveAttribute('data-run-id', 'prompt:start-kcsa-v10');
    expect(within(row).getByRole('combobox', { name: 'Version for KcsA' })).toHaveValue(
      'prompt:start-kcsa-v10'
    );
  });

  it('compares different prompt versions from the same experiment after a recovery batch', async () => {
    const starts = [
      ['V11', 'older', 100],
      ['V11', 'recovery', 150],
      ['V12', 'older', 200],
      ['V12', 'recovery', 300],
    ].map(([label, experiment, time]) => ({
      id: `start-${label}-${experiment}`,
      trial: {
        ...trial,
        profileId: `custom:${label}`,
        profileLabel: label,
        conversationId: `chat-${label}-${experiment}`,
        startedAt: time,
        startRecordId: `start-${label}-${experiment}`,
        experiment: { id: experiment, replicate: 1, replicateCount: 3 },
        promptInstructions: `Shared setup.\nPrompt module custom:${label}:\n${label} guidance.`,
      },
    }));
    mocks.listStarts.mockResolvedValue(starts);
    mocks.listResults.mockResolvedValue(
      starts.map((start) => ({
        id: `result-${start.id}`,
        trial: start.trial,
        status: 'rendered',
        referenceIds: [`view-${start.trial.profileLabel}-${start.trial.experiment.id}`],
        recordedAt: start.trial.startedAt,
        promptSnapshot: {
          version: 1,
          conversationId: start.trial.conversationId,
          turnId: 'turn',
          channel: 'hosted-system',
          prompt: start.trial.promptInstructions,
          additionalAgentInstructions: null,
          scenePolicy: { id: 'policy', enforcedConstraints: [] },
        },
      }))
    );
    render(
      <ProteinPromptHistoryRenderer
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const row = await screen.findByTestId('protein-run-row');
    fireEvent.click(within(row).getByRole('button', { name: 'Switch KcsA to V11' }));
    await waitFor(() => expect(mocks.getReference).toHaveBeenLastCalledWith('view-V11-recovery'));
  });

  it('switches versions and numbered attempts in one case row without mixing chats or prompts', async () => {
    const starts = ['V10', 'V11'].flatMap((label, version) =>
      [1, 2, 3].map((replicate) => ({
        id: `start-${label}-${replicate}`,
        trial: {
          ...trial,
          profileId: `custom:${label}`,
          profileLabel: label,
          conversationId: `chat-${label}-${replicate}`,
          startRecordId: `start-${label}-${replicate}`,
          startedAt: 100 + version * 10 + replicate,
          experiment: { id: 'experiment-triplicate', replicate, replicateCount: 3 },
          promptInstructions: `Shared setup.\nPrompt module custom:${label}:\n${label} guidance.\nPinned coordinate fixtures for this conversation:\n1K4C`,
        },
      }))
    );
    mocks.listStarts.mockResolvedValue(starts);
    mocks.listResults.mockResolvedValue(
      starts.map((start) => ({
        id: `result-${start.id}`,
        trial: start.trial,
        status: 'rendered',
        referenceIds: [`view-${start.trial.profileLabel}-${start.trial.experiment.replicate}`],
        recordedAt: start.trial.startedAt + 1,
        promptSnapshot: {
          version: 1,
          conversationId: start.trial.conversationId,
          turnId: 'turn',
          channel: 'hosted-system',
          prompt: start.trial.promptInstructions,
          additionalAgentInstructions: null,
          scenePolicy: { id: 'policy', enforcedConstraints: [] },
          capturedAt: 0,
        },
      }))
    );
    mocks.listPreviews.mockResolvedValue(
      starts.map((start) => ({
        id: `view-${start.trial.profileLabel}-${start.trial.experiment.replicate}`,
        label: `${start.trial.profileLabel} attempt ${start.trial.experiment.replicate}`,
        preview: 'data:image/png;base64,AA==',
      }))
    );
    render(
      <ProteinPromptHistoryRenderer
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const row = await screen.findByTestId('protein-run-row');
    expect(screen.getAllByTestId('protein-run-row')).toHaveLength(1);
    expect(within(row).getByRole('button', { name: 'Run 1 for KcsA' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Run 2 for KcsA' }));
    await waitFor(() => expect(mocks.getReference).toHaveBeenLastCalledWith('view-V11-2'));
    const selector = within(row).getByRole('combobox', { name: 'Version for KcsA' });
    const baseline = within(selector).getByRole('option', { name: 'V10' }) as HTMLOptionElement;
    fireEvent.change(selector, { target: { value: baseline.value } });
    await waitFor(() => expect(row).toHaveAttribute('data-run-id', 'prompt:start-V10-2'));
    expect(mocks.getReference).toHaveBeenLastCalledWith('view-V10-2');
    expect(within(row).getByRole('button', { name: 'Run 2 for KcsA' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(within(row).getByText('Chat', { selector: 'button' }));
    await waitFor(() => expect(mocks.getConversation).toHaveBeenLastCalledWith('chat-V10-2'));
    fireEvent.click(within(row).getByText('Variant guidance'));
    expect(await within(row).findByTestId('recorded-visual-instructions')).toHaveTextContent(
      'V10 guidance.'
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.rightTabs.length = 0;
    mocks.listStarts.mockResolvedValue([{ id: 'start-kcsa', trial }]);
    mocks.listResults.mockResolvedValue([
      {
        id: 'result-kcsa',
        trial,
        status: 'rendered',
        observation: 'Filter view saved.',
        referenceIds: ['view-prompt'],
        recordedAt: 20,
        feedback: [
          {
            id: 'feedback-1',
            viewReferenceId: 'view-prompt',
            text: 'One of the best views yet.',
            recordedAt: 21,
          },
        ],
        promptSnapshot: {
          version: 1,
          conversationId: 'chat-kcsa',
          turnId: 'turn-kcsa',
          channel: 'cli-seed',
          prompt: 'Exact app-sent prompt for KcsA. Fixed protein benchmark context (v1): use 1K4C.',
          continuationPrompt: 'Exact follow-up instructions for KcsA.',
          additionalAgentInstructions: null,
          capturedAt: 15,
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
    ]);
    mocks.listHarness.mockResolvedValue([
      {
        id: 'batch-1',
        title: 'Comparison',
        createdAt: 30,
        comparison: {
          version: 2,
          cases: [
            {
              id: 'kcsa',
              title: 'KcsA',
              question,
              outcomes: [
                {
                  id: 'molstar',
                  label: 'Molstar-MCP',
                  provenance: 'native-code',
                  referenceId: 'view-harness',
                },
              ],
            },
          ],
        },
      },
    ]);
    mocks.listSavedViews.mockResolvedValue([
      {
        id: 'view-prompt',
        label: 'Prompt scene',
        createdAt: 20,
        pdbId: '1K4C',
        conversationId: 'chat-kcsa',
        conversationCount: 1,
      },
      {
        id: 'view-harness',
        label: 'Harness scene',
        createdAt: 30,
        pdbId: '1K4C',
        conversationId: null,
        conversationCount: 0,
      },
    ]);
    mocks.listPreviews.mockResolvedValue([
      { id: 'view-prompt', label: 'Prompt scene', preview: 'data:image/png;base64,AA==' },
      { id: 'view-harness', label: 'Harness scene', preview: 'data:image/png;base64,AA==' },
    ]);
    mocks.getConversation.mockResolvedValue({ id: 'chat-kcsa' });
    mocks.getReference.mockImplementation(async (id: string) => ({ id, entity_type: 'structure' }));
    mocks.getReferencesByIds.mockResolvedValue([]);
    mocks.createComparison.mockResolvedValue({
      reference: { id: 'comparison', entity_type: 'structure' },
    });
    mocks.navigate.mockImplementation(async (reference: { id: string }) => ({
      created: false,
      panelId: 'right',
      tabId: reference.id,
    }));
    mocks.findTab.mockImplementation((type: string, id: string) =>
      type === 'chat' && id === 'chat-kcsa' ? { panelId: 'left', tabId: 'chat-tab' } : null
    );
  });

  it('has one row per question with every version available, including when search matches only v10', async () => {
    addRecordedVersion();
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    await screen.findByRole('table', { name: 'Protein comparison runs' });
    expect(screen.getAllByTestId('protein-run-row')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search history' }), {
      target: { value: 'Context + chemistry' },
    });
    const row = screen.getByTestId('protein-run-row');
    const selector = within(row).getByRole('combobox', { name: 'Version for KcsA' });
    expect(within(selector).getAllByRole('option')).toHaveLength(2);
    expect(selector).toHaveValue('prompt:start-kcsa-v10');
    fireEvent.change(selector, { target: { value: 'prompt:start-kcsa' } });
    await waitFor(() => expect(row).toHaveAttribute('data-run-id', 'prompt:start-kcsa'));
    expect(screen.getAllByTestId('protein-run-row')).toHaveLength(1);
    expect(within(row).getByTestId('recorded-visual-instructions')).toHaveTextContent(
      'Choose the visual claim.'
    );
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'view-prompt' }), {
      sourceNotebookPageId: 'page-protein-prompt-trials-v1',
    });
    fireEvent.click(
      within(row).getByRole('button', { name: 'Switch KcsA to Context + chemistry · v10' })
    );
    await waitFor(() => expect(row).toHaveAttribute('data-run-id', 'prompt:start-kcsa-v10'));
    expect(within(row).getByTestId('recorded-visual-instructions')).toHaveTextContent(
      'Use element colors with distinct carbons.'
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Chat' }));
    await waitFor(() => expect(mocks.getConversation).toHaveBeenCalledWith('chat-kcsa-v10'));
  });

  it('compares the two selected archived prompts inside their case row', async () => {
    addRecordedVersion();
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    await screen.findByRole('table', { name: 'Protein comparison runs' });
    expect(screen.getAllByTestId('protein-run-row')).toHaveLength(1);
    const row = screen.getByTestId('protein-run-row');
    fireEvent.click(within(row).getByText('Compare prompts'));
    const comparison = await within(row).findByTestId('protein-prompt-diff');
    expect(comparison.querySelector('[data-change="removed"]')).toHaveTextContent(
      'Choose the visual claim.'
    );
    expect(comparison.querySelector('[data-change="added"]')).toHaveTextContent(
      'Retain useful molecular context.'
    );
    fireEvent.change(within(row).getByRole('combobox', { name: 'Prompt comparison content' }), {
      target: { value: 'full' },
    });
    expect(within(comparison).getByText(/Shared system prompt/)).toBeInTheDocument();
    expect(comparison.querySelector('[data-change="removed"]')).toHaveTextContent(
      'Choose the visual claim.'
    );
    expect(comparison.querySelector('[data-change="added"]')).toHaveTextContent(
      'Retain useful molecular context.'
    );
  });

  it('keeps the current version and prompt when the requested view cannot open', async () => {
    addRecordedVersion();
    mocks.getReference.mockResolvedValue(null);
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    await screen.findByRole('table', { name: 'Protein comparison runs' });
    expect(screen.getAllByTestId('protein-run-row')).toHaveLength(1);
    const row = screen.getByTestId('protein-run-row');
    const selector = within(row).getByRole('combobox', { name: 'Version for KcsA' });
    fireEvent.change(selector, { target: { value: 'prompt:start-kcsa' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This saved molecular view is missing.'
    );
    expect(selector).toHaveValue('prompt:start-kcsa-v10');
    expect(row).toHaveAttribute('data-run-id', 'prompt:start-kcsa-v10');
    expect(within(row).getByTestId('recorded-visual-instructions')).toHaveTextContent(
      'Retain useful molecular context.'
    );
  });

  it('shows a sortable provenance table and keeps it open while comparing views', async () => {
    const editorMouseDown = vi.fn();
    render(
      <div onMouseDown={editorMouseDown}>
        <ProteinPromptHistoryRenderer
          type="protein-prompt-history"
          refId="history"
          attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
          selected={false}
          onRemove={() => {}}
        />
      </div>
    );
    const table = await screen.findByRole('table', { name: 'Protein comparison runs' });
    expect(within(table).getAllByTestId('protein-run-row')).toHaveLength(1);
    expect(within(table).getByRole('columnheader', { name: 'Question' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Version' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'System prompt' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Harness / MCP' })).toBeInTheDocument();
    expect(within(table).getByText('DNAForge MolViewSpec')).toBeInTheDocument();
    expect(
      within(table).getByRole('option', { name: 'Claim + camera + appearance · v1' })
    ).toBeInTheDocument();
    const visualInstructions = within(table).getByTestId('recorded-visual-instructions');
    expect(visualInstructions.textContent).toBe(
      'Choose the visual claim.\nEmphasize filter geometry.'
    );
    expect(visualInstructions).toHaveClass('select-text');
    expect(visualInstructions).not.toHaveClass('overflow-hidden');
    expect(visualInstructions).not.toHaveClass('max-h-12');
    fireEvent.mouseDown(visualInstructions);
    expect(editorMouseDown).not.toHaveBeenCalled();
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    visualInstructions.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    expect(within(table).queryByText('Recorded trial instructions')).not.toBeInTheDocument();
    expect(within(table).getByText('Variant guidance')).toBeInTheDocument();
    expect(within(table).getByText('Full app-sent prompt')).toBeInTheDocument();
    expect(within(table).getByText(/Exact app-sent prompt for KcsA/)).toHaveTextContent(
      'Fixed protein benchmark context'
    );
    expect(within(table).getByText('Continuation prompt')).toBeInTheDocument();
    expect(within(table).getByText('Exact follow-up instructions for KcsA.')).toBeInTheDocument();
    const trialRow = within(table).getByTestId('recorded-visual-instructions').closest('tr')!;
    fireEvent.click(within(trialRow).getByText('Run details'));
    expect(within(trialRow).getByText('One of the best views yet.')).toBeInTheDocument();
    expect(within(trialRow).getByText('Background locked')).toBeInTheDocument();
    expect(within(trialRow).getByText(/Agent scene application/)).toBeInTheDocument();
    expect(within(table).getAllByRole('img')).toHaveLength(1);
    expect(mocks.setActiveTab).not.toHaveBeenCalled();
    fireEvent.click(within(table).getByRole('button', { name: 'View Prompt scene' }));
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'view-prompt' }), {
        sourceNotebookPageId: 'page-protein-prompt-trials-v1',
      })
    );
    expect(mocks.setActiveTab).not.toHaveBeenCalled();
  });

  it('opens the exact linked chat only from Chat', async () => {
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const table = await screen.findByRole('table', { name: 'Protein comparison runs' });
    expect(within(table).getAllByRole('button', { name: 'Chat' })).toHaveLength(1);
    fireEvent.click(within(table).getByRole('button', { name: 'Chat' }));
    await waitFor(() => expect(mocks.setActiveTab).toHaveBeenCalledWith('left', 'chat-tab'));
    expect(mocks.getConversation).toHaveBeenCalledWith('chat-kcsa');
  });

  it('keeps an earlier view tab while opening another run for comparison', async () => {
    mocks.rightTabs.push({ id: 'older-preview', type: 'structure', proteinRunPreview: true });
    mocks.navigate.mockResolvedValue({ created: true, panelId: 'right', tabId: 'new-preview' });
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const table = await screen.findByRole('table', { name: 'Protein comparison runs' });
    fireEvent.click(within(table).getByRole('button', { name: 'View Prompt scene' }));
    await waitFor(() =>
      expect(mocks.updateTab).toHaveBeenCalledWith(
        'right',
        'new-preview',
        expect.objectContaining({
          proteinRunPreview: true,
          label: `KcsA · ${new Date(trial.startedAt).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          })} · Claim + camera + appearance · v1`,
        })
      )
    );
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it('finds a run by its saved scene title', async () => {
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    await screen.findByRole('table', { name: 'Protein comparison runs' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search history' }), {
      target: { value: 'Prompt scene' },
    });
    expect(screen.getAllByTestId('protein-run-row')).toHaveLength(1);
    expect(screen.getByText('DNAForge MolViewSpec')).toBeInTheDocument();
  });

  it('filters a growing question list and sorts runs by system prompt', async () => {
    const groelQuestion = 'How does GroES cap one GroEL ring?';
    const groelTrial = {
      ...trial,
      caseId: 'groel',
      profileId: 'claim-v1',
      conversationId: 'chat-groel',
      question: groelQuestion,
      startedAt: 5,
      startRecordId: 'start-groel',
    };
    mocks.listStarts.mockResolvedValue([
      { id: 'start-kcsa', trial },
      { id: 'start-groel', trial: groelTrial },
    ]);
    mocks.listResults.mockResolvedValue([
      {
        id: 'result-kcsa',
        trial,
        status: 'rendered',
        observation: 'Filter view saved.',
        referenceIds: ['view-prompt'],
        recordedAt: 20,
        promptSnapshot: {
          version: 1,
          conversationId: 'chat-kcsa',
          turnId: 'turn-kcsa',
          channel: 'hosted-system',
          prompt: 'KcsA system prompt',
          capturedAt: 15,
          additionalAgentInstructions: null,
          scenePolicy: { id: 'mvs-agent-scene-v1', enforcedConstraints: [] },
        },
      },
      {
        id: 'result-groel',
        trial: groelTrial,
        status: 'rendered',
        observation: 'GroEL view saved.',
        referenceIds: ['view-groel'],
        recordedAt: 10,
        promptSnapshot: {
          version: 1,
          conversationId: 'chat-groel',
          turnId: 'turn-groel',
          channel: 'hosted-system',
          prompt: 'GroEL system prompt',
          capturedAt: 8,
          additionalAgentInstructions: null,
          scenePolicy: { id: 'mvs-agent-scene-v1', enforcedConstraints: [] },
        },
      },
    ]);
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const table = await screen.findByRole('table', { name: 'Protein comparison runs' });
    expect(within(table).getAllByTestId('protein-run-row')).toHaveLength(2);
    expect(
      within(table)
        .getAllByTestId('protein-run-row')
        .map((row) => row.getAttribute('data-run-id'))
    ).toEqual(['prompt:start-kcsa', 'prompt:start-groel']);
    fireEvent.click(within(table).getByRole('button', { name: 'System prompt' }));
    expect(within(table).getByRole('columnheader', { name: 'System prompt' })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter question' }), {
      target: { value: groelQuestion },
    });
    expect(within(table).getAllByTestId('protein-run-row')).toHaveLength(1);
    expect(within(table).getByText(groelQuestion)).toBeInTheDocument();
  });

  it('resizes the system-prompt column without sorting and restores its width', async () => {
    const view = render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const table = await screen.findByRole('table', { name: 'Protein comparison runs' });
    const promptCol = table.querySelectorAll('col')[2] as HTMLTableColElement;
    const initialWidth = promptCol.style.width;
    const resizeHandle = within(table).getByRole('separator', {
      name: 'Resize System prompt column',
    });
    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' });
    expect(promptCol.style.width).not.toBe(initialWidth);
    expect(within(table).getByRole('columnheader', { name: 'System prompt' })).toHaveAttribute(
      'aria-sort',
      'none'
    );
    const resizedWidth = promptCol.style.width;
    view.unmount();
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    const restoredTable = await screen.findByRole('table', { name: 'Protein comparison runs' });
    expect((restoredTable.querySelectorAll('col')[2] as HTMLTableColElement).style.width).toBe(
      resizedWidth
    );
  });

  it('excludes historical views and runs without an exact instruction payload', async () => {
    mocks.listResults.mockResolvedValue([
      {
        id: 'result-kcsa',
        trial,
        status: 'rendered',
        observation: 'Old result.',
        referenceIds: ['view-prompt'],
        recordedAt: 20,
        promptSnapshot: null,
      },
    ]);
    mocks.listSavedViews.mockResolvedValue([
      {
        id: 'view-prompt',
        label: 'Prompt scene',
        createdAt: 20,
        pdbId: '1K4C',
        conversationId: 'chat-kcsa',
        conversationCount: 1,
      },
      {
        id: 'view-harness',
        label: 'Harness scene',
        createdAt: 30,
        pdbId: '1K4C',
        conversationId: null,
        conversationCount: 0,
      },
      {
        id: 'view-older',
        label: 'Old scene',
        createdAt: 5,
        pdbId: '1K4C',
        conversationId: null,
        conversationCount: 0,
      },
    ]);
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );
    expect(
      await screen.findByText('No captured or reviewed runs recorded yet.')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('table', { name: 'Protein comparison runs' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Harness scene')).not.toBeInTheDocument();
    expect(screen.queryByText('Old scene')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Filter record type' })).not.toBeInTheDocument();
  });

  it('keeps a reviewed old view available as a visual reference without claiming its prompt was captured', async () => {
    const unreviewed = {
      ...trial,
      conversationId: 'chat-unreviewed',
      startedAt: 5,
      startRecordId: 'start-unreviewed',
    };
    mocks.listStarts.mockResolvedValue([
      { id: 'start-kcsa', trial },
      { id: 'start-unreviewed', trial: unreviewed },
    ]);
    mocks.listResults.mockResolvedValue([
      {
        id: 'result-kcsa',
        trial,
        status: 'rendered',
        observation: 'Older view.',
        referenceIds: ['view-prompt'],
        recordedAt: 20,
        promptSnapshot: null,
        feedback: [
          {
            id: 'note-1',
            viewReferenceId: 'view-prompt',
            text: 'Looks pretty good.',
            recordedAt: 30,
          },
        ],
      },
      {
        id: 'result-unreviewed',
        trial: unreviewed,
        status: 'rendered',
        observation: 'Unreviewed older view.',
        referenceIds: ['view-harness'],
        recordedAt: 15,
        promptSnapshot: null,
        feedback: [],
      },
    ]);
    render(
      <ProteinPromptHistoryRenderer
        type="protein-prompt-history"
        refId="history"
        attrs={{ pageId: 'page-protein-prompt-trials-v1' }}
        selected={false}
        onRemove={() => {}}
      />
    );

    const table = await screen.findByRole('table', { name: 'Protein comparison runs' });
    const rows = within(table).getAllByTestId('protein-run-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-run-id', 'prompt:start-kcsa');
    expect(within(rows[0]).getByText('Visual reference')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Exact app-sent prompt not recorded')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: 'View Prompt scene' })).toBeInTheDocument();
  });
});
