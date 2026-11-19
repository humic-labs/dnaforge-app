import { userMessagePayload, userMessagePayloadFromError } from '@waypoint/user-messages';
import {
  preflightStructureSource,
  preflightResolvedStructureBytesWithFallback,
  throwIfAborted,
  raceWithAbort,
} from './source-preflight';
import { StructureElement } from 'molstar/lib/mol-model/structure';
import { isRendererToolError, throwSequenceError, throwStructureError } from './errors';
import { lociForSelection, prepareMolecularInteractionContext } from './interaction-context';
export { lociForSelection } from './interaction-context';
import { z } from 'zod';
import { useStructureLinkRegistry } from '../../structure-drawer/public/state/use-structure-link-registry';
import {
  inspectionProteinKey,
  openStructureInspection,
  retainedStructureInspectionViews,
} from '../../structure-drawer/public/structure-inspection';
import { inspectionViewStatus } from '../../structure-drawer/public/state/structure-inspection-sessions';
import { sha256Hex } from '../../structure-drawer/public/api/protein-identity';
import { requireMolViewSpecSurfaceOwnership } from '../../page/public/embeds/structure3d/molstar/molViewSpec';
import { useCanvasStore } from '../../canvas/public/store';
import { loadCatalogStructure } from '../../compute/public/molecular-catalog';
import { getCurrentWorkspaceScope, type WorkspaceFolder } from '../../../stores/workspaceStore';
import { platform } from '../../../platform';
import { assertMolecularDocumentStorage } from '../../../shared/molecular-document';
import { MolecularStorageError } from '../../../shared/molecular-storage';
import { inspectionMeasurementForLayer } from '../../structure-drawer/public/inspection-measurement-data';
import { loadMolecularDataPublication } from './molecular-data-source';
import {
  saveMolecularDocumentSnapshot,
  inspectMolecularDocumentBinding,
} from '../../molecular-documents/public/services';
import {
  inspectMolecularDocumentParameters,
  editMolecularDocumentParameters,
  retainsMolecularDataColors,
  rebaseMolecularDataParameters,
  requireAppliedMolecularParameterEdits,
} from './document-parameters';
import {
  requireMolecularDocumentTarget,
  molecularDocumentTargetCandidates,
  openMolecularDocumentTarget,
  molecularDocumentReferenceLinks,
} from './document-targets';
import { getEntityReference, getEntityReferenceByLocator } from '../../../db/entity-references';
import {
  coordinateDigest,
  molecularViewSchema,
  validateMolecularViewCoordinates,
  molecularViewFromReferenceData,
  molecularViewAttrs,
  molecularViewSourceForCoordinates,
} from '../../page/public/embeds/structure3d/molecularView';
import { useStructureDrawerStore } from '../../structure-drawer/public';
import { buildStructureDrawerRequestFromCds } from '../../structure-drawer/public/api/build-structure-request';
import type { StructureRef } from '../../structure-drawer/public/types/structure-drawer';
import {
  loadSequenceDocumentBiologyFile,
  normalizeSequenceDocumentId,
  resolveMultiRootPath,
} from '../../ai/public/tools/path-utils';
import { openTabInCanvas } from '../../ai/public/tools/open-tab';
import { sequenceResourceUri } from '../../ai/public/tools/get-sequence';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import type {
  ChainSequence,
  LigandInfo,
  Structure3dAttrs,
  Structure3dColorMode,
  Structure3dSource,
} from '../../page/public/embeds/structure3d/types';
import { extractSequenceDataFromPlugin } from '../../page/public/embeds/structure3d/hooks/useSequenceData';
import {
  ActiveMolstarViewerError,
  getStructureKey,
  getViewerCacheKey,
  getPaneRendererHostCacheKey,
  viewerCache,
  withActivePlugin,
  type ActiveMolstarViewer,
  type MolstarPlugin,
} from '../../page/public/embeds/structure3d/viewerCache';
import {
  extractMolstarSelectionReadback,
  readMolstarLociResidues,
  type MolstarSelectedResidueReadbackEntry,
} from '../../page/public/embeds/structure3d/utils/molstarSelectionReadback';
import {
  molecularScientificReviewInventory,
  recordMolecularScientificScreenshot,
  prepareMolecularScientificReviewForSave,
} from '../../page/public/embeds/structure3d/molstar/molecularScientificReview';
import {
  nativeMolViewSpecColorGroups,
  resolveMolViewSpecColorGroupLociByStructure,
} from '../../page/public/embeds/structure3d/molstar/molViewSpecSwatchSelection';
import { getMolstarPropsFromAttrs } from '../../page/public/embeds/structure3d/utils/molstarPropsUtils';
import { structureKeyOverrideForAttrs } from '../../page/public/embeds/structure3d/utils/structureSourceIdentity';
import {
  colorModeForStructureView,
  representationForStructureView,
  structureViewStateFromAttrs,
  viewRecipeByIdForScene,
} from '../../page/public/embeds/structure3d/utils/viewRecipe';
import {
  attrsPatchFromStructureViewCommand,
  clearStructureChainVisibilityMask,
} from '../../page/public/embeds/structure3d/utils/structureViewCommands';
import {
  MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS,
  molCaptureScreenshotSchema,
  molGetStateSchema,
  molListStructuresSchema,
  molOpenDrawerSchema,
  molOpenTabSchema,
  molSelectionSchema,
  molSetColorSchema,
  molSetRepresentationSchema,
  molSetSideChainsSchema,
  structureTargetRef,
  type StructureSourceInput,
  type MolecularConnectionQuery,
  molApplySceneSchema,
  molActivateViewSchema,
  molAlignStructuresSchema,
  molGetSceneSchema,
  molSaveViewSchema,
  molSelectStoryStepSchema,
  molDataSchema,
  molShowInteractionContextSchema,
} from './contracts';
import {
  prepareMolecularDataPublication,
  compileMolecularDataColors,
  molecularDataViewSchema,
  molecularDataLayerSchema,
  type MolecularDataView,
} from '../../page/public/embeds/structure3d/molecularData';
import {
  molecularDataSceneForPlugin,
  resolveMolecularDataMapping,
  requireDisjointMolecularDataRows,
  molecularDataVisibility,
} from '../../page/public/embeds/structure3d/molstar/molecularDataScene';
import {
  requireDisplayedInteractionContext,
  requireRetainedInteractionContacts,
  requireConstructedInteractionGuides,
} from '../../page/public/embeds/structure3d/molstar/molecularInteractionContext';
import { toolFailure, toolSuccess } from '../tool-result';
import { planMolecularAlignment } from '../../page/public/embeds/structure3d/molstar/molecularAlignment';
import { representedSelectionCoverage } from './representedSelectionCoverage';
import { requireNamedMolecularViews } from '../../page/public/embeds/structure3d/molstar/molecularViewNames';
import {
  FEATURE_EXPOSURE_NOTES,
  FEATURE_EXPOSURE_SAMPLE_BUDGET,
  nativeFeatureExposure,
} from './nativeFeatureExposure';
import {
  activeMolViewSpecScene,
  editMolViewSpecPresentation,
  preserveUneditedMolViewSpecSnapshots,
  preserveEquivalentGeneratedLegendEntries,
  applyMolViewSpecScene,
  getMolViewSpecDataScene,
  acceptSavedMolViewSpecView,
  captureMolViewSpecView,
  validateMolViewSpecViewGeometry,
  waitForMolViewSpecViewReady,
  getMolViewSpecScene,
  activeMolViewSpecCoordinateAssets,
  samePinnedMolViewSpecAssets,
  getMolViewSpecCoordinates,
  sameMolViewSpecDisplayTree,
  sameLoadedMolViewSpecScene,
  requireUnchangedMolViewSpecBackground,
  requireSerializableMolViewSpecVisibility,
  resolveMolViewSpecAgentScene,
  resolveMolViewSpecDataAppearanceScene,
  authorMolViewSpecRoot,
  selectMolViewSpecSnapshot,
  MolViewSpecSceneError,
  type MolViewSpecCameraPolicy,
  type MolViewSpecCaptureOptions,
} from '../../page/public/embeds/structure3d/molstar/molViewSpec';
import {
  isRegisteredStructureAgentVisible,
  type RegisteredStructureVisibilityCandidate,
} from './visibility';

export {
  MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS,
  molCaptureScreenshotSchema,
  molGetStateSchema,
  molListStructuresSchema,
  molOpenDrawerSchema,
  molOpenTabSchema,
  molSelectionSchema,
  molSetColorSchema,
  molSetRepresentationSchema,
  molSetSideChainsSchema,
  molShowInteractionContextSchema,
  isRegisteredStructureAgentVisible,
};

const URL_ALLOWED_HOST_SUFFIXES = ['.rcsb.org', '.ebi.ac.uk'];
const URL_ALLOWED_HOSTS = new Set([
  'files.rcsb.org',
  'models.rcsb.org',
  'alphafold.ebi.ac.uk',
  'modelarchive.org',
]);
const MAX_SCREENSHOT_BYTES = 500 * 1024;
const MAX_SCREENSHOT_DIMENSION = 1024;
const AGENT_REVIEW_SCREENSHOT_DIMENSION = 768;
const SCREENSHOT_RETRY_SCALE = 0.5;

const mcpSelectionByStructureViewId = new Map<string, { selection: string }>();

type RegisteredStructureCandidate = RegisteredStructureVisibilityCandidate;

type OpenTabSourceRef = StructureRef | { kind: 'data'; format: 'pdb' | 'cif'; byteLength: number };

type ResidueRange = { start: number; end: number };

type ChainSummary = {
  chainId: string;
  chainLabel: string;
  baseChain: string | null;
  labelAsymId: string | null;
  authAsymId: string | null;
  entityId: string | null;
  operator: string | null;
  instanceId: string | null;
  residueCount: number;
  residueRange: ResidueRange | null;
  residueRanges: ResidueRange[];
  sequenceLength: number;
};

type ViewerRuntimeSnapshot = {
  viewerStatus: 'active' | 'inactive' | 'loading' | 'error';
  chains: ChainSummary[];
  ligands: LigandInfo[];
  molstarSelectedResidues: MolstarSelectedResidueReadbackEntry[];
  molstarSelectionElementCount: number | null;
  molstarSelectionStatsLabel: string | null;
  camera: ReturnType<NonNullable<MolstarPlugin['canvas3d']>['camera']['getSnapshot']> | null;
  molecularConnections?: ReturnType<typeof getMolViewSpecScene>['native']['molecularConnections'];
  molecularConnectionSummary?: ReturnType<
    typeof getMolViewSpecScene
  >['native']['molecularConnectionSummary'];
  native?: Omit<
    ReturnType<typeof getMolViewSpecScene>['native'],
    'molecularConnections' | 'molecularConnectionSummary'
  >;
  renderProfile?: ReturnType<typeof getMolViewSpecScene>['renderProfile'];
  stateError?: string;
};

type ScreenshotHelperLike = {
  getImageDataUri: () => Promise<string> | string;
  getSizeAndViewport?: () => { width: number; height: number; viewport?: unknown };
  values?: Record<string, unknown>;
  behaviors?: {
    values?: {
      next?: (value: Record<string, unknown>) => void;
    };
  };
};

function rethrowActiveViewerError(error: unknown, viewerId: string): never {
  if (isRendererToolError(error)) {
    throw error;
  }
  if (error instanceof MolViewSpecSceneError) {
    throwStructureError(
      error.code,
      error.message,
      { viewerId },
      error.code === 'VIEWER_NOT_FOUND' || error.code === 'PLUGIN_NOT_READY'
    );
  }
  if (error instanceof ActiveMolstarViewerError) {
    throwStructureError(
      error.code,
      error.message,
      error.details,
      error.code === 'VIEWER_NOT_FOUND'
    );
  }
  throwStructureError(
    'MOLSTAR_RUNTIME_ERROR',
    error instanceof Error ? error.message : String(error),
    { viewerId },
    true
  );
}

function assertAllowedStructureUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throwStructureError('URL_NOT_ALLOWED', 'Structure URL is invalid.', { url });
  }

  if (parsed.protocol !== 'https:') {
    throwStructureError('URL_NOT_ALLOWED', 'Structure URLs must use https.', { url });
  }

  const host = parsed.hostname.toLowerCase();
  const allowed =
    URL_ALLOWED_HOSTS.has(host) ||
    URL_ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) {
    throwStructureError('URL_NOT_ALLOWED', 'Structure URL host is not allow-listed.', { url });
  }
}

function attrsForStructure(
  structure: Exclude<StructureSourceInput, { kind: 'file' }>,
  label?: string
): Structure3dAttrs {
  switch (structure.kind) {
    case 'pdb': {
      const pdbId = structure.pdbId.toUpperCase();
      return {
        id: getStructureKey(pdbId),
        source: 'pdb',
        sourceId: pdbId,
        providerIdentityKey: `RCSB:${pdbId}:ENTRY`,
        pdbId,
        label: label ?? pdbId,
      };
    }
    case 'uniprot': {
      const accession = structure.accession.toUpperCase();
      return {
        id: getStructureKey(undefined, accession),
        source: 'alphafold',
        sourceId: accession,
        uniprotId: accession,
        label: label ?? accession,
      };
    }
    case 'url':
      assertAllowedStructureUrl(structure.url);
      return {
        id: getStructureKey(undefined, undefined, structure.url),
        source: 'url',
        sourceId: structure.url,
        url: structure.url,
        label: label ?? labelFromUrl(structure.url),
      };
    case 'data':
      return {
        id: getStructureKey(undefined, undefined, undefined, structure.data),
        source: 'file',
        sourceId: structure.data,
        label: label ?? `Inline ${structure.format.toUpperCase()}`,
      };
  }
}

function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
  } catch {
    return 'Structure URL';
  }
}

