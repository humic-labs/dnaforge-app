import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Structure3dAttrs } from '../types';
import { MolViewSpecColorControls } from './MolViewSpecColorControls';

const native = vi.hoisted(() => ({ apply: vi.fn(), select: vi.fn() }));
vi.mock('../molstar/molViewSpec', () => ({
  applyMolViewSpecScene: native.apply,
  getMolViewSpecScene: () => ({ scene: 'changed' }),
  selectMolViewSpecSnapshot: native.select,
}));
vi.mock('../molstar/sceneColors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../molstar/sceneColors')>()),
  recolorStructureScene: (scene: string) => scene,
  structureSceneColorMode: () => 'chain',
}));

function attrs(revision = 'a'): Structure3dAttrs {
  return {
    source: 'file',
    sourceId: 'coordinates',
    molViewSpec: '{"kind":"single"}',
    activeMeasurementId: 'measurement',
    molecularData: {
      version: 1,
      activeLayerId: 'signal-colors',
      baseScene: 'original scene',
      datasets: [
        {
          id: 'signal',
          name: 'Python signal',
          revision: revision.repeat(64),
          source: { label: 'Python' },
          records: [{ chain: 'A', value: 0.5 }],
        },
      ],
      mappings: [
        {
          datasetId: 'signal',
          dataRevision: revision.repeat(64),
          revision: 'c'.repeat(64),
          coordinateSha256: 'd'.repeat(64),
          targets: [{ row: 0, selector: { label_asym_id: 'A' } }],
          unresolved: [],
        },
      ],
      layers: [
        {
          id: 'signal-colors',
          name: 'Signal colors',
          datasetId: 'signal',
          dataRevision: revision.repeat(64),
          mappingRevision: 'c'.repeat(64),
          column: 'value',
          style: { kind: 'categorical', colors: { '0.5': '#123456' }, missingColor: '#abcdef' },
        },
      ],
    },
  };
}

describe('human structure coloring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.apply.mockResolvedValue(undefined);
    native.select.mockResolvedValue(undefined);
  });

  it('changes an authored single view without setting the camera or permitting a scene reload', async () => {
    const camera = { getSnapshot: vi.fn(() => ({ position: [4, 5, 60] })), setState: vi.fn() };
    const applied = vi.fn();
    render(
      <MolViewSpecColorControls
        plugin={{ canvas3d: { camera } } as never}
        scene='{"kind":"single"}'
        index={0}
        source="file"
        getLatestAttrs={() => ({ source: 'file', sourceId: 'coordinates' })}
        updateAttrs={applied}
      />
    );
    fireEvent.change(screen.getByLabelText('Color structure'), { target: { value: 'element' } });
    await waitFor(() => expect(applied).toHaveBeenCalled());
    expect(native.apply).toHaveBeenCalledWith(expect.anything(), '{"kind":"single"}', undefined, {
      appearanceOnly: true,
    });
    expect(camera.setState).not.toHaveBeenCalled();
    expect(applied).toHaveBeenCalledWith({
      molViewSpec: 'changed',
      cameraSnapshot: JSON.stringify({ position: [4, 5, 60] }),
      activeMeasurementId: undefined,
      molecularData: undefined,
    });
  });

  it('retains data and revisions published during recoloring and deactivates their view without mutation', async () => {
    let finish!: () => void;
    native.apply.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    let current = attrs();
    const getLatestAttrs = vi.fn(() => current);
    const applied = vi.fn();
    render(
      <MolViewSpecColorControls
        plugin={{} as never}
        scene={current.molViewSpec!}
        index={0}
        source="file"
        getLatestAttrs={getLatestAttrs}
        updateAttrs={applied}
      />
    );
    fireEvent.change(screen.getByLabelText('Color structure'), { target: { value: 'element' } });
    expect(screen.getByLabelText('Color structure')).toBeDisabled();
    expect(getLatestAttrs).not.toHaveBeenCalled();
    current = attrs('b');
    const before = structuredClone(current);
    await act(async () => finish());
    await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
    const updates = applied.mock.calls[0][0];
    expect(updates).toEqual({
      molViewSpec: 'changed',
      cameraSnapshot: undefined,
      activeMeasurementId: undefined,
      molecularData: { ...current.molecularData, activeLayerId: undefined, baseScene: undefined },
    });
    expect(updates.molecularData.datasets).toBe(current.molecularData!.datasets);
    expect(updates.molecularData.mappings).toBe(current.molecularData!.mappings);
    expect(updates.molecularData.layers).toBe(current.molecularData!.layers);
    expect(current).toEqual(before);
  });

  it('restores the selected story step and camera before persisting the recolored scene', async () => {
    const snapshot = { position: [7, 8, 90] };
    const camera = { getSnapshot: vi.fn(() => snapshot), setState: vi.fn() };
    const applied = vi.fn(() => {
      expect(native.select).toHaveBeenCalledWith(expect.anything(), 2);
      expect(camera.setState).toHaveBeenCalledWith(snapshot, 0);
    });
    render(
      <MolViewSpecColorControls
        plugin={{ canvas3d: { camera } } as never}
        scene='{"kind":"multiple"}'
        index={2}
        source="file"
        getLatestAttrs={attrs}
        updateAttrs={applied}
      />
    );
    fireEvent.change(screen.getByLabelText('Color structure'), { target: { value: 'element' } });
    await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
    expect(native.apply).toHaveBeenCalledWith(expect.anything(), '{"kind":"multiple"}', undefined, {
      appearanceOnly: false,
    });
    expect(applied).toHaveBeenCalledWith(
      expect.objectContaining({ molViewSpec: 'changed', cameraSnapshot: JSON.stringify(snapshot) })
    );
  });

  it('keeps saved data and active layers unchanged when recoloring fails', async () => {
    native.apply.mockRejectedValue(new Error('Unable to apply colors'));
    const current = attrs();
    const before = structuredClone(current);
    const applied = vi.fn();
    render(
      <MolViewSpecColorControls
        plugin={{} as never}
        scene={current.molViewSpec!}
        index={0}
        source="file"
        getLatestAttrs={() => current}
        updateAttrs={applied}
      />
    );
    fireEvent.change(screen.getByLabelText('Color structure'), { target: { value: 'element' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('structure.failed'));
    expect(applied).not.toHaveBeenCalled();
    expect(current).toEqual(before);
    expect(screen.getByLabelText('Color structure')).toBeEnabled();
  });

  it('offers only the presets that apply to the structure source ', () => {
    const optionLabels = () =>
      Array.from((screen.getByLabelText('Color structure') as HTMLSelectElement).options)
        .filter((option) => !option.disabled)
        .map((option) => option.textContent);
    const { unmount } = render(
      <MolViewSpecColorControls
        plugin={null}
        scene='{"kind":"single"}'
        index={0}
        source="pdb"
        getLatestAttrs={() => undefined}
        updateAttrs={vi.fn()}
      />
    );
    expect(optionLabels()).toEqual(['Chain', 'Element', 'B-factor']);
    unmount();
    render(
      <MolViewSpecColorControls
        plugin={null}
        scene='{"kind":"single"}'
        index={0}
        source="alphafold"
        getLatestAttrs={() => undefined}
        updateAttrs={vi.fn()}
      />
    );
    expect(optionLabels()).toEqual(['Chain', 'Element', 'pLDDT']);
  });
});
