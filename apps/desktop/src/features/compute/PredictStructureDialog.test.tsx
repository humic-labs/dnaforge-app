/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn(async () => ({ status: 'declined' as const })));
const listProviders = vi.hoisted(() => vi.fn());
const folders = vi.hoisted(() => [{ path: '/ws/lab', name: 'lab', addedAt: 1 }]);

vi.mock('../ai/tools/compute', () => ({
  computeValidateTool: {},
  computeEstimateTool: {},
  computeSubmitTool: {},
  computeStatusTool: {},
  createComputeImportResultTool: () => ({}),
}));
vi.mock('./predict-structure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./predict-structure')>();
  return { ...actual, runStructurePrediction: run };
});
vi.mock('../../platform', () => ({ platform: () => ({ compute: { listProviders } }) }));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: { folders: typeof folders }) => unknown) =>
    selector({ folders }),
}));

import { PredictStructureDialog } from './PredictStructureDialog';
import { usePredictStructureStore } from './predict-structure-store';
import { useComputeStore } from './store';

function provider(id: string, connected = false) {
  return { id, displayName: `${id} display`, hasBinding: true, connected };
}

function openFor(sequence = 'MKTVLA') {
  act(() => {
    usePredictStructureStore.getState().open({ sequence, name: 'Ubiquitin', preferredRoot: null });
  });
}

beforeEach(() => {
  run.mockClear();
  usePredictStructureStore.setState({ target: null });
  useComputeStore.setState({ providers: [], connectDialog: { open: false, providerId: null } });
});
afterEach(cleanup);

describe('PredictStructureDialog', () => {
  it('renders nothing until a protein is chosen', () => {
    render(<PredictStructureDialog />);
    expect(screen.queryByTestId('predict-structure-dialog')).toBeNull();
  });

  it('defaults to the first connected provider and predicts with its preset', async () => {
    listProviders.mockResolvedValue([provider('boltz'), provider('nvidia-nim', true)]);
    render(<PredictStructureDialog />);
    openFor();
    await screen.findByTestId('predict-structure-option-nvidia-nim');
    expect(screen.getByTestId('predict-structure-target').textContent).toContain('6 residues');
    expect(screen.getByTestId('predict-structure-connect-boltz')).toBeTruthy();
    const submit = screen.getByTestId('predict-structure-submit') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    expect(run).toHaveBeenCalledWith(
      { sequence: 'MKTVLA', name: 'Ubiquitin', preferredRoot: null },
      expect.objectContaining({ provider: 'nvidia-nim', toolId: 'boltz2' }),
      folders
    );
    expect(usePredictStructureStore.getState().target).toBeNull();
  });

  it('asks to connect a provider when none is connected', async () => {
    listProviders.mockResolvedValue([provider('boltz'), provider('subseq')]);
    render(<PredictStructureDialog />);
    openFor();
    await screen.findByTestId('predict-structure-needs-provider');
    expect((screen.getByTestId('predict-structure-submit') as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByTestId('predict-structure-connect-boltz'));
    expect(useComputeStore.getState().connectDialog).toEqual({ open: true, providerId: 'boltz' });
    expect(run).not.toHaveBeenCalled();
  });
});