function viewerIdForAttrs(attrs: Structure3dAttrs): string {
  const override = structureKeyOverrideForAttrs(attrs);
  if (override) return override;
  const source = (attrs.source ?? (attrs.uniprotId ? 'alphafold' : attrs.pdbId ? 'pdb' : 'url')) as
    | Structure3dSource
    | undefined;
  const props = source ? getMolstarPropsFromAttrs(source, attrs) : {};
  return getStructureKey(
    props.pdbId,
    props.uniprotId,
    props.url,
    props.structureData,
    props.structureIdentity,
    undefined,
    props.coordinateModel
  );
}

function sourceRefForAttrs(attrs: Structure3dAttrs): StructureRef | null {
  const source = attrs.source as Structure3dSource | undefined;
  if (source === 'pdb' || attrs.pdbId) {
    const pdbId = attrs.pdbId || normalizePdbSourceId(attrs.sourceId);
    if (typeof pdbId !== 'string') return null;
    return {
      kind: 'pdb',
      pdbId,
      providerIdentityKey: attrs.providerIdentityKey,
      pdbEntityId: attrs.pdbEntityId,
      labelAsymIds: attrs.labelAsymIds,
      authAsymIds: attrs.authAsymIds,
      assemblyId: attrs.assemblyId,
    };
  }
  if (source === 'alphafold' || attrs.uniprotId) {
    const accession = attrs.accession || attrs.uniprotId || attrs.sourceId;
    if (typeof accession !== 'string') return null;
    return {
      kind: 'uniprot',
      accession,
      providerIdentityKey: attrs.providerIdentityKey,
      fragment: attrs.fragment,
      version: attrs.version,
      modelId: attrs.modelId,
    };
  }
  if (source === 'url' || attrs.url) {
    const url = attrs.sourceId || attrs.url;
    return typeof url === 'string' ? { kind: 'url', url } : null;
  }
  return null;
}

function normalizePdbSourceId(sourceId: string | undefined): string | undefined {
  if (!sourceId) return undefined;
  const scoped = sourceId.match(/^RCSB:([0-9][A-Z0-9]{3}):ENTRY/i);
  if (scoped) return scoped[1].toUpperCase();
  return sourceId.toUpperCase();
}

function sourceRefForOpenTab(
  structure: StructureSourceInput,
  attrs: Structure3dAttrs
): OpenTabSourceRef | null {
  if (structure.kind === 'data') {
    return {
      kind: 'data',
      format: structure.format,
      byteLength: new TextEncoder().encode(structure.data).byteLength,
    };
  }
  return sourceRefForAttrs(attrs);
}

function listedSourceId(attrs: Structure3dAttrs): string | null {
  if (attrs.source === 'file') return null;
  return typeof attrs.sourceId === 'string' ? attrs.sourceId : null;
}

function residueRangesFromPositions(positions: number[]): ResidueRange[] {
  const sorted = Array.from(new Set(positions)).sort((a, b) => a - b);
  const ranges: ResidueRange[] = [];
  for (const position of sorted) {
    const current = ranges[ranges.length - 1];
    if (current && position === current.end + 1) {
      current.end = position;
    } else {
      ranges.push({ start: position, end: position });
    }
  }
  return ranges;
}

function summarizeChain(chain: ChainSequence): ChainSummary {
  const positions = chain.residues
    .map((residue) => residue.position)
    .filter((position) => Number.isFinite(position));
  const residueRanges = residueRangesFromPositions(positions);
  return {
    chainId: chain.chainId,
    chainLabel: chain.chainLabel,
    baseChain: chain.baseChain ?? null,
    labelAsymId: chain.labelAsymId ?? null,
    authAsymId: chain.authAsymId ?? null,
    entityId: chain.entityId ?? null,
    operator: chain.operator ?? null,
    instanceId: chain.instanceId ?? null,
    residueCount: positions.length,
    residueRange:
      positions.length > 0
        ? {
            start: Math.min(...positions),
            end: Math.max(...positions),
          }
        : null,
    residueRanges,
    sequenceLength: chain.sequence.length,
  };
}

