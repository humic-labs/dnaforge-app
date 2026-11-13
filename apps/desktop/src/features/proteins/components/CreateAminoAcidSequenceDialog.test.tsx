import { withUserMessage, userMessage } from '@waypoint/user-messages';

/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordProteinsMock = vi.hoisted(() => ({
  previewProteinArtifactPath: vi.fn(),
}));
vi.mock('../record-proteins', () => recordProteinsMock);

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: { readDir: vi.fn(async () => []) } }),
}));

import { CreateAminoAcidSequenceDialog } from './CreateAminoAcidSequenceDialog';

afterEach(cleanup);

const PENDING = {
  suggestedName: 'mioC CDS',
  sequence: 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG',
  workspaceRoot: '/ws',
  sourceFilePath: '/ws/sequences/mioC.gb',
};

const ROOTS = [{ path: '/ws', name: 'ws' }];

beforeEach(() => {
  vi.clearAllMocks();
  recordProteinsMock.previewProteinArtifactPath.mockImplementation(
    async (_workspaceRoot: string, name: string, _sequence: string, dir?: string) =>
      dir ? `${dir.replace(/^\/ws\/?/, '')}/${name}-abc12345.faa` : `proteins/${name}-abc12345.faa`
  );
});

describe('CreateAminoAcidSequenceDialog — save-location picker ', () => {
  it('renders nothing when pending is null', () => {
    render(
      <CreateAminoAcidSequenceDialog
        pending={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        roots={ROOTS}
      />
    );
    expect(screen.queryByTestId('create-amino-acid-sequence-dialog')).toBeNull();
  });

  it("shows the ProteinSaveLocationPicker when roots are available, defaulting to the SOURCE FILE's own folder", async () => {
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        roots={ROOTS}
      />
    );
    expect(screen.getByTestId('protein-save-location-picker')).toBeTruthy();
    await waitFor(() =>
      expect(recordProteinsMock.previewProteinArtifactPath).toHaveBeenCalledWith(
        '/ws',
        'mioC CDS',
        PENDING.sequence,
        '/ws/sequences'
      )
    );
    await waitFor(() =>
      expect(screen.getByTestId('create-amino-acid-sequence-destination').textContent).toBe(
        'sequences/mioC CDS-abc12345.faa'
      )
    );
  });

  it('hides the picker gracefully when no workspace roots are known', () => {
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        roots={[]}
      />
    );
    expect(screen.queryByTestId('protein-save-location-picker')).toBeNull();
  });

  it('selecting a folder updates the destination preview AND is passed to onConfirm', async () => {
    const onConfirm = vi.fn();
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        roots={ROOTS}
      />
    );

    fireEvent.click(screen.getByTestId('protein-picker-folder-/ws'));

    await waitFor(() =>
      expect(screen.getByTestId('create-amino-acid-sequence-destination').textContent).toBe(
        '/mioC CDS-abc12345.faa'
      )
    );

    fireEvent.click(screen.getByTestId('create-amino-acid-sequence-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('mioC CDS', '/ws', '/ws');
  });

  it('confirms with the SOURCE-FILE-FOLDER default and the original workspaceRoot when the user never touches the picker', async () => {
    const onConfirm = vi.fn();
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        roots={ROOTS}
      />
    );
    await waitFor(() => expect(recordProteinsMock.previewProteinArtifactPath).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('create-amino-acid-sequence-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('mioC CDS', '/ws/sequences', '/ws');
  });

  it('picking a folder in a DIFFERENT mounted workspace resolves THAT workspace as the owner (primer save-location parity)', async () => {
    const onConfirm = vi.fn();
    const multiRoots = [
      { path: '/ws', name: 'ws' },
      { path: '/other-workspace', name: 'other' },
    ];
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        roots={multiRoots}
      />
    );

    fireEvent.click(screen.getByTestId('protein-picker-folder-/other-workspace'));
    await waitFor(() =>
      expect(recordProteinsMock.previewProteinArtifactPath).toHaveBeenLastCalledWith(
        '/other-workspace',
        'mioC CDS',
        PENDING.sequence,
        '/other-workspace'
      )
    );

    fireEvent.click(screen.getByTestId('create-amino-acid-sequence-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('mioC CDS', '/other-workspace', '/other-workspace');
  });

  it('resolves the INNERMOST mounted root as owner when roots are nested (a parent workspace mounted alongside one of its own subfolders)', async () => {
    const onConfirm = vi.fn();
    const nestedRoots = [
      { path: '/ws', name: 'ws' },
      { path: '/ws/nested', name: 'nested' },
    ];
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        roots={nestedRoots}
      />
    );

    fireEvent.click(screen.getByTestId('protein-picker-folder-/ws/nested'));
    await waitFor(() =>
      expect(recordProteinsMock.previewProteinArtifactPath).toHaveBeenLastCalledWith(
        '/ws/nested',
        'mioC CDS',
        PENDING.sequence,
        '/ws/nested'
      )
    );

    fireEvent.click(screen.getByTestId('create-amino-acid-sequence-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('mioC CDS', '/ws/nested', '/ws/nested');
  });

  it('surfaces a destination error (never a stale/silent path) when the resolver rejects', async () => {
    recordProteinsMock.previewProteinArtifactPath.mockRejectedValueOnce(
      withUserMessage(
        new Error('Protein sequences must be saved inside the owning workspace.'),
        'protein.destinationOutsideProject'
      )
    );
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        roots={ROOTS}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('create-amino-acid-sequence-destination-error').textContent).toBe(
        userMessage('protein.destinationOutsideProject')
      )
    );
    expect(screen.queryByTestId('create-amino-acid-sequence-destination')).toBeNull();
    expect(screen.getByTestId('create-amino-acid-sequence-confirm')).toBeDisabled();
  });

  it('disables Confirm when the name is emptied or whitespace-only', async () => {
    const onConfirm = vi.fn();
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        roots={ROOTS}
      />
    );
    await waitFor(() => expect(recordProteinsMock.previewProteinArtifactPath).toHaveBeenCalled());
    expect(screen.getByTestId('create-amino-acid-sequence-confirm')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('create-amino-acid-sequence-name'), {
      target: { value: '   ' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('create-amino-acid-sequence-confirm')).toBeDisabled()
    );

    fireEvent.click(screen.getByTestId('create-amino-acid-sequence-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables Confirm, Cancel, and the name input while isCreating (write/register in flight)', () => {
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        isCreating
        roots={ROOTS}
      />
    );
    expect(screen.getByTestId('create-amino-acid-sequence-confirm')).toBeDisabled();
    expect(screen.getByTestId('create-amino-acid-sequence-cancel')).toBeDisabled();
    expect(screen.getByTestId('create-amino-acid-sequence-name')).toBeDisabled();
    expect(screen.getByTestId('create-amino-acid-sequence-confirm').textContent).toBe('Creating…');
  });

  it('Cancel never calls onConfirm', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CreateAminoAcidSequenceDialog
        pending={PENDING}
        onCancel={onCancel}
        onConfirm={onConfirm}
        roots={ROOTS}
      />
    );
    fireEvent.click(screen.getByTestId('create-amino-acid-sequence-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
