import { structureScoreState } from './structureScoreState';
import type { Structure3dAttrs, Structure3dColorMode, StructureMemberSelection } from '../types';

export interface StructureVisualizationCapabilities {
  renderIntent: 'loaded' | 'preview';
  supportsComplexContext: boolean;
  scoreColorModes: ReadonlyArray<Extract<Structure3dColorMode, 'plddt' | 'bfactor'>>;
}

type StructureCapabilityContext = Pick<
  Structure3dAttrs,
  | 'source'
  | 'sourceId'
  | 'providerIdentityKey'
  | 'accession'
  | 'uniprotId'
  | 'url'
  | 'pdbId'
  | 'pdbEntityId'
  | 'labelAsymIds'
  | 'authAsymIds'
  | 'view'
  | 'scene'
  | 'coordinateScores'
  | 'structureArtifactRef'
  | 'coordinateSource'
  | 'coordinateSha256'
  | 'predictionProvenance'
  | 'catalogProvenance'
>;

export function structureVisualizationCapabilitiesFor(
  attrs: Structure3dAttrs | undefined
): StructureVisualizationCapabilities {
  const renderIntent =
    attrs?.view?.renderIntent === 'preview' ||
    attrs?.view?.activeRecipeId === 'query-in-complex-preview'
      ? 'preview'
      : 'loaded';

  return {
    renderIntent,
    supportsComplexContext: supportsComplexContext(attrs),
    scoreColorModes: scoreColorModesForStructure(attrs),
  };
}

function supportsComplexContext(attrs: StructureCapabilityContext | undefined): boolean {
  if (!attrs) return false;
  if (attrs.scene?.sceneKind === 'complex') return true;

  const querySelection = attrs.scene?.queryAnchor.targetSelection;
  return hasScopedEntryContext(attrs) || hasScopedEntrySelection(querySelection);
}

function hasScopedEntryContext(attrs: StructureCapabilityContext): boolean {
  if (!hasEntryStructureIdentity(attrs)) return false;
  return hasSelectionScope({
    entityIds: attrs.pdbEntityId ? [attrs.pdbEntityId] : undefined,
    labelAsymIds: attrs.labelAsymIds,
    authAsymIds: attrs.authAsymIds,
  });
}

function hasScopedEntrySelection(selection: StructureMemberSelection | undefined): boolean {
  if (!selection) return false;
  if (!hasEntryStructureIdentity(selection)) return false;
  return hasSelectionScope(selection);
}

function hasEntryStructureIdentity(
  value:
    | Pick<StructureCapabilityContext, 'pdbId' | 'sourceId' | 'providerIdentityKey'>
    | StructureMemberSelection
): boolean {
  const sourceId = 'sourceId' in value ? value.sourceId : undefined;
  return Boolean(
    value.pdbId ||
    (typeof value.providerIdentityKey === 'string' && /^RCSB:/i.test(value.providerIdentityKey)) ||
    (typeof sourceId === 'string' && /^RCSB:/i.test(sourceId))
  );
}

function hasSelectionScope(selection: StructureMemberSelection | undefined): boolean {
  return !!(
    selection?.entityIds?.length ||
    selection?.labelAsymIds?.length ||
    selection?.authAsymIds?.length ||
    selection?.chainIds?.length ||
    selection?.residueRanges?.length
  );
}

function scoreColorModesForStructure(
  attrs: StructureCapabilityContext | undefined
): StructureVisualizationCapabilities['scoreColorModes'] {
  const score = structureScoreState(attrs);
  return score.colorMode ? [score.colorMode] : [];
}