async function activeViewerSnapshot(
  viewerId: string,
  colorMode: Structure3dColorMode,
  preferredCacheKeys: readonly string[] = [],
  expectedScene?: string,
  allowFallback = true,
  includeMolecularDetails = false,
  connectionQuery?: MolecularConnectionQuery,
  comparisonModels = false
): Promise<ViewerRuntimeSnapshot> {
  const readSnapshot = async (cacheKey?: string) =>
    withActivePlugin(
      viewerId,
      (active) => {
        if (
          expectedScene &&
          !sameLoadedMolViewSpecScene(activeMolViewSpecScene(active.plugin), expectedScene)
        ) {
          return {
            viewerStatus: 'loading' as const,
            chains: [],
            ligands: [],
            molstarSelectedResidues: [],
            molstarSelectionElementCount: null,
            molstarSelectionStatsLabel: null,
            camera: null,
          };
        }
        const sequenceData = extractSequenceDataFromPlugin(
          active.plugin,
          colorMode,
          comparisonModels
        );
        const selectionReadback = extractMolstarSelectionReadback(active.plugin);
        const scene = includeMolecularDetails
          ? getMolViewSpecScene(active.plugin, connectionQuery)
          : undefined;
        const details = scene
          ? (() => {
              const { molecularConnections, molecularConnectionSummary, ...native } = scene.native;
              return {
                molecularConnections,
                molecularConnectionSummary,
                native,
                renderProfile: scene.renderProfile,
              };
            })()
          : undefined;
        return {
          viewerStatus: 'active' as const,
          chains: sequenceData?.chains.map(summarizeChain) ?? [],
          ligands: sequenceData?.ligands ?? [],
          molstarSelectedResidues: selectionReadback.residues,
          molstarSelectionElementCount: selectionReadback.elementCount,
          molstarSelectionStatsLabel: selectionReadback.statsLabel,
          camera: active.plugin.canvas3d?.camera?.getSnapshot?.() ?? null,
          ...details,
        };
      },
      cacheKey ? { cacheKey } : undefined
    );

  for (const cacheKey of preferredCacheKeys) {
    try {
      return await readSnapshot(cacheKey);
    } catch (error) {
      if (error instanceof ActiveMolstarViewerError && error.code === 'VIEWER_NOT_FOUND') {
        continue;
      }
      if (error instanceof ActiveMolstarViewerError) {
        return {
          viewerStatus: error.code === 'PLUGIN_NOT_READY' ? 'loading' : 'inactive',
          chains: [],
          ligands: [],
          molstarSelectedResidues: [],
          molstarSelectionElementCount: null,
          molstarSelectionStatsLabel: null,
          camera: null,
        };
      }
      return {
        viewerStatus: 'error',
        chains: [],
        ligands: [],
        molstarSelectedResidues: [],
        molstarSelectionElementCount: null,
        molstarSelectionStatsLabel: null,
        camera: null,
        stateError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!allowFallback) {
    return {
      viewerStatus: 'inactive',
      chains: [],
      ligands: [],
      molstarSelectedResidues: [],
      molstarSelectionElementCount: null,
      molstarSelectionStatsLabel: null,
      camera: null,
    };
  }

  try {
    return await readSnapshot();
  } catch (error) {
    if (error instanceof ActiveMolstarViewerError) {
      return {
        viewerStatus: error.code === 'PLUGIN_NOT_READY' ? 'loading' : 'inactive',
        chains: [],
        ligands: [],
        molstarSelectedResidues: [],
        molstarSelectionElementCount: null,
        molstarSelectionStatsLabel: null,
        camera: null,
      };
    }
    return {
      viewerStatus: 'error',
      chains: [],
      ligands: [],
      molstarSelectedResidues: [],
      molstarSelectionElementCount: null,
      molstarSelectionStatsLabel: null,
      camera: null,
      stateError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function listRegisteredStructures(
  options: {
    target?: string;
    includeMolecularDetails?: boolean;
    connectionQuery?: MolecularConnectionQuery;
  } = {}
) {
  await requireMolecularDocumentTarget(options.target);
  const targetRegistration = options.target
    ? findRegisteredStructure(options.target)?.registrationId
    : undefined;
  const state = useStructure3dStore.getState();
  const registered = await Promise.all(
    Object.entries(state.expandedStructures)
      .map(([registrationId, entry]) => registeredStructureCandidate(registrationId, entry))
      .filter(isRegisteredStructureAgentVisible)
      .filter(
        (candidate) =>
          !options.target ||
          candidate.registrationId === targetRegistration ||
          [
            candidate.viewerId,
            candidate.structureId,
            candidate.structureViewId,
            candidate.bindingId,
          ].includes(options.target)
      )
      .map(async ({ registrationId, structureId, structureViewId, bindingId, entry, viewerId }) => {
        const interactionKey = bindingId ?? structureId;
        const view = structureViewStateFromAttrs(entry.data);
        const colorMode = colorModeForStructureView(view, entry.data);
        const tabHost = findStructureTabHost(registrationId, structureViewId);
        const inspectionStatus = tabHost?.tab.structureInspection
          ? inspectionViewStatus(
              tabHost.tab.id,
              inspectionProteinKey(tabHost.tab.structureInspection.request)
            )
          : null;
        const runtime: ViewerRuntimeSnapshot =
          tabHost && tabHost.panel.activeTabId !== tabHost.tab.id
            ? {
                viewerStatus: 'inactive' as const,
                chains: [],
                ligands: [],
                molstarSelectedResidues: [],
                molstarSelectionElementCount: null,
                molstarSelectionStatsLabel: null,
                camera: null,
              }
            : tabHost?.tab.structureInspection && inspectionStatus !== 'ready'
              ? {
                  viewerStatus:
                    inspectionStatus === 'error' ? ('error' as const) : ('loading' as const),
                  chains: [],
                  ligands: [],
                  molstarSelectedResidues: [],
                  molstarSelectionElementCount: null,
                  molstarSelectionStatsLabel: null,
                  camera: null,
                }
              : await activeViewerSnapshot(
                  viewerId,
                  colorMode,
                  tabHost
                    ? [getPaneRendererHostCacheKey(`pane:${tabHost.panel.id}`, 'loaded')]
                    : viewerCacheKeysForRegisteredStructure(viewerId, structureId, registrationId),
                  entry.data.molViewSpec,
                  !tabHost,
                  options.includeMolecularDetails,
                  options.connectionQuery,
                  !!entry.data.comparisonProvenance
                );
        const selectedResidues = state.interactionState[interactionKey]?.selected ?? [];
        const lastMcpSelectionExpression =
          mcpSelectionByStructureViewId.get(structureViewId)?.selection ?? null;
        return {
          comparison: entry.data.comparisonProvenance
            ? {
                reference: {
                  title: entry.data.comparisonProvenance.reference.title,
                  chainId: 'R',
                  coordinateSha256: entry.data.comparisonProvenance.reference.coordinates.sha256,
                },
                alternate: {
                  title: entry.data.comparisonProvenance.alternate.title,
                  chainId: 'V',
                  coordinateSha256: entry.data.comparisonProvenance.alternate.coordinates.sha256,
                },
                alignment: entry.data.comparisonProvenance.alignment,
                allele: entry.data.comparisonProvenance.allele,
              }
            : null,
          registrationId,
          ...(await inspectMolecularDocumentBinding(entry.data).catch((error) => ({
            documentUnavailable: error instanceof Error ? error.message : String(error),
          }))),
          structureId,
          structureViewId,
          bindingId,
          viewerId,
          label: entry.label,
          source: entry.data.source ?? null,
          sourceId: listedSourceId(entry.data),
          coordinateArtifact: entry.data.structureArtifactRef
            ? {
                entityId: entry.data.structureArtifactRef.entityId,
                revisionId: entry.data.structureArtifactRef.revisionId,
                coordinateDigestSha256: entry.data.structureArtifactRef.coordinateDigestSha256,
                format: entry.data.structureArtifactRef.format,
              }
            : null,
          proteinMapping: (() => {
            const link = Object.values(useStructureLinkRegistry.getState().links).find(
              (link) =>
                link.structureViewId === structureViewId &&
                link.ownerId === entry.data.structureLinkOwnerId
            );
            return link
              ? {
                  proteinSequenceSha256: sha256Hex(link.translation),
                  proteinLength: link.translation.length,
                  label: link.cdsLabel,
                  residueTargets:
                    link.residueTargets ?? (link.residueTarget ? [link.residueTarget] : []),
                  measurements: entry.data.measurements ?? [],
                  activeMeasurementId: entry.data.activeMeasurementId,
                }
              : null;
          })(),
          sceneFormat: entry.data.molViewSpec ? 'molviewspec' : 'recipe',
          representation: entry.data.molViewSpec
            ? 'molviewspec'
            : representationForStructureView(view),
          colorMode: entry.data.molViewSpec ? 'molviewspec' : colorMode,
          sideChains: {
            visibleBackbones: view.residueVisualization?.sideChains?.visibleBackbones ?? false,
            selection: view.residueVisualization?.sideChains?.selection ?? false,
          },
          selectedResidues,
          currentSelection: {
            selection: null,
            lastMcpSelectionExpression,
            selectedResidues,
            molstarSelectedResidues: runtime.molstarSelectedResidues,
            molstarElementCount: runtime.molstarSelectionElementCount,
            molstarStatsLabel: runtime.molstarSelectionStatsLabel,
          },
          viewerStatus: runtime.viewerStatus,
          chains: runtime.chains,
          ligands: runtime.ligands,
          camera: runtime.camera,
          ...(options.includeMolecularDetails
            ? {
                molecularConnections: runtime.molecularConnections ?? null,
                molecularConnectionSummary: runtime.molecularConnectionSummary ?? null,
                native: runtime.native ?? null,
                renderProfile: runtime.renderProfile ?? null,
              }
            : {}),
          ...(runtime.stateError ? { stateError: runtime.stateError } : {}),
        };
      })
  );

  const retained = retainedStructureInspectionViews().filter(
    (item) =>
      (!options.target || item.structureViewId === options.target) &&
      !registered.some((entry) => entry.structureViewId === item.structureViewId)
  );
  return [
    ...registered,
    ...retained.map((item) => ({
      structureViewId: item.structureViewId,
      label: item.request.cdsLabel ?? 'Protein',
      viewerStatus: 'inactive' as const,
      inactiveReason: 'Another protein is displayed in this linked inspection pane.',
      reactivation: { tool: 'mol_activate_view', structureViewId: item.structureViewId },
      savedViewReferenceId: item.view.savedViewReferenceId ?? null,
      retainedProtein: {
        proteinSequenceSha256: sha256Hex(item.request.translation),
        proteinLength: item.request.translation.length,
        candidateId: item.view.candidateId,
        measurements: item.view.measurements ?? [],
        activeMeasurementId: item.view.activeMeasurementId,
      },
      chains: [],
      ligands: [],
      camera: null,
      ...(options.includeMolecularDetails
        ? {
            native: null,
            renderProfile: null,
            molecularConnections: null,
            molecularConnectionSummary: null,
          }
        : {}),
    })),
  ];
}

function viewerCacheKeysForRegisteredStructure(
  viewerId: string,
  structureId: string,
  registrationId = structureId
): string[] {
  return [
    ...new Set([
      getViewerCacheKey(viewerId, `structure-panel:${registrationId}`),
      getViewerCacheKey(viewerId, `structure-panel:${structureId}`),
      getViewerCacheKey(viewerId, `embed:${structureId}`),
    ]),
  ];
}

function registeredStructureCandidate(
  registrationId: string,
  entry: ReturnType<typeof useStructure3dStore.getState>['expandedStructures'][string]
): RegisteredStructureCandidate {
  const structureId =
    entry.data.structureBinding?.structureId ??
    entry.data.structureArtifactRef?.structureId ??
    registrationId;
  const structureViewId = entry.data.structureViewIdentity?.structureViewId ?? registrationId;
  const bindingId = entry.data.structureBinding?.bindingId ?? null;
  return {
    registrationId,
    structureId,
    structureViewId,
    bindingId,
    interactionKey: bindingId ?? structureId,
    viewerId: viewerIdForAttrs(entry.data),
    entry,
  };
}

function findStructureTabHost(registrationId: string, structureViewId: string) {
  const ownerId =
    useStructure3dStore.getState().expandedStructures[registrationId]?.data.structureLinkOwnerId;
  const canvas = useCanvasStore.getState();
  const hosts = Object.values(canvas.panels).flatMap((panel) =>
    panel.tabs
      .filter(
        (candidate) =>
          candidate.type === 'structure' &&
          (candidate.entityId === registrationId ||
            candidate.initialStructureAttrs?.structureViewIdentity?.structureViewId ===
              structureViewId ||
            (!!candidate.structureInspection && ownerId?.endsWith(`\u0000${candidate.id}`)))
      )
      .map((tab) => ({ panel, tab }))
  );
  return (
    hosts.find(
      ({ panel, tab }) => panel.id === canvas.focusedPanelId && panel.activeTabId === tab.id
    ) ??
    hosts.find(({ panel, tab }) => panel.activeTabId === tab.id) ??
    hosts[0] ??
    null
  );
}

function requireActiveStructureTab(registrationId: string, structureViewId: string) {
  const host = findStructureTabHost(registrationId, structureViewId);
  if (host && host.panel.activeTabId !== host.tab.id) {
    throw new MolViewSpecSceneError(
      'VIEW_NOT_ACTIVE',
      `Structure view ${structureViewId} is open but its tab is not active. Call mol_activate_view with structureViewId "${structureViewId}", then retry this scene command.`
    );
  }
  return host;
}

function findRegisteredStructure(viewerId: string) {
  const state = useStructure3dStore.getState();
  const candidates = Object.entries(state.expandedStructures)
    .map(([registrationId, entry]) => registeredStructureCandidate(registrationId, entry))
    .filter(isRegisteredStructureAgentVisible);

  const documentViews = molecularDocumentTargetCandidates(viewerId, candidates);
  const exactViews = candidates.filter(
    (candidate) => candidate.registrationId === viewerId || candidate.structureViewId === viewerId
  );
  const exactBindings = candidates.filter((candidate) => candidate.bindingId === viewerId);
  const matches = documentViews
    ? documentViews
    : exactViews.length
      ? exactViews
      : exactBindings.length
        ? exactBindings
        : candidates.filter(
            (candidate) => candidate.structureId === viewerId || candidate.viewerId === viewerId
          );
  if (matches.length > 1) {
    throwStructureError(
      'AMBIGUOUS_VIEWER',
      `Structure reference ${viewerId} matches multiple logical views. Use structureViewId or bindingId.`,
      {
        viewerId,
        candidates: matches.map((candidate) => ({
          structureViewId: candidate.structureViewId,
          bindingId: candidate.bindingId,
          structureId: candidate.structureId,
        })),
      }
    );
  }
  return matches[0] ?? null;
}

function ensureOpenSequenceTab(inputDocumentId: string): string {
  const documentId = normalizeSequenceDocumentId(inputDocumentId);
  const open = Boolean(useCanvasStore.getState().findTab('sequence', documentId));

  if (!open) {
    throwSequenceError('SEQUENCE_NOT_OPEN', 'Sequence must be open in a tab.', {
      documentId,
    });
  }
  return documentId;
}

function imageBytesFromBase64(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function parseScreenshotDataUri(dataUri: string, viewerId: string) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
  if (!match) {
    throwStructureError('RENDER_ERROR', 'Mol* screenshot did not return a base64 data URI.', {
      viewerId,
    });
  }

  const [, mimeType, data] = match;
  return {
    mimeType,
    data,
    byteLength: imageBytesFromBase64(data),
  };
}

function fitScreenshotSize(width: number, height: number, scale: number) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : MAX_SCREENSHOT_DIMENSION;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : MAX_SCREENSHOT_DIMENSION;
  const maxDimension = Math.max(safeWidth, safeHeight);
  const capScale = Math.min(1, MAX_SCREENSHOT_DIMENSION / maxDimension);
  return {
    width: Math.max(1, Math.floor(safeWidth * capScale * scale)),
    height: Math.max(1, Math.floor(safeHeight * capScale * scale)),
  };
}

function canvasScreenshotDataUri(
  canvas: HTMLCanvasElement,
  target: { width: number; height: number }
): string {
  if (canvas.width === target.width && canvas.height === target.height) {
    return canvas.toDataURL('image/png');
  }

  const output = document.createElement('canvas');
  output.width = target.width;
  output.height = target.height;
  const context = output.getContext('2d');
  if (!context) {
    throwStructureError('RENDER_ERROR', 'Could not create screenshot canvas context.');
  }
  context.drawImage(canvas, 0, 0, target.width, target.height);
  return output.toDataURL('image/png');
}

async function screenshotDataUri(
  active: ActiveMolstarViewer,
  scale = 1
): Promise<{ dataUri: string; width: number | null; height: number | null; downscaled: boolean }> {
  active.plugin.canvas3d?.commit(true);
  const helper = active.plugin.helpers.viewportScreenshot as ScreenshotHelperLike | undefined;
  if (helper) {
    const viewport = helper.getSizeAndViewport?.();
    if (viewport && helper.behaviors?.values?.next) {
      const side = Math.max(1, Math.floor(AGENT_REVIEW_SCREENSHOT_DIMENSION * scale));
      const target = { width: side, height: side };
      const originalValues = helper.values;
      const nextValues = {
        ...(originalValues ?? {}),
        resolution: { name: 'custom', params: target },
        format: { name: 'png', params: {} },
      };
      helper.behaviors.values.next(nextValues);
      try {
        return {
          dataUri: await helper.getImageDataUri(),
          width: target.width,
          height: target.height,
          downscaled: scale < 1 || target.width < viewport.width || target.height < viewport.height,
        };
      } finally {
        if (originalValues) {
          helper.behaviors.values.next(originalValues);
        }
      }
    }

    return {
      dataUri: await helper.getImageDataUri(),
      width: null,
      height: null,
      downscaled: scale < 1,
    };
  }

  const canvas = active.container.querySelector('canvas');
  if (canvas instanceof HTMLCanvasElement) {
    const target = fitScreenshotSize(canvas.width, canvas.height, scale);
    return {
      dataUri: canvasScreenshotDataUri(canvas, target),
      width: target.width,
      height: target.height,
      downscaled: scale < 1 || target.width < canvas.width || target.height < canvas.height,
    };
  }

  throwStructureError('RENDER_ERROR', 'Mol* screenshot helper is unavailable.', {
    viewerId: active.structureKey,
  });
}

async function executeMolOpenTab(
  args: unknown,
  context: { folders?: WorkspaceFolder[]; abortSignal?: AbortSignal } = {}
) {
  throwIfAborted(context.abortSignal);
  const input = molOpenTabSchema.parse(args);
  const { label } = input;
  if (input.documentReference) {
    return openMolecularDocumentTarget(input.documentReference, context);
  }
  const structure = input.structure!;
  if (structure.kind === 'file') {
    const folders = context.folders ?? [];
    const { absolutePath } = resolveMultiRootPath(folders, structure.path);
    throwIfAborted(context.abortSignal);
    const opened = await openTabInCanvas(
      {
        type: 'structure',
        entityId: absolutePath,
        label: label ?? absolutePath.split('/').pop() ?? 'Structure',
      },
      folders,
      { signal: context.abortSignal }
    );
    throwIfAborted(context.abortSignal);
    const tab = Object.values(useCanvasStore.getState().panels)
      .flatMap((panel) => panel.tabs)
      .find((item) => item.id === opened.tabId);
    if (
      opened.error ||
      !tab ||
      tab.type !== 'structure' ||
      tab.loadStatus === 'missing' ||
      tab.loadStatus === 'error'
    ) {
      throwStructureError(
        'FILE_UNAVAILABLE',
        opened.error ??
          tab?.initialStructureAttrs?.error ??
          'Coordinate file is missing or unreadable.',
        { path: absolutePath, tabId: opened.tabId || null }
      );
    }
    return toolSuccess({
      tabId: tab.id,
      label: tab.label,
      structureViewId: tab.entityId,
      source: { kind: 'file' as const, path: absolutePath },
      viewerStatus: 'loading' as const,
      next: 'Use mol_list_structures to inspect the loaded native viewer before selecting or editing its scene.',
    });
  }
  const preflightAttrs = await preflightStructureSource(structure, context.abortSignal);
  throwIfAborted(context.abortSignal);
  const attrs = { ...attrsForStructure(structure, label), ...preflightAttrs };
  const viewerId = viewerIdForAttrs(attrs) || String(attrs.id ?? '');
  attrs.id = viewerId;
  const tabLabel = attrs.label ?? viewerId;

  throwIfAborted(context.abortSignal);
  useStructure3dStore.getState().registerStructure(viewerId, attrs, tabLabel);
  const tabId = useCanvasStore
    .getState()
    .openAgentContentTab('structure', viewerId, tabLabel, attrs);

  return toolSuccess({
    viewerId,
    tabId,
    label: tabLabel,
    source: sourceRefForOpenTab(structure, attrs),
  });
}

async function executeMolOpenDrawer(
  args: unknown,
  context: { folders: WorkspaceFolder[]; abortSignal?: AbortSignal }
) {
  throwIfAborted(context.abortSignal);
  const { documentId: inputDocumentId, annotationIndex } = molOpenDrawerSchema.parse(args);
  const documentId = ensureOpenSequenceTab(inputDocumentId);
  throwIfAborted(context.abortSignal);
  const loaded = await loadSequenceDocumentBiologyFile(documentId, context.folders);
  const parsed = loaded.biology;
  throwIfAborted(context.abortSignal);
  const annotated = parsed.sequence;
  const feature = parsed.features[annotationIndex];
  const cds =
    feature &&
    annotated.annotations?.find(
      (annotation) =>
        annotation.start === feature.start &&
        annotation.end === feature.end &&
        annotation.type === feature.type
    );
  if (!cds) {
    throwSequenceError('BAD_ANNOTATION_INDEX', 'No annotation exists at the requested index.', {
      annotationIndex,
      featureCount: parsed.features.length,
    });
  }

  const request = buildStructureDrawerRequestFromCds({
    cds,
    sequence: annotated,
    entityId: loaded.documentId,
  });
  if (cds.type !== 'CDS' || !request) {
    throwSequenceError('BAD_ANNOTATION_INDEX', 'Annotation is not a CDS with a translation.', {
      annotationIndex,
      type: cds.type,
    });
  }

  await raceWithAbort(useStructureDrawerStore.getState().open(request), context.abortSignal, () =>
    useStructureDrawerStore.getState().close()
  );
  throwIfAborted(context.abortSignal);

  let state = useStructureDrawerStore.getState();
  if (state.status === 'no_match') {
    throwStructureError('NO_RESOLVER_MATCH', 'No structure resolver match was found.', {
      documentId: loaded.documentId,
      annotationIndex,
    });
  }
  if (state.status === 'error') {
    const providerFailure = state.error?.code === 'provider_error';
    throwStructureError(
      providerFailure ? 'PROVIDER_ERROR' : 'NO_RESOLVER_MATCH',
      state.error?.message ?? 'Structure resolver failed.',
      {
        documentId: loaded.documentId,
        annotationIndex,
        code: state.error?.code,
      },
      providerFailure
    );
  }
  let bytesReady = false;
  if (state.status === 'rendering' && state.resolved?.structure) {
    try {
      await raceWithAbort(
        preflightResolvedStructureBytesWithFallback(
          state.requestId,
          state.resolved.structure,
          context.abortSignal
        ),
        context.abortSignal,
        () => useStructureDrawerStore.getState().close()
      );
      state = useStructureDrawerStore.getState();
      throwIfAborted(context.abortSignal);
      bytesReady = true;
    } catch (error) {
      if ((error as Error).name === 'AbortError' || context.abortSignal?.aborted) {
        useStructureDrawerStore.getState().close();
        throw error;
      }
      const providerFailure = (error as Error).name === 'SidecarProviderError';
      throwStructureError(
        providerFailure ? 'PROVIDER_ERROR' : 'STRUCTURE_RENDER_ERROR',
        error instanceof Error ? error.message : 'Structure bytes preflight failed.',
        {
          documentId: loaded.documentId,
          annotationIndex,
          status: state.status,
          resolved: state.resolved,
        },
        providerFailure
      );
    }
  }

  return toolSuccess({
    status: state.status,
    bytesReady,
    documentId: loaded.documentId,
    resourceUri: sequenceResourceUri(loaded.documentId),
    annotationIndex,
    resolved: state.resolved,
  });
}

async function executeMolListStructures() {
  return toolSuccess({ structures: await listRegisteredStructures() });
}

export interface RegisteredStructureSelectionContext {
  registrationId: string;
  structureId: string;
  structureViewId: string;
  bindingId: string | null;
  interactionKey: string;
  attrs: Structure3dAttrs;
  chains: ChainSequence[];
  selectedResidues: ReturnType<
    typeof useStructure3dStore.getState
  >['interactionState'][string]['selected'];
}

export function registeredStructureRefForView(
  molecularDocumentPath: string,
  previousRegistrationId?: string
): string | null {
  const matches = Object.entries(useStructure3dStore.getState().expandedStructures).filter(
    ([, entry]) => entry?.data?.molecularDocumentPath === molecularDocumentPath
  );
  const match =
    matches.find(([registrationId]) => registrationId !== previousRegistrationId) ?? matches[0];
  return match ? registeredStructureCandidate(match[0], match[1]).structureId : null;
}

export async function getRegisteredStructureSelectionContext(
  structureRef?: string
): Promise<RegisteredStructureSelectionContext> {
  const state = useStructure3dStore.getState();
  const registered = Object.entries(state.expandedStructures)
    .map(([registrationId, entry]) => registeredStructureCandidate(registrationId, entry))
    .filter(isRegisteredStructureAgentVisible);
  const matches = structureRef
    ? registered.filter(
        (candidate) =>
          candidate.registrationId === structureRef ||
          candidate.structureId === structureRef ||
          candidate.structureViewId === structureRef ||
          candidate.bindingId === structureRef ||
          candidate.viewerId === structureRef
      )
    : registered;
  if (matches.length === 0) {
    throw new Error(
      structureRef
        ? `No registered structure matches ${structureRef}`
        : 'No registered structure is open'
    );
  }
  if (matches.length > 1) {
    throw new Error(
      structureRef
        ? `Structure reference is ambiguous: ${structureRef}`
        : 'More than one structure is open; provide structureRef'
    );
  }
  const match = matches[0];
  const colorMode = colorModeForStructureView(
    structureViewStateFromAttrs(match.entry.data),
    match.entry.data
  );
  const readChains = (active: ActiveMolstarViewer) =>
    extractSequenceDataFromPlugin(active.plugin, colorMode, !!match.entry.data.comparisonProvenance)
      ?.chains ?? [];
  let chains: ChainSequence[] | null = null;
  for (const cacheKey of viewerCacheKeysForRegisteredStructure(
    match.viewerId,
    match.structureId,
    match.registrationId
  )) {
    try {
      chains = await withActivePlugin(match.viewerId, readChains, { cacheKey });
      break;
    } catch (error) {
      if (error instanceof ActiveMolstarViewerError && error.code === 'VIEWER_NOT_FOUND') {
        continue;
      }
      throw error;
    }
  }
  if (!chains) chains = await withActivePlugin(match.viewerId, readChains);
  if (chains.length === 0) throw new Error('Structure residue inventory is not ready');

  return {
    registrationId: match.registrationId,
    structureId: match.structureId,
    structureViewId: match.structureViewId,
    bindingId: match.bindingId,
    interactionKey: match.interactionKey,
    attrs: match.entry.data,
    chains,
    selectedResidues: state.interactionState[match.interactionKey]?.selected ?? [],
  };
}

async function executeMolGetState(args: unknown) {
  const target = molGetStateSchema.parse(args);
  const viewerId = structureTargetRef(target);
  const filtered = await listRegisteredStructures({
    target: viewerId,
    includeMolecularDetails: true,
    connectionQuery: target.connectionQuery,
  });
  if (viewerId && filtered.length === 0) {
    throwStructureError('VIEWER_NOT_FOUND', `No registered structure with id ${viewerId}.`, {
      viewerId,
    });
  }

  return toolSuccess({ structures: filtered });
}

export async function handleMolActivateView(args: unknown) {
  try {
    const { structureViewId } = molActivateViewSchema.parse(args);
    const retained = retainedStructureInspectionViews().filter(
      (item) => item.structureViewId === structureViewId
    );
    if (retained.length > 1)
      throw new MolViewSpecSceneError(
        'AMBIGUOUS_VIEWER',
        `More than one retained inspection matches ${structureViewId}.`
      );
    if (retained.length === 1) {
      const item = retained[0];
      const error = openStructureInspection(item.request, item.view.selections, item.view);
      if (error) throw new MolViewSpecSceneError('VIEWER_NOT_FOUND', error);

      const currentInspection = () => {
        const panel = useCanvasStore.getState().panels[item.panelId];
        const inspection = panel?.tabs.find((tab) => tab.id === item.tabId)?.structureInspection;
        if (
          panel?.activeTabId !== item.tabId ||
          !inspection ||
          inspection.request.entityId !== item.request.entityId ||
          inspectionProteinKey(inspection.request) !== item.proteinKey ||
          inspection.candidateId !== item.view.candidateId ||
          inspection.savedViewReferenceId !== item.view.savedViewReferenceId
        )
          throw new MolViewSpecSceneError(
            'VIEW_CHANGED',
            'The selected protein or snapshot changed during activation.',
            true
          );
        return inspection;
      };
      const deadline = Date.now() + 30_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const inspection = currentInspection();
        const settings = inspection.viewSettings;
        if (
          !settings ||
          settings.candidateId !== item.view.candidateId ||
          !settings.structureViewId
        )
          continue;
        const [native] = await listRegisteredStructures({ target: settings.structureViewId });
        const latest = currentInspection();
        if (
          latest.viewSettings?.structureViewId === settings.structureViewId &&
          native?.viewerStatus === 'active' &&
          native.chains.length > 0
        )
          return toolSuccess({
            structureViewId: native.structureViewId,
            requestedStructureViewId: structureViewId,
            panelId: item.panelId,
            tabId: item.tabId,
            viewerStatus: 'active',
            message: 'Retained inspection activated. Use the returned native structureViewId.',
          });
      } while (Date.now() < deadline);
      throw new MolViewSpecSceneError(
        'PLUGIN_NOT_READY',
        'The selected inspection is still preparing its native scene. Inspect mol_list_structures for its current view ID and readiness.',
        true
      );
    }
    const hosts = Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
      panel.tabs
        .filter(
          (tab) =>
            tab.type === 'structure' &&
            (tab.entityId === structureViewId ||
              tab.initialStructureAttrs?.structureViewIdentity?.structureViewId === structureViewId)
        )
        .map((tab) => ({ panel, tab }))
    );
    if (hosts.length === 0) {
      const found = findRegisteredStructure(structureViewId);
      if (found) {
        const host = findStructureTabHost(found.registrationId, found.structureViewId);
        if (host) {
          useCanvasStore.getState().setActiveTab(host.panel.id, host.tab.id);
          return toolSuccess({
            structureViewId: found.structureViewId,
            panelId: host.panel.id,
            tabId: host.tab.id,
          });
        }
        const cacheKey = getViewerCacheKey(
          found.viewerId,
          `structure-panel:${found.registrationId}`
        );
        return await withActivePlugin(
          found.viewerId,
          (active) => {
            if (active.wrapper.dataset.proteinExperimentView !== structureViewId)
              throw new MolViewSpecSceneError(
                'VIEWER_NOT_FOUND',
                `No open structure tab matches ${structureViewId}.`
              );
            return toolSuccess({ structureViewId, surface: 'background-worker' });
          },
          { cacheKey }
        );
      }
    }
    if (hosts.length !== 1) {
      throw new MolViewSpecSceneError(
        hosts.length ? 'AMBIGUOUS_VIEWER' : 'VIEWER_NOT_FOUND',
        hosts.length
          ? `More than one open structure tab matches ${structureViewId}.`
          : `No open structure tab matches ${structureViewId}.`
      );
    }
    const { panel, tab } = hosts[0];
    useCanvasStore.getState().setActiveTab(panel.id, tab.id);
    return toolSuccess({ structureViewId, panelId: panel.id, tabId: tab.id });
  } catch (error) {
    return sceneToolFailure(error);
  }
}

function sceneToolFailure(error: unknown, nativeApplied = false) {
  const publicMessage = userMessagePayloadFromError(error);
  const code =
    error instanceof MolViewSpecSceneError || error instanceof ActiveMolstarViewerError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'MVS_OPERATION_FAILED';
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);
  return toolFailure({
    code,
    error: message,
    ...(publicMessage
      ? { userMessagePayload: publicMessage }
      : code === 'DOCUMENT_OWNER_REQUIRED'
        ? { userMessagePayload: userMessagePayload('molecular.documentUnlinked') }
        : {}),
    retriable: code === 'PLUGIN_NOT_READY',
    stateChanged:
      error instanceof MolViewSpecSceneError
        ? error.stateChanged
        : nativeApplied
          ? 'unknown'
          : false,
    partialEffects: nativeApplied ? ['native-scene-rendered'] : [],
  });
}

async function withSceneTarget<T>(
  target: string,
  operation: (active: ActiveMolstarViewer) => Promise<T> | T,
  options: {
    waitForViewReady?: boolean;
    readOnly?: boolean;
    copy?: boolean;
    inspectsDocumentBinding?: boolean;
  } = {}
): Promise<T> {
  const documentReference = await requireMolecularDocumentTarget(target);
  const found = findRegisteredStructure(target);
  if (!found) {
    const retained = retainedStructureInspectionViews().filter(
      (item) => item.structureViewId === target
    );
    if (retained.length > 1)
      throw new MolViewSpecSceneError(
        'AMBIGUOUS_VIEWER',
        `More than one retained inspection matches ${target}.`
      );
    if (retained.length === 1)
      throw new MolViewSpecSceneError(
        'VIEW_NOT_ACTIVE',
        `Structure view ${target} is retained but its protein inspection is not active. Call mol_activate_view with structureViewId "${target}", wait for mol_get_state to report it active, then retry this scene command.`
      );
    throw new MolViewSpecSceneError(
      'VIEWER_NOT_FOUND',
      `No open structure view matches ${target}.`
    );
  }
  if (found.entry.data.molecularDocumentHistoricalRevisionId && !options.readOnly && !options.copy)
    throw new MolViewSpecSceneError(
      'HISTORICAL_DOCUMENT_READ_ONLY',
      'This exact historical document revision is read-only. Open the current document or explicitly copy it.'
    );
  if (
    !options.readOnly &&
    !options.copy &&
    !found.entry.data.molecularDocumentId &&
    found.entry.data.molViewSpecSavedReferenceId
  )
    throw new MolViewSpecSceneError(
      'DOCUMENT_OWNER_REQUIRED',
      'Reopen this legacy result through its verified molecular document reference before editing or saving it.'
    );
  if (found.entry.data.molecularDocumentId && !options.inspectsDocumentBinding)
    await inspectMolecularDocumentBinding(found.entry.data);
  const host = requireActiveStructureTab(found.registrationId, found.structureViewId);
  if (
    host?.tab.structureInspection &&
    inspectionViewStatus(
      host.tab.id,
      inspectionProteinKey(host.tab.structureInspection.request)
    ) !== 'ready'
  )
    throw new MolViewSpecSceneError(
      'PLUGIN_NOT_READY',
      'The selected protein inspection is still preparing its initial scene. Wait for mol_get_state to report it active, then retry.'
    );
  const detachedCacheKey = getViewerCacheKey(
    found.viewerId,
    `structure-panel:${found.registrationId}`
  );

  return withActivePlugin(
    found.viewerId,
    async (active) => {
      if (options.waitForViewReady && found.entry.data.molViewSpec)
        await waitForMolViewSpecViewReady(active.plugin);
      const current = findRegisteredStructure(target);
      if (!current) throw new MolViewSpecSceneError('VIEW_CHANGED', 'The structure view closed.');
      requireActiveStructureTab(current.registrationId, current.structureViewId);
      if (documentReference?.viewId) {
        const scene = getMolViewSpecScene(active.plugin);
        const saved = JSON.parse(scene.scene);
        const view =
          saved.kind === 'multiple' ? saved.snapshots[scene.story?.activeIndex ?? 0] : saved;
        if (view.metadata?.key !== documentReference.viewId)
          throw new MolViewSpecSceneError(
            'VIEW_NOT_ACTIVE',
            'Activate the exact named document view before changing or inspecting its parameters.'
          );
      }
      if (
        current.entry.data.molViewSpec &&
        !sameLoadedMolViewSpecScene(
          activeMolViewSpecScene(active.plugin),
          current.entry.data.molViewSpec
        )
      ) {
        throw new MolViewSpecSceneError(
          'PLUGIN_NOT_READY',
          'The selected structure tab is still loading its saved scene.'
        );
      }
      const result = await operation(active);
      requireActiveStructureTab(current.registrationId, current.structureViewId);
      return result;
    },
    host
      ? { cacheKey: getPaneRendererHostCacheKey(`pane:${host.panel.id}`, 'loaded') }
      : viewerCache.has(detachedCacheKey)
        ? { cacheKey: detachedCacheKey }
        : undefined
  );
}

export async function handleMolGetScene(args: unknown) {
  try {
    const input = molGetSceneSchema.parse(args);
    const target = structureTargetRef(input)!;
    return await withSceneTarget(
      target,
      async (active) => {
        const registered = findRegisteredStructure(target)!;
        const { coordinates, pinnedAssets } = activeMolViewSpecCoordinateAssets(active.plugin);
        const binding = await inspectMolecularDocumentBinding(registered.entry.data, [
          coordinates,
          ...pinnedAssets,
        ]);
        const scene = getMolViewSpecScene(active.plugin, input.connectionQuery);
        const activeIndex = scene.story?.activeIndex ?? 0;
        const groups = nativeMolViewSpecColorGroups(active.plugin, scene.scene, activeIndex);
        const hiddenChains = registered.entry.data.view?.hiddenChainInstanceIds ?? [];
        return toolSuccess({
          structureViewId: registered.structureViewId,
          ...binding,
          ...(input.includeParameterSchema
            ? {
                parameterSchema: await inspectMolecularDocumentParameters(scene.scene, {
                  offset: input.parameterOffset,
                  limit: input.parameterLimit,
                }),
              }
            : {}),
          savedReferenceId: registered.entry.data.molViewSpecSavedReferenceId ?? null,
          ...scene,
          scientificReviewInventory: await molecularScientificReviewInventory(
            scene.scene,
            active.plugin,
            {
              index: activeIndex,
              groups,
            }
          ),
          ...(input.includeColorGroupSelections
            ? {
                featureExposureNotes: FEATURE_EXPOSURE_NOTES,
                namedColorGroupSelections: groups.map((group) => {
                  if (!group.selectable)
                    return {
                      label: group.label,
                      color: `#${group.color.toString(16).padStart(6, '0')}`,
                      ...(group.presentationRole
                        ? { presentationRole: group.presentationRole }
                        : {}),
                      selectable: false,
                      frontmostAtSampledCenters: {
                        status: 'unavailable',
                        reason: 'The named feature has no exact atomic selector.',
                      },
                    };
                  try {
                    const selections = resolveMolViewSpecColorGroupLociByStructure(
                      active.plugin,
                      group,
                      hiddenChains
                    );
                    const residues = selections.flatMap(({ structureRef, loci }) =>
                      readMolstarLociResidues(loci).map((residue) => ({ ...residue, structureRef }))
                    );
                    return {
                      label: group.label,
                      color: `#${group.color.toString(16).padStart(6, '0')}`,
                      ...(group.presentationRole
                        ? { presentationRole: group.presentationRole }
                        : {}),
                      selectable: true,
                      atomCount: selections.reduce(
                        (sum, { loci }) => sum + StructureElement.Loci.size(loci),
                        0
                      ),
                      residueCount: residues.length,
                      residues: residues.slice(0, 32),
                      truncated: residues.length > 32,
                      frontmostAtSampledCenters: nativeFeatureExposure(
                        active.plugin,
                        selections,
                        Math.min(64, Math.floor(FEATURE_EXPOSURE_SAMPLE_BUDGET / groups.length))
                      ),
                    };
                  } catch (error) {
                    return {
                      label: group.label,
                      color: `#${group.color.toString(16).padStart(6, '0')}`,
                      ...(group.presentationRole
                        ? { presentationRole: group.presentationRole }
                        : {}),
                      selectable: false,
                      frontmostAtSampledCenters: {
                        status: 'unavailable',
                        reason: 'The exact named feature selection could not be resolved.',
                      },
                      error:
                        error instanceof Error
                          ? error.message
                          : 'The exact color group could not be resolved.',
                    };
                  }
                }),
              }
            : {}),
        });
      },
      { readOnly: true, inspectsDocumentBinding: true }
    );
  } catch (error) {
    return sceneToolFailure(error);
  }
}

export async function handleMolAlignStructures(args: unknown) {
  try {
    const input = molAlignStructuresSchema.parse(args);
    const plan = await withSceneTarget(input.structureViewId, (active) => {
      const current = getMolViewSpecScene(active.plugin);
      return {
        expectedScene: current.scene,
        index: current.story?.activeIndex ?? 0,
        ...planMolecularAlignment(
          active.plugin,
          current.scene,
          current.story?.activeIndex ?? 0,
          input.referenceStructureRef,
          input.mobileStructureRef,
          input.referenceRegion,
          input.mobileRegion,
          input.maximumRmsd
        ),
      };
    });
    const applied = await handleMolApplyScene(
      { structureViewId: input.structureViewId, scene: plan.scene, viewAction: 'replace' },
      {
        expectedScene: plan.expectedScene,
        initialSnapshotIndex: plan.index,
        validateNative: plan.validateNative,
        nativeAlignmentChange: true,
      }
    );
    return applied.ok ? toolSuccess({ ...applied, alignment: plan.provenance }) : applied;
  } catch (error) {
    return sceneToolFailure(error);
  }
}

const dataApplyIntents = new Map<string, number>();
function persistMolecularDataTarget(target: string, next: Structure3dAttrs): void {
  const current = findRegisteredStructure(target);
  if (!current)
    throw new MolViewSpecSceneError(
      'VIEW_CHANGED',
      'The molecular view closed before persistence.'
    );
  requireActiveStructureTab(current.registrationId, current.structureViewId);
  useStructure3dStore.getState().updateStructureData(current.registrationId, next);
  for (const panel of Object.values(useCanvasStore.getState().panels))
    for (const tab of panel.tabs) {
      if (
        tab.type === 'structure' &&
        (tab.initialStructureAttrs?.structureViewIdentity?.structureViewId ===
          current.structureViewId ||
          tab.entityId === current.registrationId)
      )
        useCanvasStore.getState().updateTab(panel.id, tab.id, { initialStructureAttrs: next });
    }
}

export async function handleMolData(args: unknown, context: { folders?: WorkspaceFolder[] } = {}) {
  let nativeApplied = false;
  try {
    const input = molDataSchema.parse(args);
    const target = structureTargetRef(input)!;
    return await withSceneTarget(
      target,
      async (active) => {
        const before = findRegisteredStructure(target)!;
        const currentScene = getMolViewSpecScene(active.plugin);
        const cameraBefore = JSON.stringify(active.plugin.canvas3d?.camera.getSnapshot());
        const coordinateSha256 = await coordinateDigest(
          getMolViewSpecCoordinates(active.plugin).text
        );
        const data: MolecularDataView = before.entry.data.molecularData ?? {
          version: 1,
          datasets: [],
          mappings: [],
          layers: [],
        };
        const current = () =>
          findRegisteredStructure(target)?.entry.data.molecularData ===
          before.entry.data.molecularData;
        if (!current())
          throw new MolViewSpecSceneError(
            'DATA_REVISION_CHANGED',
            'The data view changed during this request. Inspect its current revisions and retry.'
          );
        if (input.operation === 'inspect')
          return toolSuccess({
            structureViewId: before.structureViewId,
            ...(await inspectMolecularDocumentBinding(before.entry.data)),
            parameterAccess: { tool: 'mol_get_scene', includeParameterSchema: true },
            coordinateSha256,
            resource: currentScene.resource,
            datasets: data.datasets.map((dataset) =>
              input.includeRecords
                ? dataset
                : {
                    ...dataset,
                    records: undefined,
                    originalTable: undefined,
                    rowCount: dataset.records.length,
                    columns: [...new Set(dataset.records.flatMap((row) => Object.keys(row)))],
                  }
            ),
            mappings: data.mappings.map((mapping) => {
              const resolution = resolveMolecularDataMapping(active.plugin, mapping);
              return {
                ...mapping,
                resolution: {
                  mappedRows: resolution.mappedRows,
                  unresolved: resolution.unresolved,
                },
              };
            }),
            layers: data.layers,
            activeLayerId: data.activeLayerId,
          });
        if (input.operation === 'publish') {
          if (input.publication!.mapping.coordinateSha256 !== coordinateSha256)
            throw new MolViewSpecSceneError(
              'DATA_COORDINATE_MISMATCH',
              'The mapping names different coordinates. Inspect this exact view before publishing.'
            );
          const latest = [...data.datasets]
            .reverse()
            .find((dataset) => dataset.id === input.publication!.id);
          if (
            (latest && input.expectedRevision !== latest.revision) ||
            (!latest && input.expectedRevision)
          )
            throw new MolViewSpecSceneError(
              'DATA_REVISION_CHANGED',
              'The expected dataset revision does not match this view. Inspect its current revisions and retry.'
            );
          const publication = await loadMolecularDataPublication(
            input.publication!,
            context.folders ?? []
          );
          const prepared = await prepareMolecularDataPublication(publication);
          const resolution = resolveMolecularDataMapping(active.plugin, prepared.mapping);
          const workspaceScope =
            before.entry.data.molecularDocumentProjectId ?? getCurrentWorkspaceScope();
          if (!workspaceScope)
            throw new Error('Open a workspace before retaining molecular analysis.');
          const references = await platform().molecularData.retain({ workspaceScope, ...prepared });
          if (!current())
            throw new MolViewSpecSceneError(
              'DATA_REVISION_CHANGED',
              'A newer publication changed this view; this result was not installed.'
            );
          const next = molecularDataViewSchema.parse({
            ...data,
            datasets: data.datasets.some(
              (dataset) =>
                dataset.id === prepared.dataset.id && dataset.revision === prepared.dataset.revision
            )
              ? data.datasets
              : [...data.datasets, prepared.dataset],
            mappings: data.mappings.some(
              (mapping) => mapping.revision === prepared.mapping.revision
            )
              ? data.mappings
              : [...data.mappings, prepared.mapping],
            retained: [
              ...(data.retained ?? []).filter(
                (item) => item.mappingRevision !== prepared.mapping.revision
              ),
              {
                dataRevision: prepared.dataset.revision,
                mappingRevision: prepared.mapping.revision,
                ...references,
              },
            ],
          });
          persistMolecularDataTarget(target, {
            ...findRegisteredStructure(target)!.entry.data,
            molecularData: next,
          });
          return toolSuccess({
            structureViewId: before.structureViewId,
            datasetId: prepared.dataset.id,
            dataRevision: prepared.dataset.revision,
            mappingRevision: prepared.mapping.revision,
            rowCount: prepared.dataset.records.length,
            mappedRows: resolution.mappedRows,
            unresolved: resolution.unresolved,
            displayChanged: false,
            retained: references,
          });
        }
        const { revision, ...requestLayer } = input.layer!;
        const currentDataset =
          revision === 'current'
            ? [...data.datasets].reverse().find((dataset) => dataset.id === requestLayer.datasetId)
            : undefined;
        const currentMapping = currentDataset
          ? [...data.mappings]
              .reverse()
              .find(
                (mapping) =>
                  mapping.datasetId === currentDataset.id &&
                  mapping.dataRevision === currentDataset.revision &&
                  mapping.coordinateSha256 === coordinateSha256
              )
          : undefined;
        if (revision === 'current' && (!currentDataset || !currentMapping))
          throw new MolViewSpecSceneError(
            'DATA_REVISION_NOT_FOUND',
            'Publish this dataset and a mapping to the current coordinates before displaying it.'
          );
        const layer = molecularDataLayerSchema.parse({
          ...requestLayer,
          ...(revision === 'current'
            ? { dataRevision: currentDataset!.revision, mappingRevision: currentMapping!.revision }
            : {}),
        });
        if (input.expectedActiveLayerId && input.expectedActiveLayerId !== data.activeLayerId)
          throw new MolViewSpecSceneError(
            'DATA_REVISION_CHANGED',
            'A different visual layer is active. Inspect the view and retry.'
          );
        const dataset = data.datasets.find(
          (dataset) => dataset.id === layer.datasetId && dataset.revision === layer.dataRevision
        );
        const mapping = data.mappings.find((mapping) => mapping.revision === layer.mappingRevision);
        if (!dataset || !mapping)
          throw new MolViewSpecSceneError(
            'DATA_REVISION_NOT_FOUND',
            'Publish the exact data and mapping revisions before displaying them.'
          );
        const colors = compileMolecularDataColors(dataset, mapping, layer);
        const resolution = resolveMolecularDataMapping(active.plugin, mapping);
        requireDisjointMolecularDataRows(resolution, colors);
        if (!colors.some((row) => resolution.mappedRows.includes(row.row)))
          throw new MolViewSpecSceneError(
            'DATA_NO_COORDINATES',
            'The selected data has no mapped coordinates in this model. The previous view was retained.'
          );
        const visibility = molecularDataVisibility(active.plugin, resolution, colors);
        if (!visibility.renderedRows.length)
          throw new MolViewSpecSceneError(
            'DATA_TARGETS_NOT_DRAWN',
            'The selected targets have coordinates, but their atoms are not drawn in this view. Choose an appropriate representation before applying data. The previous view was retained.'
          );
        const dataScene = getMolViewSpecDataScene(active.plugin);
        const baseScene = data.baseScene ?? dataScene.scene;
        const scene = resolveMolViewSpecDataAppearanceScene(
          active.plugin,
          molecularDataSceneForPlugin(
            active.plugin,
            baseScene,
            colors,
            dataScene.scene,
            layer.backgroundSelector
              ? { selector: layer.backgroundSelector, color: layer.style.missingColor }
              : undefined
          )
        );
        const workspaceScope =
          before.entry.data.molecularDocumentProjectId ?? getCurrentWorkspaceScope();
        if (!workspaceScope)
          throw new Error('Open a workspace before retaining molecular analysis.');
        const references = await platform().molecularData.retain({
          workspaceScope,
          dataset,
          mapping,
        });
        if (!current())
          throw new Error('The molecular data changed before its variation could be applied.');
        const measurement = inspectionMeasurementForLayer(dataset, layer);
        const next = molecularDataViewSchema.parse({
          ...data,
          baseScene,
          layers: [...data.layers.filter((item) => item.id !== layer.id), layer],
          activeLayerId: layer.id,
          retained: [
            ...(data.retained ?? []).filter((item) => item.mappingRevision !== mapping.revision),
            {
              dataRevision: dataset.revision,
              mappingRevision: mapping.revision,
              ...references,
            },
          ],
        });
        const intent = (dataApplyIntents.get(before.registrationId) ?? 0) + 1;
        dataApplyIntents.set(before.registrationId, intent);
        await applyMolViewSpecScene(
          active.plugin,
          scene,
          () => {
            nativeApplied = true;
            const found = findRegisteredStructure(target);
            if (!found || found.viewerId !== before.viewerId || !current())
              throw new MolViewSpecSceneError(
                'VIEW_CHANGED',
                'The molecular view changed before the data display could be retained.',
                'unknown'
              );
            persistMolecularDataTarget(target, {
              ...found.entry.data,
              molecularData: next,
              molViewSpec: getMolViewSpecScene(active.plugin).scene,
              ...(measurement
                ? {
                    measurements: found.entry.data.measurements?.some(
                      (item) => item.id === measurement.id
                    )
                      ? found.entry.data.measurements.map((item) =>
                          item.id === measurement.id ? measurement : item
                        )
                      : [...(found.entry.data.measurements ?? []), measurement],
                    activeMeasurementId: measurement.id,
                  }
                : { activeMeasurementId: undefined }),
            });
          },
          {
            appearanceOnly: true,
            isCurrent: () => current() && dataApplyIntents.get(before.registrationId) === intent,
          }
        );
        return toolSuccess({
          structureViewId: before.structureViewId,
          rendered: true,
          datasetId: dataset.id,
          dataRevision: dataset.revision,
          mappingRevision: mapping.revision,
          activeLayer: layer,
          mappedRows: resolution.mappedRows,
          ...visibility,
          unresolved: resolution.unresolved,
          cameraChanged:
            cameraBefore !== JSON.stringify(active.plugin.canvas3d?.camera.getSnapshot()),
        });
      },
      { readOnly: input.operation === 'inspect' }
    );
  } catch (error) {
    return sceneToolFailure(error, nativeApplied);
  }
}

export async function handleMolShowInteractionContext(args: unknown) {
  try {
    const input = molShowInteractionContextSchema.parse(args);
    const target = structureTargetRef(input)!;
    const plan = await withSceneTarget(target, (active) =>
      prepareMolecularInteractionContext(active.plugin, input)
    );
    const applied = await handleMolApplyScene(
      {
        structureViewId: input.structureViewId,
        bindingId: input.bindingId,
        viewerId: input.viewerId,
        renderProfile: input.renderProfile,
        scene: plan.scene,
        viewAction: 'edit-current',
        reapplyUnchanged: true,
      },
      {
        expectedScene: plan.expectedScene,
        initialSnapshotIndex: plan.snapshotIndex,
        validateNative: (plugin) =>
          requireDisplayedInteractionContext(
            plugin,
            plan.context.environmentAtomCount,
            plan.contextRef
          ),
      }
    );
    if (!applied.ok) return applied;
    return toolSuccess({
      structureViewId: applied.structureViewId,
      rendered: true,
      interactionContext: plan.context,
      renderProfile: applied.renderProfile,
      story: applied.story,
      camera: applied.native.camera,
      message:
        'The interaction environment and native contact measurements are in the canonical saved scene. Use mol_get_scene to inspect or edit that scene, then inspect the screenshot before saving.',
    });
  } catch (error) {
    return sceneToolFailure(error);
  }
}

async function waitForSavedDocumentViewer(expected: {
  structureViewId: string;
  panelId: string;
  tabId: string;
  documentId: string;
  revisionId: string;
  scene: string;
}): Promise<boolean> {
  const requireDestination = () => {
    const panel = useCanvasStore.getState().panels[expected.panelId];
    const tab = panel?.tabs.find((candidate) => candidate.id === expected.tabId);
    if (
      !tab ||
      tab.entityId !== expected.structureViewId ||
      tab.initialStructureAttrs?.molecularDocumentId !== expected.documentId ||
      tab.initialStructureAttrs.molecularDocumentSavedReferenceId !== expected.revisionId
    )
      throw new MolViewSpecSceneError('VIEW_CHANGED', 'The saved document tab changed.');
    if (panel.activeTabId !== tab.id)
      throw new MolViewSpecSceneError('VIEW_NOT_ACTIVE', 'The saved document tab is not active.');
  };
  const deadline = Date.now() + 30_000;
  do {
    requireDestination();
    const current = findRegisteredStructure(expected.structureViewId);
    if (current) {
      if (
        current.entry.data.molecularDocumentId !== expected.documentId ||
        current.entry.data.molecularDocumentSavedReferenceId !== expected.revisionId
      )
        throw new MolViewSpecSceneError('VIEW_CHANGED', 'The saved document viewer changed.');
      try {
        await withActivePlugin(
          current.viewerId,
          async (active) => {
            if (!sameLoadedMolViewSpecScene(activeMolViewSpecScene(active.plugin), expected.scene))
              throw new MolViewSpecSceneError('PLUGIN_NOT_READY', 'The saved scene is loading.');
            await waitForMolViewSpecViewReady(active.plugin);
          },
          { cacheKey: getPaneRendererHostCacheKey(`pane:${expected.panelId}`, 'loaded') }
        );
        requireDestination();
        return true;
      } catch (error) {
        if (
          !(error instanceof ActiveMolstarViewerError || error instanceof MolViewSpecSceneError) ||
          (error.code !== 'VIEWER_NOT_FOUND' && error.code !== 'PLUGIN_NOT_READY')
        )
          throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}

export async function handleMolSaveView(
  args: unknown,
  options: { cameraPolicy?: MolViewSpecCameraPolicy } = {}
) {
  let writeAttempted = false;
  let savedReferenceId: string | undefined;
  try {
    const input = molSaveViewSchema.parse(args);
    const { retainPinnedInspectionView } =
      await import('../../structure-drawer/public/state/structure-inspection-sessions');
    const target = structureTargetRef(input)!;
    return await withSceneTarget(
      target,
      async (active) => {
        const before = findRegisteredStructure(target)!;
        const { coordinates, pinnedAssets } = activeMolViewSpecCoordinateAssets(active.plugin);
        assertMolecularDocumentStorage([coordinates, ...pinnedAssets]);
        const currentScene = getMolViewSpecScene(active.plugin);
        const captureOptions: MolViewSpecCaptureOptions = {
          cameraPolicy: options.cameraPolicy ?? 'capture-current',
          authoredCameraSnapshot: before.entry.data.cameraSnapshot,
        };
        if (
          options.cameraPolicy === 'preserve-authored' &&
          currentScene.sceneOrigin === 'authored'
        ) {
          const baseline = before.entry.data.molViewSpecSavedReferenceId
            ? await getEntityReference(before.entry.data.molViewSpecSavedReferenceId)
            : before.registrationId.startsWith('saved-view:')
              ? await getEntityReferenceByLocator(`entity://structure/${before.registrationId}`)
              : null;
          const saved = baseline && molecularViewFromReferenceData(baseline.data);
          if (saved)
            captureOptions.savedCameraBaseline = {
              scene: saved.scene,
              cameraSnapshot: saved.cameraSnapshot,
            };
        }
        requireNamedMolecularViews(currentScene.scene, input.title);
        if (currentScene.sceneOrigin === 'authored')
          requireSerializableMolViewSpecVisibility(before.entry.data.view?.hiddenChainInstanceIds);
        await waitForMolViewSpecViewReady(active.plugin);
        await validateMolViewSpecViewGeometry(active.plugin, () => {
          const current = findRegisteredStructure(target);
          if (!current || current.viewerId !== before.viewerId) return false;
          try {
            requireActiveStructureTab(current.registrationId, current.structureViewId);
            return true;
          } catch {
            return false;
          }
        });
        const captured = captureMolViewSpecView(active.plugin, captureOptions);
        const catalogObservation =
          !before.entry.data.catalogProvenance && before.entry.data.catalogSource
            ? (await loadCatalogStructure(before.entry.data.catalogSource.observationId))
                .observation
            : before.entry.data.catalogProvenance;
        const preview = await screenshotDataUri(active, 0.25);
        const after = findRegisteredStructure(target);
        if (currentScene.sceneOrigin === 'authored')
          requireSerializableMolViewSpecVisibility(after?.entry.data.view?.hiddenChainInstanceIds);
        const latest = captureMolViewSpecView(active.plugin, captureOptions);
        if (
          !after ||
          after.viewerId !== before.viewerId ||
          after.entry.data.structureLinkOwnerId !== before.entry.data.structureLinkOwnerId ||
          latest.scene !== captured.scene ||
          latest.cameraSnapshot !== captured.cameraSnapshot ||
          latest.coordinates.format !== captured.coordinates.format ||
          latest.coordinates.text !== captured.coordinates.text ||
          !samePinnedMolViewSpecAssets(latest.pinnedAssets, captured.pinnedAssets)
        )
          throw new MolViewSpecSceneError(
            'VIEW_CHANGED',
            'The view moved while its preview was being captured. Stop camera animation and retry.',
            false
          );
        if (captured.pinnedAssets.length && !before.entry.data.molViewSpecPrimarySourceReferenceId)
          throw new MolViewSpecSceneError(
            'MVS_COMPARISON_PROVENANCE_MISSING',
            'This comparison is missing its primary pinned reference.'
          );
        requireMolViewSpecSurfaceOwnership(active.plugin, captured.scene);
        const reviewed = await prepareMolecularScientificReviewForSave(
          active.plugin,
          input.scientificReview,
          getMolViewSpecScene(active.plugin).scene,
          captured.scene,
          captured.initialSnapshotIndex ?? 0,
          active.plugin.canvas3d?.camera.getSnapshot() ?? null
        );
        const scientificReview = reviewed.scientificReview;
        const savedCoordinates = {
          ...captured.coordinates,
          sha256: await coordinateDigest(captured.coordinates.text),
        };
        const snapshot = molecularViewSchema.parse({
          kind: 'molecular-view',
          version: captured.pinnedAssets.length ? 2 : 1,
          title: input.title,
          caption: input.caption,
          scene: reviewed.scene,
          cameraSnapshot: captured.cameraSnapshot,
          initialSnapshotIndex: captured.initialSnapshotIndex,
          coordinates: savedCoordinates,
          ...(captured.pinnedAssets.length
            ? {
                primarySourceReferenceId: before.entry.data.molViewSpecPrimarySourceReferenceId,
                pinnedAssets: captured.pinnedAssets,
              }
            : {}),
          source: molecularViewSourceForCoordinates(before.entry.data, savedCoordinates, {
            source: before.entry.data.source,
            ...(before.entry.data.source !== 'file'
              ? { sourceId: before.entry.data.sourceId }
              : {}),
            providerIdentityKey: before.entry.data.providerIdentityKey,
            coordinateModel: before.entry.data.coordinateModel,
            catalogObservation,
            prediction: before.entry.data.predictionProvenance,
            allele: before.entry.data.alleleProvenance,
            comparison: before.entry.data.comparisonProvenance,
            ...(before.entry.data.structureArtifactRef
              ? {
                  artifactEntityId: before.entry.data.structureArtifactRef.entityId,
                  artifactRevisionId: before.entry.data.structureArtifactRef.revisionId,
                }
              : {}),
          }),
          evidence: input.evidence,
          measurements: before.entry.data.measurements,
          activeMeasurementId: before.entry.data.activeMeasurementId,
          molecularData: before.entry.data.molecularData,
          ...(scientificReview ? { scientificReview } : {}),
          preview: preview.dataUri,
          createdAt: Date.now(),
        });
        await validateMolecularViewCoordinates(snapshot);
        const currentBeforeCommit = findRegisteredStructure(target);
        const savedDataIdentity = (data: Structure3dAttrs) =>
          JSON.stringify({
            measurements: data.measurements ?? [],
            activeMeasurementId: data.activeMeasurementId,
            molecularData: data.molecularData ?? null,
          });
        if (
          !currentBeforeCommit ||
          currentBeforeCommit.viewerId !== before.viewerId ||
          currentBeforeCommit.entry.data.structureLinkOwnerId !==
            before.entry.data.structureLinkOwnerId ||
          savedDataIdentity(currentBeforeCommit.entry.data) !== savedDataIdentity(before.entry.data)
        )
          throw new MolViewSpecSceneError(
            'VIEW_CHANGED',
            'The protein or its data changed while saving. Save its current view again.',
            false
          );
        requireActiveStructureTab(
          currentBeforeCommit.registrationId,
          currentBeforeCommit.structureViewId
        );
        writeAttempted = true;
        const projectSave = await saveMolecularDocumentSnapshot(snapshot, before.entry.data, {
          copy: input.newPresentation,
          changeSummary: input.changeSummary,
          destinationProject: input.destinationProject,
        });
        const reference = projectSave.revisionReference;
        savedReferenceId = reference.id;
        const savedSnapshot = molecularViewFromReferenceData(reference.data)!;
        const documentBinding = projectSave
          ? {
              molecularDocumentId: projectSave.document.id,
              molecularDocumentReference: projectSave.documentReference,
              molecularDocumentProjectId: projectSave.documentReference.projectId,
              molecularDocumentPath: projectSave.path,
              molecularDocumentRevision: projectSave.revision,
              molecularDocumentSavedReferenceId: reference.id,
              molecularDocumentDraftId: undefined,
              molecularDocumentHistoricalRevisionId: undefined,
            }
          : {};
        let savedStructureViewId = before.structureViewId;

        for (const panel of Object.values(useCanvasStore.getState().panels)) {
          for (const tab of panel.tabs) {
            if (
              tab.structureInspection &&
              before.entry.data.structureLinkOwnerId?.endsWith(`\u0000${tab.id}`) &&
              panel.activeTabId === tab.id &&
              findRegisteredStructure(target)?.viewerId === before.viewerId &&
              Object.values(useStructureLinkRegistry.getState().links).some(
                (link) =>
                  link.ownerId === before.entry.data.structureLinkOwnerId &&
                  link.structureViewId === before.structureViewId &&
                  link.translation === tab.structureInspection!.request.translation &&
                  link.sequenceDocumentId === tab.structureInspection!.request.entityId
              )
            ) {
              const { saveInspectionContinuation } =
                await import('../../structure-drawer/public/inspection-continuation');
              await saveInspectionContinuation({
                ...tab.structureInspection,
                savedViewReferenceId: reference.id,
              });
              const latestInspection = useCanvasStore
                .getState()
                .panels[
                  panel.id
                ]?.tabs.find((candidate) => candidate.id === tab.id)?.structureInspection;
              if (
                !latestInspection ||
                inspectionProteinKey(latestInspection.request) !==
                  inspectionProteinKey(tab.structureInspection.request) ||
                latestInspection.candidateId !== tab.structureInspection.candidateId
              )
                throw new MolViewSpecSceneError(
                  'VIEW_CHANGED',
                  'The document was saved, but the selected protein changed before its inspection was retained.'
                );
              retainPinnedInspectionView(
                tab.id,
                inspectionProteinKey(latestInspection.request),
                reference.id,
                before.structureViewId
              );
              useCanvasStore.getState().updateTab(panel.id, tab.id, {
                structureInspection: {
                  ...latestInspection,
                  savedViewReferenceId: reference.id,
                },
              });
            }
          }
        }

        const current = findRegisteredStructure(target);
        const adoptedAppearance =
          current?.viewerId === before.viewerId &&
          current.entry.data.molViewSpec === before.entry.data.molViewSpec &&
          acceptSavedMolViewSpecView(active.plugin, captured, savedSnapshot.scene, captureOptions);
        const adoptingHost =
          current && adoptedAppearance
            ? findStructureTabHost(current.registrationId, current.structureViewId)
            : null;
        if (current?.viewerId === before.viewerId && (adoptedAppearance || projectSave)) {
          const next = {
            ...current.entry.data,
            ...(projectSave && adoptedAppearance
              ? {
                  ...molecularViewAttrs(
                    current.registrationId,
                    savedSnapshot,
                    undefined,
                    reference.id
                  ),
                  coordinateFilePath: undefined,
                  structureArtifactRef: undefined,
                  structureBinding: adoptingHost?.tab.structureInspection
                    ? current.entry.data.structureBinding
                    : undefined,
                  catalogSource: undefined,
                  label: projectSave.document.name,
                  structureViewIdentity: adoptingHost?.tab.structureInspection
                    ? current.entry.data.structureViewIdentity
                    : undefined,
                }
              : {}),
            ...(adoptedAppearance
              ? {
                  molViewSpec: savedSnapshot.scene,
                  molViewSpecSnapshotIndex: savedSnapshot.initialSnapshotIndex,
                  cameraSnapshot: savedSnapshot.cameraSnapshot,
                  view: {
                    ...structureViewStateFromAttrs(current.entry.data),
                    cameraSnapshot: savedSnapshot.cameraSnapshot,
                    ...(currentScene.sceneOrigin === 'starter'
                      ? { hiddenChainInstanceIds: [] }
                      : {}),
                  },
                }
              : {}),
            molViewSpecSavedReferenceId: reference.id,
            ...(current.entry.data.molecularViewSnapshot
              ? { molecularViewSnapshot: savedSnapshot }
              : {}),
            ...documentBinding,
          };
          useStructure3dStore.getState().updateStructureData(current.registrationId, next);
          for (const panel of Object.values(useCanvasStore.getState().panels))
            for (const tab of panel.tabs)
              if (
                tab.type === 'structure' &&
                !tab.structureInspection &&
                tab.entityId === current.registrationId
              ) {
                if (projectSave && adoptedAppearance)
                  savedStructureViewId = `molecular-document:${projectSave.catalogEntityId}`;
                if (projectSave && adoptedAppearance) {
                  useCanvasStore
                    .getState()
                    .retargetTab(
                      panel.id,
                      tab.id,
                      {
                        type: 'structure',
                        entityId: `molecular-document:${projectSave.catalogEntityId}`,
                      },
                      { label: projectSave.document.name, initialStructureAttrs: next }
                    );
                } else {
                  useCanvasStore
                    .getState()
                    .updateTab(panel.id, tab.id, { initialStructureAttrs: next });
                }
              }
        }
        let warning = projectSave.warning;
        if (adoptingHost && !adoptingHost.tab.structureInspection) {
          const viewerReady = await waitForSavedDocumentViewer({
            structureViewId: savedStructureViewId,
            panelId: adoptingHost.panel.id,
            tabId: adoptingHost.tab.id,
            documentId: projectSave.document.id,
            revisionId: reference.id,
            scene: savedSnapshot.scene,
          });
          if (!viewerReady)
            warning = [
              warning,
              'The document was saved. Its viewer is still loading. Use the returned document reference to reopen it.',
            ]
              .filter(Boolean)
              .join(' ');
        }
        return toolSuccess({
          referenceId: projectSave.reference?.id,
          revisionId: reference.id,
          documentReference: projectSave.documentReference,
          ...documentBinding,
          structureViewId: savedStructureViewId,
          ...molecularDocumentReferenceLinks(
            projectSave.documentReference,
            reference.id,
            savedSnapshot
          ),
          title: snapshot.title,
          caption: snapshot.caption,
          evidence: snapshot.evidence,
          coordinateDigestSha256: snapshot.coordinates.sha256,
          ...(scientificReview
            ? {
                scientificReview: {
                  sceneDigestSha256: scientificReview.sceneDigestSha256,
                  savedSceneDigestSha256: scientificReview.savedSceneDigestSha256,
                  stepCount: scientificReview.steps.length,
                },
              }
            : {}),
          format: 'mvsj',
          ...(warning ? { warning } : {}),
          message: projectSave
            ? 'Saved the molecular document in the project and preserved this exact result. Earlier chat and notebook results remain unchanged.'
            : 'Retained a clickable molecular result with pinned coordinates, appearance and camera in this chat. No project document or notebook was created; do not print its private locator or reference token.',
        });
      },
      { copy: input.newPresentation }
    );
  } catch (error) {
    const failure = sceneToolFailure(error);
    return savedReferenceId
      ? {
          ...failure,
          stateChanged: true as const,
          partialEffects: [{ kind: 'saved-molecular-view', referenceId: savedReferenceId }],
        }
      : writeAttempted && !(error instanceof MolecularStorageError)
        ? { ...failure, stateChanged: 'unknown' as const }
        : failure;
  }
}

export async function handleMolApplyScene(
  args: unknown,
  conditions?: {
    expectedScene: string;
    initialSnapshotIndex: number;
    validateNative: (plugin: MolstarPlugin) => void;
    nativeAlignmentChange?: boolean;
  },
  userHydrogenRequest?: string
) {
  let nativeApplied = false;
  try {
    const input = molApplySceneSchema.parse(args);
    const target = structureTargetRef(input)!;
    const before = findRegisteredStructure(target);
    if (!before)
      throw new MolViewSpecSceneError(
        'VIEWER_NOT_FOUND',
        `No open structure view matches ${target}.`
      );
    return await withSceneTarget(target, async (active) => {
      let scene: ReturnType<typeof getMolViewSpecScene> | undefined;
      const currentScene = getMolViewSpecScene(active.plugin);
      const inputScene = input.root
        ? authorMolViewSpecRoot(input.root, currentScene.resource.uri)
        : input.parameterEdits
          ? await editMolecularDocumentParameters(
              currentScene.scene,
              input.expectedSceneSha256!,
              input.parameterEdits
            )
          : input.scene;
      if (!inputScene)
        throw new MolViewSpecSceneError(
          'MVS_INVALID_SCENE',
          'Supply a complete scene or authored root.'
        );
      const edit = conditions
        ? {
            scene: inputScene,
            activeIndex: conditions.initialSnapshotIndex,
            action: input.viewAction,
          }
        : editMolViewSpecPresentation(
            currentScene.scene,
            inputScene,
            input.parameterEdits ? 'replace' : input.viewAction,
            currentScene.story?.activeIndex ?? 0
          );
      if (!conditions) requireConstructedInteractionGuides(currentScene.scene, edit.scene);
      const compiledScene = resolveMolViewSpecAgentScene(
        active.plugin,
        edit.scene,
        currentScene.resources.map((resource) => resource.uri),
        input.renderProfile,
        conditions?.nativeAlignmentChange,
        userHydrogenRequest
      );
      let proposedScene = preserveUneditedMolViewSpecSnapshots(
        currentScene.scene,
        compiledScene,
        edit.action,
        currentScene.story?.activeIndex ?? 0
      );
      if (conditions && edit.action === 'edit-current')
        proposedScene = preserveEquivalentGeneratedLegendEntries(currentScene.scene, proposedScene);
      requireUnchangedMolViewSpecBackground(
        currentScene.scene,
        proposedScene,
        currentScene.resources.map((resource) => resource.uri),
        currentScene.story?.activeIndex ?? 0
      );
      if (!conditions) requireRetainedInteractionContacts(currentScene.scene, proposedScene);
      if (input.parameterEdits)
        requireAppliedMolecularParameterEdits(proposedScene, input.parameterEdits);
      const retainDataLayer = Boolean(
        input.parameterEdits &&
        before.entry.data.molecularData?.activeLayerId &&
        retainsMolecularDataColors(currentScene.scene, proposedScene)
      );
      const dataBaseScene =
        retainDataLayer && before.entry.data.molecularData?.baseScene
          ? await rebaseMolecularDataParameters(
              before.entry.data.molecularData.baseScene,
              currentScene.scene,
              input.parameterEdits!,
              proposedScene
            )
          : undefined;
      if (retainDataLayer && !dataBaseScene)
        throw Error(
          'The active data variation has no retained baseline. Reapply it before editing document parameters.'
        );
      if (
        !input.reapplyUnchanged &&
        currentScene.sceneOrigin === 'authored' &&
        sameMolViewSpecDisplayTree(
          proposedScene,
          currentScene.scene,
          currentScene.resources.map((resource) => resource.uri)
        )
      )
        throw new MolViewSpecSceneError(
          'MVS_SCENE_UNCHANGED',
          'The submitted MolViewSpec scene has the same display tree as the current view. Add or change the intended component, representation, color, or camera before applying.'
        );
      await applyMolViewSpecScene(
        active.plugin,
        proposedScene,
        () => {
          nativeApplied = true;
          const current = findRegisteredStructure(target);
          if (!current || current.viewerId !== before.viewerId) {
            throw new MolViewSpecSceneError(
              'VIEW_CHANGED',
              'The scene rendered, but its structure view changed before persistence.',
              'unknown'
            );
          }
          requireActiveStructureTab(current.registrationId, current.structureViewId);
          scene = getMolViewSpecScene(active.plugin);
          const next = {
            ...current.entry.data,
            molecularData: current.entry.data.molecularData
              ? {
                  ...current.entry.data.molecularData,
                  activeLayerId: retainDataLayer
                    ? current.entry.data.molecularData.activeLayerId
                    : undefined,
                  baseScene: dataBaseScene,
                }
              : undefined,
            activeMeasurementId: undefined,
            molViewSpec: scene.scene,
            molViewSpecSnapshotIndex: edit.activeIndex,
            cameraSnapshot: undefined,
            view: {
              ...clearStructureChainVisibilityMask(structureViewStateFromAttrs(current.entry.data)),
              cameraSnapshot: undefined,
            },
          };
          useStructure3dStore.getState().updateStructureData(current.registrationId, next);
          for (const panel of Object.values(useCanvasStore.getState().panels)) {
            for (const tab of panel.tabs) {
              if (
                tab.type === 'structure' &&
                (tab.initialStructureAttrs?.structureViewIdentity?.structureViewId ===
                  current.structureViewId ||
                  tab.entityId === current.registrationId)
              ) {
                useCanvasStore
                  .getState()
                  .updateTab(panel.id, tab.id, { initialStructureAttrs: next });
              }
            }
          }
        },
        conditions
          ? {
              initialSnapshotIndex: conditions.initialSnapshotIndex,
              beforeApply: () => {
                const latest = getMolViewSpecScene(active.plugin);
                if (
                  !sameMolViewSpecDisplayTree(
                    latest.scene,
                    conditions.expectedScene,
                    latest.resources.map((resource) => resource.uri)
                  ) ||
                  (latest.story?.activeIndex ?? 0) !== conditions.initialSnapshotIndex
                )
                  throw new MolViewSpecSceneError(
                    'VIEW_CHANGED',
                    'The scene changed before the interaction context could be applied.'
                  );
              },
              validateNative: () => conditions.validateNative(active.plugin),
            }
          : {
              initialSnapshotIndex: edit.activeIndex,
              beforeApply: () => {
                const latestState = getMolViewSpecScene(active.plugin);
                const latest = latestState.scene;
                if (
                  (input.viewAction === 'edit-current' || input.viewAction === 'add') &&
                  (latest !== currentScene.scene ||
                    (latestState.story?.activeIndex ?? 0) !==
                      (currentScene.story?.activeIndex ?? 0))
                )
                  throw new MolViewSpecSceneError(
                    'VIEW_CHANGED',
                    'The presentation changed before this view edit could be applied. Read the current presentation and retry.',
                    false
                  );

                const authority = resolveMolViewSpecAgentScene(
                  active.plugin,
                  latest,
                  currentScene.resources.map((resource) => resource.uri),
                  input.renderProfile
                );
                requireConstructedInteractionGuides(authority, proposedScene);
                requireRetainedInteractionContacts(latest, proposedScene);
              },
            }
      );
      if (!scene)
        throw new MolViewSpecSceneError(
          'MVS_PERSIST_FAILED',
          'The renderer did not confirm scene persistence.',
          'unknown'
        );
      return toolSuccess({ structureViewId: before.structureViewId, rendered: true, ...scene });
    });
  } catch (error) {
    return sceneToolFailure(error, nativeApplied);
  }
}

export async function handleMolSelectStoryStep(args: unknown) {
  let nativeApplied = false;
  try {
    const input = molSelectStoryStepSchema.parse(args);
    const target = structureTargetRef(input)!;
    const before = findRegisteredStructure(target);
    if (!before)
      throw new MolViewSpecSceneError(
        'VIEWER_NOT_FOUND',
        `No open structure view matches ${target}.`
      );
    return await withSceneTarget(target, async (active) => {
      const currentScene = getMolViewSpecScene(active.plugin);
      requireUnchangedMolViewSpecBackground(
        currentScene.scene,
        currentScene.scene,
        currentScene.resources.map((resource) => resource.uri),
        currentScene.story?.activeIndex ?? 0,
        input.index
      );
      const selected = await selectMolViewSpecSnapshot(active.plugin, input.index);
      nativeApplied = true;
      const current = findRegisteredStructure(target);
      if (!current || current.viewerId !== before.viewerId)
        throw new MolViewSpecSceneError(
          'VIEW_CHANGED',
          'The structure view changed during story selection.',
          'unknown'
        );
      const next = {
        ...current.entry.data,
        molViewSpecSnapshotIndex: selected.index,
        cameraSnapshot: undefined,
      };
      useStructure3dStore.getState().updateStructureData(current.registrationId, next);
      for (const panel of Object.values(useCanvasStore.getState().panels)) {
        for (const tab of panel.tabs) {
          if (
            tab.type === 'structure' &&
            (tab.initialStructureAttrs?.structureViewIdentity?.structureViewId ===
              current.structureViewId ||
              tab.entityId === current.registrationId)
          )
            useCanvasStore.getState().updateTab(panel.id, tab.id, { initialStructureAttrs: next });
        }
      }
      return toolSuccess({
        structureViewId: current.structureViewId,
        rendered: true,
        ...selected,
        story: getMolViewSpecScene(active.plugin).story,
      });
    });
  } catch (error) {
    return sceneToolFailure(error, nativeApplied);
  }
}

async function executeMolSetRepresentation(args: unknown) {
  const input = molSetRepresentationSchema.parse(args);
  const viewerId = structureTargetRef(input)!;
  const { representation } = input;
  const found = findRegisteredStructure(viewerId);
  if (!found) {
    throwStructureError('VIEWER_NOT_FOUND', `No registered structure with id ${viewerId}.`, {
      viewerId,
    });
  }
  const recipe = viewRecipeByIdForScene(representation, found.entry.data.scene);
  if (found.entry.data.molViewSpec)
    throwStructureError(
      'MVS_SCENE_ACTIVE',
      'Edit the active MolViewSpec scene with mol_get_scene and mol_apply_scene instead of a legacy representation preset.'
    );
  const patch = attrsPatchFromStructureViewCommand({
    attrs: found.entry.data,
    command: { type: 'select-recipe', recipe },
  });
  if (!patch) {
    throwStructureError('VIEW_UPDATE_FAILED', `Could not select recipe ${representation}.`, {
      viewerId,
      representation,
    });
  }
  const next: Structure3dAttrs = {
    ...found.entry.data,
    ...patch,
  };
  useStructure3dStore.getState().updateStructureData(found.registrationId, next);
  return toolSuccess({ viewerId, representation });
}

async function executeMolSetColor(args: unknown) {
  const input = molSetColorSchema.parse(args);
  const viewerId = structureTargetRef(input)!;
  const { colorMode } = input;
  const found = findRegisteredStructure(viewerId);
  if (!found) {
    throwStructureError('VIEWER_NOT_FOUND', `No registered structure with id ${viewerId}.`, {
      viewerId,
    });
  }
  if (found.entry.data.molViewSpec)
    throwStructureError(
      'MVS_SCENE_ACTIVE',
      'Edit the active MolViewSpec scene with mol_get_scene and mol_apply_scene instead of a legacy color preset.'
    );
  const patch = attrsPatchFromStructureViewCommand({
    attrs: found.entry.data,
    command: { type: 'set-global-color-mode', colorMode: colorMode as Structure3dColorMode },
  });
  if (!patch) {
    throwStructureError('VIEW_UPDATE_FAILED', `Could not set color mode ${colorMode}.`, {
      viewerId,
      colorMode,
    });
  }
  const next: Structure3dAttrs = {
    ...found.entry.data,
    ...patch,
  };
  useStructure3dStore.getState().updateStructureData(found.registrationId, next);
  return toolSuccess({ viewerId, colorMode });
}

async function executeMolSetSideChains(args: unknown) {
  const input = molSetSideChainsSchema.parse(args);
  const viewerId = structureTargetRef(input)!;
  const { target, visible } = input;
  const found = findRegisteredStructure(viewerId);
  if (!found) {
    throwStructureError('VIEWER_NOT_FOUND', `No registered structure with id ${viewerId}.`, {
      viewerId,
    });
  }
  if (found.entry.data.molViewSpec)
    throwStructureError(
      'MVS_SCENE_ACTIVE',
      'Edit the active MolViewSpec scene with mol_get_scene and mol_apply_scene to change residue representations.'
    );
  const targetKey = target === 'visible_backbones' ? 'visibleBackbones' : 'selection';
  const patch = attrsPatchFromStructureViewCommand({
    attrs: found.entry.data,
    command: {
      type: 'set-side-chain-visibility',
      target: targetKey,
      visible,
    },
  });
  if (!patch) {
    throwStructureError('VIEW_UPDATE_FAILED', `Could not set side-chain visibility.`, {
      viewerId,
      target,
      visible,
    });
  }
  const next: Structure3dAttrs = {
    ...found.entry.data,
    ...patch,
  };
  useStructure3dStore.getState().updateStructureData(found.registrationId, next);
  const view = structureViewStateFromAttrs(next);
  return toolSuccess({
    viewerId,
    target,
    visible,
    sideChains: {
      visibleBackbones: view.residueVisualization?.sideChains?.visibleBackbones ?? false,
      selection: view.residueVisualization?.sideChains?.selection ?? false,
    },
  });
}

async function executeMolSelectResidues(args: unknown) {
  const input = molSelectionSchema.parse(args);
  const viewerId = structureTargetRef(input)!;
  const { selection } = input;
  const found = findRegisteredStructure(viewerId);
  if (!found) {
    throwStructureError('VIEWER_NOT_FOUND', `No registered structure with id ${viewerId}.`, {
      viewerId,
    });
  }
  try {
    return await withSceneTarget(
      viewerId,
      (active) => {
        const loci = lociForSelection(active.plugin, selection);
        active.plugin.managers.interactivity.lociSelects.deselectAll();
        if (!loci.length) {
          mcpSelectionByStructureViewId.delete(found.structureViewId);
          return toolSuccess({ viewerId, selection, warnings: ['Selection matched no atoms.'] });
        }
        for (const selected of loci)
          active.plugin.managers.interactivity.lociSelects.select({ loci: selected });
        mcpSelectionByStructureViewId.set(found.structureViewId, { selection });
        return toolSuccess({ viewerId, selection });
      },
      { waitForViewReady: true }
    );
  } catch (error) {
    rethrowActiveViewerError(error, found.viewerId);
  }
}

async function executeMolFocus(args: unknown) {
  const input = molSelectionSchema.parse(args);
  const viewerId = structureTargetRef(input)!;
  const { selection } = input;
  const found = findRegisteredStructure(viewerId);
  if (!found) {
    throwStructureError('VIEWER_NOT_FOUND', `No registered structure with id ${viewerId}.`, {
      viewerId,
    });
  }
  try {
    return await withSceneTarget(viewerId, async (active) => {
      const loci = lociForSelection(active.plugin, selection);
      if (!loci.length) {
        throwStructureError('EMPTY_SELECTION', 'Selection matched no atoms.', {
          viewerId,
          selection,
        });
      }
      for (const selected of loci) {
        const coverage = representedSelectionCoverage(active.plugin, selected);
        if (coverage) {
          const { selectedAtomCount, representedAtomCount } = coverage;
          if (representedAtomCount < selectedAtomCount * 0.95) {
            throwStructureError(
              'FOCUS_SELECTION_NOT_RENDERED',
              `The camera selection contains ${selectedAtomCount} atoms, but only ${representedAtomCount} are represented in the current scene. Add the missing visible component with mol_apply_scene before focusing.`,
              { viewerId, selection, selectedAtomCount, representedAtomCount }
            );
          }
        }
      }

      await active.plugin.managers.camera?.focusLoci(loci.length === 1 ? loci[0] : loci, {
        minRadius: 5,
        extraRadius: 4,
        durationMs: 250,
      });
      return toolSuccess({ viewerId, selection });
    });
  } catch (error) {
    rethrowActiveViewerError(error, found.viewerId);
  }
}

async function executeMolCaptureScreenshot(args: unknown) {
  const input = molCaptureScreenshotSchema.parse(args);
  const viewerId = structureTargetRef(input)!;
  const found = findRegisteredStructure(viewerId);
  if (!found) {
    throwStructureError('VIEWER_NOT_FOUND', `No registered structure with id ${viewerId}.`, {
      viewerId,
    });
  }
  try {
    return await withSceneTarget(viewerId, async (active) => {
      if (found.entry.data.molViewSpec) await waitForMolViewSpecViewReady(active.plugin);
      const sceneBefore = getMolViewSpecScene(active.plugin);
      const cameraBefore = active.plugin.canvas3d?.camera.getSnapshot() ?? null;
      let screenshot = await screenshotDataUri(active);
      let parsed = parseScreenshotDataUri(screenshot.dataUri, viewerId);
      const warnings: string[] = [];

      if (parsed.byteLength > MAX_SCREENSHOT_BYTES) {
        screenshot = await screenshotDataUri(active, SCREENSHOT_RETRY_SCALE);
        parsed = parseScreenshotDataUri(screenshot.dataUri, viewerId);
        warnings.push('Screenshot exceeded 500 KiB; downscaled once.');
      }

      if (parsed.byteLength > MAX_SCREENSHOT_BYTES) {
        throwStructureError(
          'SCREENSHOT_TOO_LARGE',
          'Mol* screenshot exceeds the MCP response size limit.',
          { viewerId, byteLength: parsed.byteLength, maxBytes: MAX_SCREENSHOT_BYTES }
        );
      }

      const sceneAfter = getMolViewSpecScene(active.plugin);
      const cameraAfter = active.plugin.canvas3d?.camera.getSnapshot() ?? null;
      if (
        sceneBefore.scene !== sceneAfter.scene ||
        JSON.stringify(cameraBefore) !== JSON.stringify(cameraAfter)
      )
        throwStructureError(
          'VIEW_CHANGED',
          'The scene or camera changed during screenshot capture.'
        );
      const scientificReviewScreenshot =
        sceneAfter.sceneOrigin === 'authored'
          ? await recordMolecularScientificScreenshot(
              active.plugin,
              sceneAfter.scene,
              sceneAfter.story?.activeIndex ?? 0,
              cameraAfter,
              screenshot.dataUri,
              captureMolViewSpecView(active.plugin).scene,
              nativeMolViewSpecColorGroups(
                active.plugin,
                sceneAfter.scene,
                sceneAfter.story?.activeIndex ?? 0
              )
            )
          : undefined;

      return toolSuccess({
        returns_image: true,
        data: parsed.data,
        mimeType: parsed.mimeType,
        viewerId,
        byteLength: parsed.byteLength,
        width: screenshot.width,
        height: screenshot.height,
        maxBytes: MAX_SCREENSHOT_BYTES,
        downscaled: screenshot.downscaled,
        ...(scientificReviewScreenshot ? { scientificReviewScreenshot } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    });
  } catch (error) {
    rethrowActiveViewerError(error, found.viewerId);
  }
}

function structureOperationFailure(error: unknown, mutating: boolean) {
  const record =
    error && typeof error === 'object'
      ? (error as {
          code?: unknown;
          message?: unknown;
          retriable?: unknown;
          details?: Record<string, unknown>;
        })
      : undefined;
  const details = record?.details;
  const code =
    error instanceof Error && error.name === 'AbortError'
      ? 'CANCELED'
      : typeof record?.code === 'string'
        ? record.code
        : 'STRUCTURE_OPERATION_FAILED';
  const knownState = details?.stateChanged;
  return toolFailure({
    code,
    error:
      error instanceof Error
        ? error.message
        : typeof record?.message === 'string'
          ? record.message
          : String(error),
    retriable:
      typeof record?.retriable === 'boolean' ? record.retriable : code === 'PLUGIN_NOT_READY',
    stateChanged:
      knownState === true || knownState === false || knownState === 'unknown'
        ? knownState
        : !mutating || error instanceof z.ZodError
          ? false
          : 'unknown',
    partialEffects: [],
    ...(details ? { details } : {}),
  });
}

export async function handleMolOpenTab(...args: Parameters<typeof executeMolOpenTab>) {
  try {
    return await executeMolOpenTab(...args);
  } catch (error) {
    return structureOperationFailure(error, true);
  }
}

export async function handleMolOpenDrawer(...args: Parameters<typeof executeMolOpenDrawer>) {
  try {
    return await executeMolOpenDrawer(...args);
  } catch (error) {
    return structureOperationFailure(error, true);
  }
}

export async function handleMolListStructures(
  ...args: Parameters<typeof executeMolListStructures>
) {
  try {
    return await executeMolListStructures(...args);
  } catch (error) {
    return structureOperationFailure(error, false);
  }
}

export async function handleMolGetState(...args: Parameters<typeof executeMolGetState>) {
  try {
    return await executeMolGetState(...args);
  } catch (error) {
    return structureOperationFailure(error, false);
  }
}

export async function handleMolSetRepresentation(
  ...args: Parameters<typeof executeMolSetRepresentation>
) {
  try {
    return await executeMolSetRepresentation(...args);
  } catch (error) {
    return structureOperationFailure(error, true);
  }
}

export async function handleMolSetColor(...args: Parameters<typeof executeMolSetColor>) {
  try {
    return await executeMolSetColor(...args);
  } catch (error) {
    return structureOperationFailure(error, true);
  }
}

export async function handleMolSetSideChains(...args: Parameters<typeof executeMolSetSideChains>) {
  try {
    return await executeMolSetSideChains(...args);
  } catch (error) {
    return structureOperationFailure(error, true);
  }
}

export async function handleMolSelectResidues(
  ...args: Parameters<typeof executeMolSelectResidues>
) {
  try {
    return await executeMolSelectResidues(...args);
  } catch (error) {
    return structureOperationFailure(error, true);
  }
}

export async function handleMolFocus(...args: Parameters<typeof executeMolFocus>) {
  try {
    return await executeMolFocus(...args);
  } catch (error) {
    return structureOperationFailure(error, true);
  }
}

export async function handleMolCaptureScreenshot(
  ...args: Parameters<typeof executeMolCaptureScreenshot>
) {
  try {
    return await executeMolCaptureScreenshot(...args);
  } catch (error) {
    return structureOperationFailure(error, false);
  }
}
