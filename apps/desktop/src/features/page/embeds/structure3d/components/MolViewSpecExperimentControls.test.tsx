/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MolstarPlugin } from '../molstar';
import {
  applyMolViewSpecScene,
  getMolViewSpecScene,
  resolveMolViewSpecAgentScene,
} from '../molstar/molViewSpec';
import { MolViewSpecExperimentControls } from './MolViewSpecExperimentControls';

vi.mock('../molstar/molViewSpec', () => ({
  applyMolViewSpecScene: vi.fn(async () => undefined),
  getMolViewSpecScene: vi.fn(),
  resolveMolViewSpecAgentScene: vi.fn(() => 'compiled-mvs'),
}));

describe('MolViewSpec experiment controls', () => {
  beforeEach(() => localStorage.clear());

  it('only restores the original view or fits the camera without generating a palette scene', async () => {
    const plugin = {} as MolstarPlugin;
    const onSceneApplied = vi.fn();
    const onFit = vi.fn();
    render(
      <MolViewSpecExperimentControls
        plugin={plugin}
        originalScene="original-mvs"
        originalCameraSnapshot="original-camera"
        onSceneApplied={onSceneApplied}
        onFit={onFit}
      />
    );

    expect(screen.queryByTestId('mvs-style-options')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mvs-full-structure')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mvs-original-view'));
    await waitFor(() =>
      expect(onSceneApplied).toHaveBeenCalledWith('original-mvs', 'original-camera')
    );
    expect(applyMolViewSpecScene).toHaveBeenCalledWith(plugin, 'original-mvs');
    expect(getMolViewSpecScene).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('mvs-fit-view'));
    expect(onFit).toHaveBeenCalledOnce();
  });

  it('authors and pins a custom scene through explicit developer controls', async () => {
    const plugin = {
      canvas3d: { camera: { getSnapshot: () => ({ target: [1, 2, 3] }) } },
    } as unknown as MolstarPlugin;
    const onSceneApplied = vi.fn();
    const onSaveView = vi.fn(
      async () => 'dnaforge-chat://reference/12345678-1234-1234-1234-123456789abc'
    );
    vi.mocked(getMolViewSpecScene)
      .mockReturnValueOnce({ scene: 'current-mvs' } as ReturnType<typeof getMolViewSpecScene>)
      .mockReturnValueOnce({
        scene: 'current-mvs',
        resources: [{ uri: 'structure.pdb' }],
      } as ReturnType<typeof getMolViewSpecScene>)
      .mockReturnValueOnce({ scene: 'applied-mvs' } as ReturnType<typeof getMolViewSpecScene>);
    render(
      <MolViewSpecExperimentControls
        plugin={plugin}
        originalScene="original-mvs"
        originalCameraSnapshot="original-camera"
        onSceneApplied={onSceneApplied}
        onFit={vi.fn()}
        onSaveView={onSaveView}
      />
    );

    fireEvent.click(screen.getByTestId('mvs-edit-scene'));
    expect(screen.getByTestId('mvs-scene-json')).toHaveValue('current-mvs');
    fireEvent.change(screen.getByTestId('mvs-scene-json'), { target: { value: 'custom-mvs' } });
    fireEvent.click(screen.getByTestId('mvs-apply-scene'));
    await waitFor(() =>
      expect(onSceneApplied).toHaveBeenCalledWith('applied-mvs', '{"target":[1,2,3]}')
    );
    expect(resolveMolViewSpecAgentScene).toHaveBeenCalledWith(plugin, 'custom-mvs', [
      'structure.pdb',
    ]);
    expect(applyMolViewSpecScene).toHaveBeenCalledWith(plugin, 'compiled-mvs');
    expect(screen.getByTestId('mvs-scene-json')).toHaveValue('applied-mvs');

    fireEvent.click(screen.getByTestId('mvs-edit-scene'));
    expect(screen.queryByTestId('mvs-scene-lab')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mvs-open-pin-view'));
    fireEvent.change(screen.getByTestId('mvs-view-title'), {
      target: { value: 'Catalytic site context' },
    });
    fireEvent.change(screen.getByTestId('mvs-view-caption'), {
      target: { value: 'Visual thesis and site evidence.' },
    });
    fireEvent.change(screen.getByTestId('mvs-evidence-title'), {
      target: { value: 'RCSB PDB' },
    });
    fireEvent.change(screen.getByTestId('mvs-evidence-url'), {
      target: { value: 'https://www.rcsb.org/structure/1EMA' },
    });
    fireEvent.click(screen.getByTestId('mvs-pin-view'));
    await waitFor(() =>
      expect(onSaveView).toHaveBeenCalledWith({
        title: 'Catalytic site context',
        caption: 'Visual thesis and site evidence.',
        evidence: [{ title: 'RCSB PDB', url: 'https://www.rcsb.org/structure/1EMA' }],
      })
    );
    expect(screen.getByTestId('mvs-pinned-link')).toHaveValue(
      'dnaforge-chat://reference/12345678-1234-1234-1234-123456789abc'
    );
  });
});
