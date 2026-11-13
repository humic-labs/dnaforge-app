import { toUserMessage } from '@waypoint/user-messages';
import { useEffect } from 'react';
import { create } from 'zustand';
import type { ChainSequence, HighlightGroup, Structure3dAttrs } from '../types';
import type { MolstarPlugin } from '../molstar/cache';
import {
  activeMolViewSpecScene,
  activeMolViewSpecSnapshotIndex,
  sameLoadedMolViewSpecScene,
} from '../molstar/molViewSpec';
import { molViewSpecColorGroups } from '../molstar/molViewSpecLegend';
import {
  focusMolViewSpecColorGroup,
  selectMolViewSpecColorGroup,
} from '../molstar/molViewSpecSwatchSelection';
import { focusOnResidues } from './useResidueHighlight';
import { residueLocationsForHighlightGroup } from './useHighlightActions';
import { useToastStore } from '../../../../../stores/toast-store';

interface ReferenceTarget {
  id: string;
  scene?: string;
  snapshotIndex?: number;
  groupId?: string;
  highlightGroups?: HighlightGroup[];
  intent: 'select' | 'target' | 'open-view';
}
export const useStructureReferenceTargets = create<{ requests: Record<string, ReferenceTarget> }>(
  () => ({ requests: {} })
);
export function requestStructureReferenceTarget(
  structureId: string,
  request: Omit<ReferenceTarget, 'id'>
) {
  useStructureReferenceTargets.setState({
    requests: { [structureId]: { ...request, id: crypto.randomUUID() } },
  });
}

export function useStructureReferenceTarget(
  structureId: string,
  plugin: MolstarPlugin | null,
  loaded: boolean,
  attrs: Structure3dAttrs | undefined,
  chains: readonly ChainSequence[],
  openView: () => void
) {
  const request = useStructureReferenceTargets((state) => state.requests[structureId]);
  useEffect(() => {
    if (!request) return;
    const complete = () =>
      useStructureReferenceTargets.setState((state) => {
        if (state.requests[structureId]?.id !== request.id) return state;
        const { [structureId]: _completed, ...requests } = state.requests;
        return { requests };
      });
    if (
      request.scene &&
      attrs &&
      (attrs.molViewSpec !== request.scene ||
        (attrs.molViewSpecSnapshotIndex ?? 0) !== request.snapshotIndex)
    ) {
      complete();
      return;
    }
    if (!plugin || !loaded) return;
    if (
      request.scene &&
      (!sameLoadedMolViewSpecScene(activeMolViewSpecScene(plugin), request.scene) ||
        activeMolViewSpecSnapshotIndex(plugin) !== request.snapshotIndex)
    )
      return;
    try {
      if (request.intent === 'open-view') {
        openView();
      } else if (request.groupId && request.scene) {
        const group = molViewSpecColorGroups(request.scene, request.snapshotIndex ?? 0).find(
          (candidate) => candidate.id === request.groupId
        );
        if (!group) throw Error('This named selection is unavailable in the saved view.');
        const act =
          request.intent === 'target' ? focusMolViewSpecColorGroup : selectMolViewSpecColorGroup;
        act(
          plugin,
          request.scene,
          request.snapshotIndex ?? 0,
          group,
          attrs?.view?.hiddenChainInstanceIds
        );
      } else if (request.intent === 'target' && request.highlightGroups?.length) {
        const residues = request.highlightGroups.flatMap((group) =>
          group.residueLocations?.length
            ? [...group.residueLocations]
            : residueLocationsForHighlightGroup(group, chains)
        );
        if (!focusOnResidues(plugin, residues))
          throw Error('This selection could not be targeted in the loaded structure.');
      }
    } catch (error) {
      useToastStore
        .getState()
        .addToast(toUserMessage(error, 'failure.could-not-target-this-reference'), {
          definition: 'structure-reference-target-failed',
        });
    } finally {
      complete();
    }
  }, [request, plugin, loaded, attrs, chains, structureId, openView]);
}
