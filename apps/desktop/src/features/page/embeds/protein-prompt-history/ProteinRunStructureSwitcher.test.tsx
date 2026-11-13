/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listSiblings: vi.fn(),
  getReference: vi.fn(),
  applyReference: vi.fn(),
  applyComparison: vi.fn(),
}));
vi.mock('../../../../db/molecular-prompt-trials', () => ({
  listMolecularPromptTrialSiblingStructuresForSavedView: mocks.listSiblings,
  MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT: 'dnaforge:protein-prompt-trial-change',
}));
vi.mock('../../../../db/entity-references', () => ({ getEntityReference: mocks.getReference }));
vi.mock('./RunVersionSwitcher', () => ({
  applyProteinSavedViewReferenceToTab: mocks.applyReference,
  applyProteinComparisonToTab: mocks.applyComparison,
  PROTEIN_RUN_STRUCTURE_NAVIGATED_EVENT: 'dnaforge:protein-run-structure-navigated',
}));

import { ProteinRunStructureSwitcher } from './ProteinRunStructureSwitcher';

it('shows sibling structures next to the viewer and replaces the current structure in its tab', async () => {
  mocks.listSiblings.mockResolvedValue([
    {
      referenceId: 'rsv-prefusion-ref',
      savedViewId: 'saved-view:rsv-prefusion',
      label: 'Prefusion F with D25',
      coordinateSha256: 'a'.repeat(64),
    },
    {
      referenceId: 'rsv-postfusion-ref',
      savedViewId: 'saved-view:rsv-postfusion',
      label: 'Postfusion F',
      coordinateSha256: 'b'.repeat(64),
    },
  ]);
  const reference = { id: 'rsv-postfusion-ref', entity_type: 'structure' };
  mocks.getReference.mockResolvedValue(reference);
  mocks.applyReference.mockResolvedValue(undefined);
  mocks.applyComparison.mockResolvedValue('comparison-reference');
  const navigated = vi.fn();
  window.addEventListener('dnaforge:protein-run-structure-navigated', navigated);
  render(
    <ProteinRunStructureSwitcher
      panelId="right"
      tabId="rsv-tab"
      savedViewId="saved-view:rsv-prefusion"
      isActive
    />
  );
  const structures = await screen.findByRole('group', { name: 'Structures in this run' });
  expect(structures).toHaveTextContent('Structure 1 of 2');
  const prefusion = within(structures).getByRole('button', { name: 'Prefusion F with D25' });
  const postfusion = within(structures).getByRole('button', { name: 'Postfusion F' });
  expect(prefusion).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(within(structures).getByRole('button', { name: 'Open comparison' }));
  await waitFor(() =>
    expect(mocks.applyComparison).toHaveBeenCalledWith(
      'right',
      'rsv-tab',
      'saved-view:rsv-prefusion',
      expect.arrayContaining([
        expect.objectContaining({ referenceId: 'rsv-prefusion-ref' }),
        expect.objectContaining({ referenceId: 'rsv-postfusion-ref' }),
      ])
    )
  );
  await waitFor(() =>
    expect(within(structures).getByRole('button', { name: 'Postfusion F' })).toBeEnabled()
  );
  fireEvent.click(postfusion);
  await waitFor(() =>
    expect(mocks.applyReference).toHaveBeenCalledWith(
      'right',
      'rsv-tab',
      'saved-view:rsv-prefusion',
      reference,
      'b'.repeat(64)
    )
  );
  await waitFor(() => expect(navigated).toHaveBeenCalledOnce());
  expect((navigated.mock.calls[0][0] as CustomEvent).detail).toEqual({
    referenceId: 'rsv-postfusion-ref',
  });
  window.removeEventListener('dnaforge:protein-run-structure-navigated', navigated);
});
