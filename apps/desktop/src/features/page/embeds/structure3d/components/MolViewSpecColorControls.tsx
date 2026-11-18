import { MenuNativeSelect } from '@waypoint/ui-components';
import { structureScoreState } from '../utils/structureScoreState';
import type { StructureScoreContext } from '../utils/structureScoreState';
import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import type { MolstarPlugin } from '../molstar';
import type { Structure3dAttrs } from '../types';
import {
  applyMolViewSpecScene,
  getMolViewSpecScene,
  selectMolViewSpecSnapshot,
} from '../molstar/molViewSpec';
import {
  recolorStructureScene,
  sceneColorOptions,
  structureSceneColorMode,
  type SceneColorMode,
} from '../molstar/sceneColors';

export function MolViewSpecColorControls({
  plugin,
  scene,
  index,
  source,
  getLatestAttrs,
  updateAttrs,
}: {
  plugin: MolstarPlugin | null;
  scene: string;
  index: number;
  source: string | StructureScoreContext;
  getLatestAttrs: () => Structure3dAttrs | undefined;
  updateAttrs: (updates: Partial<Structure3dAttrs>) => void;
}) {
  const scoreState = structureScoreState(source);
  const sceneMode = structureSceneColorMode(scene, index);
  const selectedMode =
    sceneMode === 'bfactor' && scoreState.kind === 'prediction'
      ? scoreState.colorMode === 'plddt'
        ? 'confidence'
        : ''
      : sceneMode;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const apply = async (mode: SceneColorMode) => {
    if (!plugin || busy) return;
    setBusy(true);
    setError(null);
    const camera = plugin.canvas3d?.camera.getSnapshot();
    try {
      const story = JSON.parse(scene).kind === 'multiple';
      await applyMolViewSpecScene(plugin, recolorStructureScene(scene, index, mode), undefined, {
        appearanceOnly: !story,
      });
      if (index !== 0) await selectMolViewSpecSnapshot(plugin, index);
      if (story && camera) plugin.canvas3d?.camera.setState(camera, 0);
      const attrs = getLatestAttrs();
      if (attrs) {
        updateAttrs({
          molViewSpec: getMolViewSpecScene(plugin).scene,
          cameraSnapshot: camera ? JSON.stringify(camera) : undefined,
          activeMeasurementId: undefined,
          molecularData: attrs.molecularData
            ? { ...attrs.molecularData, activeLayerId: undefined, baseScene: undefined }
            : undefined,
        });
      }
    } catch (cause) {
      setError(toUserMessage(cause, 'structure.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="text-xs">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-fg-muted">Color</span>
        <span className="block min-w-0 w-full">
          <MenuNativeSelect
            density="compact"
            aria-label="Color structure"
            data-testid="color-mode-select"
            value={selectedMode}
            disabled={!plugin || busy}
            onChange={(event) => void apply(event.target.value as SceneColorMode)}
          >
            <option value="" disabled>
              Custom scene colors
            </option>
            {sceneColorOptions(source).map(({ mode, label }) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </MenuNativeSelect>
        </span>
        {busy && <span role="status">Applying colors…</span>}
      </label>
      {error && (
        <div role="alert" className="pt-1 text-red-500">
          {toUserMessage(error, 'structure.failed')}
        </div>
      )}
    </div>
  );
}
