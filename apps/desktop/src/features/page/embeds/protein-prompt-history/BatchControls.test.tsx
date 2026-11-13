import { withUserMessage, userMessagePayload, userMessageValue } from '@waypoint/user-messages';
/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(),
  runBatch: vi.fn(),
  prepareReview: vi.fn(),
  requestApproval: vi.fn(),
}));
vi.mock('../../../../db/molecular-prompt-trials', () => ({
  listMolecularFixtureCandidates: mocks.listCandidates,
}));
vi.mock('../../../ai/public/molecular-prompt-batch', () => ({
  runMolecularPromptBatch: mocks.runBatch,
  prepareMolecularBatchRoundReview: mocks.prepareReview,
  molecularBatchAdmission: (batch: { experimentId: string }) => ({
    runId: batch.experimentId,
    mode: 'full-round',
    frozen: 'test',
    slots: ['slot'],
  }),
}));

import { MolecularPromptBatchControls } from './BatchControls';

describe('notebook batch controls', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal('electronAPI', {
      proteinExperimentWorkers: { requestApproval: mocks.requestApproval },
    });
    mocks.requestApproval.mockResolvedValue(undefined);
    mocks.listCandidates.mockResolvedValue([
      {
        referenceId: 'fixture-kcsa',
        savedViewId: 'saved-view:kcsa',
        label: 'KcsA assembly',
        pdbId: '1K4C',
        coordinateSha256: 'a'.repeat(64),
        scene:
          '{"kind":"single","root":{"kind":"root","children":[{"kind":"structure","params":{"type":"assembly","assembly_id":"1"}}]}}',
      },
    ]);
    mocks.runBatch.mockResolvedValue({ completed: 3, rendered: 3, conversationIds: [] });
    mocks.prepareReview.mockResolvedValue({ version: 1, corpusSha256: 'a'.repeat(64) });
  });

  it('launches selected variants together from the notebook, with one pinned structure', async () => {
    render(<MolecularPromptBatchControls notebookPageId="page-protein-prompt-trials-v1" />);
    const run = screen.getByTestId('protein-batch-run');
    expect(run).toBeDisabled();
    await screen.findByRole('option', { name: /KcsA assembly/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pinned 1K4C coordinates' }), {
      target: { value: 'fixture-kcsa' },
    });
    expect(run).toBeDisabled();
    for (const label of ['System prompt review', 'Harness review', 'Guidance review'])
      fireEvent.change(screen.getByRole('textbox', { name: label }), {
        target: { value: `Keep or revise after the complete corpus review: ${label}.` },
      });
    expect(run).toBeEnabled();
    fireEvent.click(run);
    await waitFor(() => expect(mocks.runBatch).toHaveBeenCalledTimes(1));
    expect(mocks.runBatch.mock.calls[0][0]).toMatchObject({
      caseId: 'kcsa',
      fixtureSelection: { '1K4C': 'fixture-kcsa' },
      notebookPageId: 'page-protein-prompt-trials-v1',
      variants: [{ id: 'camera-v1' }, { id: 'appearance-v1' }],
      roundReview: { version: 1, corpusSha256: 'a'.repeat(64) },
    });
    expect(
      await screen.findByText('Round complete · 3/3 required saved runs ready to inspect.')
    ).toBeInTheDocument();
    expect(run).toBeDisabled();
  });

  it('saves an editable prompt as a new selectable variant before launching it', async () => {
    render(<MolecularPromptBatchControls notebookPageId="page-protein-prompt-trials-v1" />);
    await screen.findByRole('option', { name: /KcsA assembly/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pinned 1K4C coordinates' }), {
      target: { value: 'fixture-kcsa' },
    });
    fireEvent.click(screen.getByText('Edit prompt variants'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Variant name' }), {
      target: { value: 'Filter atoms close-up' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Guidance added to the system prompt' }), {
      target: {
        value: 'Orient the camera along the pore and color coordinating oxygens by element.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save as new' }));
    expect(screen.getByText('Filter atoms close-up', { selector: 'span' })).toBeInTheDocument();
    for (const label of ['System prompt review', 'Harness review', 'Guidance review'])
      fireEvent.change(screen.getByRole('textbox', { name: label }), {
        target: { value: `Reviewed ${label} against all recorded versions.` },
      });
    fireEvent.click(screen.getByTestId('protein-batch-run'));
    await waitFor(() => expect(mocks.runBatch).toHaveBeenCalledTimes(1));
    expect(mocks.runBatch.mock.calls[0][0].variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Filter atoms close-up',
          instructions:
            'Orient the camera along the pore and color coordinating oxygens by element.',
        }),
      ])
    );
  });

  it('keeps an incomplete round in error state without a completion notice or discarded review', async () => {
    mocks.runBatch.mockRejectedValue(
      withUserMessage(
        new Error('Round incomplete: 2/3 required saved runs.'),
        userMessagePayload('assistant.roundIncomplete', {
          completed: userMessageValue(2),
          required: userMessageValue(3),
        })
      )
    );
    render(<MolecularPromptBatchControls notebookPageId="page-protein-prompt-trials-v1" />);
    await screen.findByRole('option', { name: /KcsA assembly/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pinned 1K4C coordinates' }), {
      target: { value: 'fixture-kcsa' },
    });
    for (const label of ['System prompt review', 'Harness review', 'Guidance review'])
      fireEvent.change(screen.getByRole('textbox', { name: label }), {
        target: { value: `Reviewed ${label}.` },
      });
    fireEvent.click(screen.getByTestId('protein-batch-run'));
    expect(
      await screen.findByText('Round incomplete: 2/3 required saved runs.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Round complete ·/)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Harness review' })).toHaveValue(
      'Reviewed Harness review.'
    );
  });
});
