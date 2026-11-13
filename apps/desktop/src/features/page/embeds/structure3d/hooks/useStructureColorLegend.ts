import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useMemo } from 'react';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import type { MolstarPlugin } from '../molstar';
import type { Structure3dAttrs, Structure3dSource, StructureSequenceData } from '../types';
import type { structureViewStateFromAttrs } from '../utils/viewRecipe';
import { colorKeysForThemes, colorLegendsForMolViewSpecScene } from '../molstar/molViewSpecLegend';
import {
  nativeMolViewSpecColorGroups,
  focusMolViewSpecColorGroup,
  selectMolViewSpecColorGroup,
} from '../molstar/molViewSpecSwatchSelection';

export function useStructureColorLegend({
  plugin,
  isLoaded,
  currentData,
  effectiveView,
  structureData,
  source,
}: {
  plugin: MolstarPlugin | null;
  isLoaded: boolean;
  currentData: Structure3dAttrs | undefined;
  effectiveView: ReturnType<typeof structureViewStateFromAttrs> | undefined;
  structureData: StructureSequenceData | null;
  source: Structure3dSource;
}) {
  const namedColorGroups = useMemo(
    () =>
      plugin
        ? nativeMolViewSpecColorGroups(
            plugin,
            isLoaded ? currentData?.molViewSpec : undefined,
            currentData?.molViewSpecSnapshotIndex ?? 0
          )
        : [],
    [plugin, isLoaded, currentData?.molViewSpec, currentData?.molViewSpecSnapshotIndex]
  );
  const colorLegends = useMemo(
    () =>
      colorLegendsForMolViewSpecScene(
        isLoaded ? currentData?.molViewSpec : undefined,
        currentData?.molViewSpecSnapshotIndex ?? 0,
        namedColorGroups
      ),
    [isLoaded, currentData?.molViewSpec, currentData?.molViewSpecSnapshotIndex, namedColorGroups]
  );
  const colorKeys = useMemo(
    () => colorKeysForThemes(structureData?.colorLegends ?? [], currentData ?? source),
    [structureData?.colorLegends, currentData, source]
  );
  const handleSelectNamedColorGroup = useCallback(
    (group: (typeof namedColorGroups)[number]) => {
      if (!plugin || !currentData?.molViewSpec || !isLoaded) return;
      try {
        selectMolViewSpecColorGroup(
          plugin,
          currentData.molViewSpec,
          currentData.molViewSpecSnapshotIndex ?? 0,
          group,
          effectiveView?.hiddenChainInstanceIds
        );
      } catch (error) {
        void PluginCommands.Toast.Show(plugin, {
          title: 'Selection unavailable',
          message: toUserMessage(error, 'structure.failed'),
          timeoutMs: 4_000,
        });
      }
    },
    [
      plugin,
      currentData?.molViewSpec,
      currentData?.molViewSpecSnapshotIndex,
      effectiveView?.hiddenChainInstanceIds,
      isLoaded,
    ]
  );
  const handleFocusNamedColorGroup = useCallback(
    (group: (typeof namedColorGroups)[number]) => {
      if (!plugin || !currentData?.molViewSpec || !isLoaded) return;
      try {
        focusMolViewSpecColorGroup(
          plugin,
          currentData.molViewSpec,
          currentData.molViewSpecSnapshotIndex ?? 0,
          group,
          effectiveView?.hiddenChainInstanceIds
        );
      } catch (error) {
        void PluginCommands.Toast.Show(plugin, {
          title: 'Target unavailable',
          message: toUserMessage(error, 'structure.failed'),
          timeoutMs: 4_000,
        });
      }
    },
    [
      plugin,
      currentData?.molViewSpec,
      currentData?.molViewSpecSnapshotIndex,
      effectiveView?.hiddenChainInstanceIds,
      isLoaded,
    ]
  );
  return {
    namedColorGroups,
    colorLegends,
    colorKeys,
    handleSelectNamedColorGroup,
    handleFocusNamedColorGroup,
  };
}
