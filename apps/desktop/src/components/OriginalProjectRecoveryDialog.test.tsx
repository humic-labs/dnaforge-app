import { withUserMessage } from '@waypoint/user-messages';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OriginalProjectRecoveryDialog } from './OriginalProjectRecoveryDialog';
import { useOriginalProjectRecoveryStore } from '../stores/original-project-recovery-store';

const mocks = vi.hoisted(() => ({ identify: vi.fn(), reconcile: vi.fn(), select: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({
    workspace: {
      getOriginalDefaultProject: async () => ({
        status: 'unresolved',
        reason: 'identity-not-recorded',
        message: 'Identify the original.',
      }),
      identifyOriginalDefaultProject: mocks.identify,
    },
    db: { select: mocks.select },
  }),
}));
vi.mock('../services/workspace-reconcile', () => ({ reconcileWorkspaceRoot: mocks.reconcile }));
vi.mock('../services/workspace-reconcile-report', () => ({
  reportOriginalProjectResolution: vi.fn(),
  reportPrimerRecoveryInventory: vi.fn(),
  reportPrimerReconcileFailures: vi.fn(),
}));
vi.mock('../features/primers/public/primer-recovery-report', () => ({
  refreshPrimerRecoveryInventory: async () => ({ entries: [] }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockResolvedValue([
    {
      id: 41,
      repo_uuid: 'original',
      name: 'Renamed original',
      path: '/projects/original',
      origin_path: null,
      access_mode: 'writable',
      archived_at: null,
      trashed_at: null,
    },
    {
      id: 42,
      repo_uuid: 'other',
      name: 'My Project',
      path: '/projects/other',
      origin_path: null,
      access_mode: 'writable',
      archived_at: null,
      trashed_at: null,
    },
  ]);
  mocks.identify.mockResolvedValue({
    status: 'ready',
    evidence: 'stored-identity',
    project: { workspaceId: 41, repoUuid: 'original', rootPath: '/projects/original' },
  });
  mocks.reconcile.mockResolvedValue({});
  useOriginalProjectRecoveryStore.getState().show();
});
afterEach(() => {
  cleanup();
  useOriginalProjectRecoveryStore.getState().close();
});

it('requires an explicit existing identity and reconciles the selected original, even with a same-named alternative', async () => {
  render(<OriginalProjectRecoveryDialog />);
  const chooser = await screen.findByRole('option', {
    name: 'Renamed original — /projects/original',
  });
  expect(chooser).toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Identify and recover' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '41' } });
  fireEvent.click(screen.getByRole('button', { name: 'Identify and recover' }));
  await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith('/projects/original'));
  expect(mocks.identify).toHaveBeenCalledWith({ workspaceId: 41, repoUuid: 'original' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('keeps a rejected stale choice visible without starting record recovery', async () => {
  mocks.identify.mockRejectedValue(
    withUserMessage(
      new Error('The selected project identity changed.'),
      'guidance.the-selected-project-identity-changed-refresh-the-project-list'
    )
  );
  render(<OriginalProjectRecoveryDialog />);
  await screen.findByRole('option', { name: 'Renamed original — /projects/original' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '41' } });
  fireEvent.click(screen.getByRole('button', { name: 'Identify and recover' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The selected project identity changed.'
  );
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeVisible();
});
