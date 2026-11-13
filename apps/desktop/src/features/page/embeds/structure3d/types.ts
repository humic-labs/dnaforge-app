import type { ResidueMeasurement } from './utils/residueMeasurement';
import type { MolecularDataView } from './utils/molecularData';
import type { MolecularCatalogObservation } from '../../../../shared/molecular-catalog';
import type {
  MolecularPrediction,
  MolecularAllele,
  MolecularComparison,
} from './utils/molecularViewSchema';
import type { ProteinIdentityLedger } from '../../../structure-drawer/public/api/protein-identity';
import type { SavedSelectionPolymerRevision } from '@waypoint/workspace-editor';
import type { StructureLinkResidueTarget } from '../../../structure-drawer/public/state/use-structure-link-registry';
import type { StructureViewHandoffDescriptor } from '../../../structure-drawer/public/state/structure-view-handoff';
import type { MolecularView } from '../../../../shared/molecular-view';

import type { Legend } from 'molstar/lib/mol-util/legend';

export type Structure3dSource = 'pdb' | 'alphafold' | 'url' | 'file';

export type Structure3dRepresentation =
  | 'cartoon'
  | 'ball-and-stick'
  | 'surface'
  | 'spacefill'
  | 'illustrative';

export type Structure3dColorMode = 'chain' | 'element' | 'plddt' | 'bfactor' | 'alphamissense';

export type StructureMemberKind = 'protein' | 'rna' | 'dna' | 'ligand' | 'ion' | 'water' | 'other';

export type StructureMemberMappingStatus =
  | 'mapped_current_sequence'
  | 'mapped_workspace'
  | 'external_only'
  | 'ambiguous'
  | 'homolog_only'
  | 'non_protein'
  | 'unmapped';

export type StructureMemberRelationToAnchor =
  | 'query'
  | 'known_partner'
  | 'same_complex'
  | 'cofactor'
  | 'unknown';

export type StructureSceneFocusRole =
  | 'query_anchor'
  | 'partner'
  | 'ligand'
  | 'nucleic_acid'
  | 'external_context';

export type StructureSceneLayerRole = 'query' | 'focus' | 'context';

export interface StructureMemberSelection {
  providerIdentityKey?: string;
  pdbId?: string;
  accession?: string;
  entityIds?: string[];
  labelAsymIds?: string[];
  authAsymIds?: string[];
  chainIds?: string[];
  residueRanges?: Array<[number, number]>;
}

export interface StructureMemberMappingEvidence {
  kind:
    | 'query_anchor'
    | 'workspace_annotation'
    | 'provider_xref'
    | 'exact_sequence'
    | 'homology'
    | 'manual';
  label: string;
  confidence?: 'authoritative' | 'exact' | 'strong' | 'heuristic' | 'degraded';
  source?: string;
}

export interface StructureWorkspaceFeatureRef {
  entityId: string;
  featureKey?: string;
  cdsBounds?: {
    cdsStart: number;
    cdsEnd: number;
    strand: 1 | -1;
  };
  label?: string;
}

export interface StructureComplexMember {
  memberId: string;
  kind: StructureMemberKind;
  selection: StructureMemberSelection;
  displayName: string;
  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
  operators?: string[];
  organism?: string;
  identifiers?: {
    uniprotAccessions?: string[];
    geneNames?: string[];
    pdbEntityDescription?: string;
  };
  relationToAnchor?: StructureMemberRelationToAnchor;
  mappingStatus: StructureMemberMappingStatus;
  mappingEvidence?: StructureMemberMappingEvidence[];
  workspaceFeatureRef?: StructureWorkspaceFeatureRef;
}

export interface StructureQueryAnchor {
  memberId: string;
  sourceEntityId?: string;

  sourceWorkspaceRoot?: string;
  identityRequestKey?: string;
  cdsBounds?: {
    cdsStart: number;
    cdsEnd: number;
    strand: 1 | -1;
  };
  label?: string;
  proteinIdentity?: ProteinIdentityLedger;
  targetSelection: StructureMemberSelection;
}

export interface StructureSceneFocus {
  memberId: string;
  role: StructureSceneFocusRole;
  selection: StructureMemberSelection;
  mappingStatus: StructureMemberMappingStatus;
}

export interface StructureSceneSourceRef {
  source: Structure3dSource;
  sourceId?: string;
  providerIdentityKey?: string;
  pdbId?: string;
  uniprotId?: string;
  accession?: string;
  assemblyId?: string;
  url?: string;
}

export interface StructureSceneLayer {
  id: string;
  kind: 'model';
  role: StructureSceneLayerRole;
  source: StructureSceneSourceRef;
  visible: boolean;
}

export interface StructureSceneProvenance {
  createdBy: 'structure-drawer' | 'structure-tab' | 'agent' | 'import';
  resolverSource?: string;
  resolverIdentity?: number;
  candidateId?: string;
  provider?: Structure3dSource;
  providerIdentityKey?: string;
  sourceUrl?: string;
}

export interface StructureScene {
  schemaVersion: 1;
  sceneId: string;
  sceneKind: 'single_query' | 'complex';
  primaryResourceId: string;
  queryAnchor: StructureQueryAnchor;
  activeFocus?: StructureSceneFocus;
  members: StructureComplexMember[];
  layers: StructureSceneLayer[];
  camera?: unknown;
  provenance: StructureSceneProvenance;
}

export type StructureTargetSelector =
  | { kind: 'whole-structure' }
  | { kind: 'whole-complex' }
  | { kind: 'query-anchor' }
  | { kind: 'active-focus'; memberKinds?: StructureMemberKind[] }
  | { kind: 'context'; memberKinds?: StructureMemberKind[] }
  | { kind: 'member'; memberId: string }
  | { kind: 'member-kind'; memberKinds: StructureMemberKind[] }
  | {
      kind: 'chain';
      entityIds?: string[];
      labelAsymIds?: string[];
      authAsymIds?: string[];
      chainIds?: string[];
    }
  | {
      kind: 'ligand';
      compIds?: string[];
      near?: StructureTargetSelector;
      radiusAngstrom?: number;
    }
  | { kind: 'water' }
  | { kind: 'saved-selection'; highlightGroupId: string };

export interface RepresentationPrimitive {
  kind: Structure3dRepresentation;
  params?: Record<string, unknown>;
}

export type StructureVisualColorMode =
  | Structure3dColorMode
  | 'source-default'
  | 'context-muted'
  | 'uniform'
  | 'residue-layer';

export interface ColorPrimitive {
  mode: StructureVisualColorMode;
  value?: number;
  residueColorLayerId?: string;
}

export interface MaterialPrimitive {
  alpha?: number;
  sizeFactor?: number;
  ignoreLight?: boolean;
  quality?: AdvancedViewerSettings['quality'];
}

export interface VisualLayer {
  id: string;
  target: StructureTargetSelector;
  representation: RepresentationPrimitive;
  color: ColorPrimitive;
  material?: MaterialPrimitive;
  visible: boolean;
  order: number;
}

export interface CanvasRenderSettings {
  advancedSettings?: Partial<AdvancedViewerSettings>;
  outlineEnabled?: boolean;
  aoEnabled?: boolean;
  ambientIntensity?: number;
}

export interface ViewRecipe {
  schemaVersion: 1;
  id: string;
  name: string;
  origin: 'builtin' | 'user' | 'agent' | 'generated';
  layers: VisualLayer[];
  canvas?: CanvasRenderSettings;
}

export interface VisualLayerOverride {
  layerId: string;
  visible?: boolean;
  target?: StructureTargetSelector;
  representation?: RepresentationPrimitive;
  color?: ColorPrimitive;
  material?: MaterialPrimitive;
}

export interface StructureSideChainVisualizationState {
  visibleBackbones?: boolean;

  selection?: boolean;
}

export interface StructureResidueVisualizationState {
  sideChains?: StructureSideChainVisualizationState;
}

export interface StructureViewState {
  schemaVersion: 1;
  activeRecipeId: string | null;
  recipe: ViewRecipe;

  renderIntent?: 'loaded' | 'preview';
  layerOverrides?: VisualLayerOverride[];

  detailMemberIds?: string[];

  detailChainInstanceIds?: string[];

  hiddenChainInstanceIds?: string[];

  residueVisualization?: StructureResidueVisualizationState;
  cameraSnapshot?: string;
  showWater: boolean;
  spin: boolean;
  backgroundColor?: string;
}

export interface SavedStructureView {
  schemaVersion: 1;
  id: string;
  name: string;
  scope: 'global' | 'scene' | 'structure';
  recipe: ViewRecipe;
  cameraSnapshot?: string;
  sourceFingerprint?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AdvancedViewerSettings {
  aoEnabled: boolean;
  aoRadius: number;
  aoBias: number;
  aoIntensity: number;

  outlineEnabled: boolean;
  outlineScale: number;
  outlineThreshold: number;
  outlineColor: number;

  ambientIntensity: number;

  quality: 'auto' | 'low' | 'medium' | 'high' | 'highest';
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedViewerSettings = {
  aoEnabled: false,
  aoRadius: 5,
  aoBias: 0.8,
  aoIntensity: 0.5,
  outlineEnabled: false,
  outlineScale: 1,
  outlineThreshold: 0.33,
  outlineColor: 0x000000,
  ambientIntensity: 0.4,
  quality: 'auto',
};

export interface ResidueLocation {
  chain: string;

  structureRef?: string;

  isPrimarySource?: boolean;

  instanceId?: string;

  position: number;

  compId?: string;

  labelCompId?: string;

  baseChain?: string;

  labelAsymId?: string;

  authAsymId?: string;

  entityId?: string;

  labelSeqId?: number;

  operator?: string;
}

export type StructureSelectionGesture = 'replace' | 'range' | 'toggle';

export interface ResidueInteractionState {
  hovered: ResidueLocation | null;

  selected: ResidueLocation[];
}

export interface ChainSelection {
  chain: string;

  compId?: string;

  baseChain?: string;

  labelAsymId?: string;

  authAsymId?: string;

  entityId?: string;

  operator?: string;

  ranges: [number, number][];
}

export interface HighlightGroup {
  id: string;

  label: string;

  selections: ChainSelection[];

  residueLocations?: ReadonlyArray<ResidueLocation>;

  color?: string;

  renderMode?: 'selection' | 'annotation';

  visible?: boolean;
}

export interface SavedSelectionViewRef {
  selectionId: string;
  revisionId: string;
  artifactPath: string;

  visible: boolean;
}

export interface StructureCoordinateArtifactRef {
  entityId: string;
  revisionId: string;
  structureId: string;
  providerIdentityKey?: string;
  coordinateDigestSha256: string;
  assemblyId?: string;
  artifactPath: string;
  format: 'mmcif' | 'pdb' | 'binary-cif';
}

export type StructureCoordinateRevisionPin =
  | {
      kind: 'artifact';
      pinStatus: 'exact';
      revisionId: string;
      coordinateDigestSha256: string;
      artifactRef: StructureCoordinateArtifactRef;
    }
  | {
      kind: 'provider';
      pinStatus: 'provider-revision';
      revisionId: string;
      providerIdentityKey: string;
      providerRevision?: string;
    }
  | {
      kind: 'unresolved';
      pinStatus: 'unresolved';
      revisionId: string;
      reason: 'coordinate-revision-unavailable';
    };

export interface StructureBinding {
  schemaVersion: 1;
  bindingId: string;
  structureId: string;
  coordinateRevision: StructureCoordinateRevisionPin;
  polymerRevision: SavedSelectionPolymerRevision;
  mappingRevisionId: string;
  physicalChainScope: StructureLinkResidueTarget[];
  linkOwnerId?: string;
}

export interface StructureViewIdentity {
  schemaVersion: 1;
  structureViewId: string;
  bindingId: string | null;
}

export const AGENT_HIGHLIGHT_GROUP_ID_PREFIX = 'agent-highlight:';

export type ChainPolymerType = 'protein' | 'dna' | 'rna' | 'mixed' | 'unknown';

export type StructureColoration =
  | { kind: 'uniform'; color: number }
  | { kind: 'multiple'; colors: readonly number[] }
  | { kind: 'partial'; colors: readonly number[] }
  | { kind: 'unrepresented' }
  | { kind: 'unavailable' };

export type StructureAtomicDetail = 'backbone' | 'atoms';

export interface ChainSequence {
  chainId: string;

  structureRef?: string;

  sourceLabel?: string;

  isPrimarySource?: boolean;

  chainLabel: string;

  sequence: string;

  polymerType?: ChainPolymerType;

  baseChain?: string;

  labelAsymId?: string;

  authAsymId?: string;

  entityId?: string;

  operator?: string;

  instanceId?: string;

  molstarChainSerial?: number;

  coloration?: StructureColoration;

  residues: {
    position: number;

    sequenceIndex?: number;

    labelSeqId?: number;

    name: string;

    displayLabel?: string;

    name3: string;

    parentCompId?: string;

    value?: number;

    coloration?: StructureColoration;

    atomicDetail?: StructureAtomicDetail;

    alphaCarbonColoration?: StructureColoration;
  }[];
}

export interface ChainColorAssignment {
  chainId: string;
  colorKey: string;
  paletteIndex: number;
  cssColor: string;
  molstarColor: number;
}

export interface StructureChainColoring {
  assignments: ChainColorAssignment[];
  colorByChainId: ReadonlyMap<string, string>;
  molstarColorByChainId: ReadonlyMap<string, number>;
  molstarPalette: readonly number[];
}

export interface LigandInfo {
  name: string;

  chainId: string;
  structureRef?: string;
  sourceLabel?: string;
  isPrimarySource?: boolean;

  position: number;

  atomCount: number;

  coloration?: StructureColoration;

  baseChain?: string;

  labelAsymId?: string;

  authAsymId?: string;

  entityId?: string;

  operator?: string;

  instanceId?: string;
}

export interface StructureSequenceData {
  chains: ChainSequence[];

  ligands: LigandInfo[];

  colorLegends?: readonly StructureThemeLegend[];
}

export type StructureThemeLegend = { themeName: string; legend: Legend };

export interface StructureCoordinateModelSelection {
  blockIndex: number;
  modelIndex: number;
}

export interface Structure3dAttrs {
  coordinateScores?: { sha256: string; kind: 'plddt' | 'unscored-prediction'; alphaFold: boolean };
  coordinateSource?: { sha256: string; source: MolecularView['source'] };
  coordinateFormat?: 'bcif';
  coordinateModel?: StructureCoordinateModelSelection;
  catalogProvenance?: MolecularCatalogObservation;

  catalogSource?: { observationId: string; chainKey?: string };
  molecularData?: MolecularDataView;
  predictionProvenance?: MolecularPrediction;
  comparisonProvenance?: MolecularComparison;
  alleleProvenance?: MolecularAllele;
  measurements?: ResidueMeasurement[];
  activeMeasurementId?: string;

  source?: Structure3dSource;

  sourceId?: string;

  coordinateFilePath?: string;

  providerIdentityKey?: string;

  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
  assemblyId?: string;

  accession?: string;
  fragment?: string;
  version?: string;
  modelId?: string;

  label?: string;

  title?: string;

  description?: string;

  organism?: string;

  resolution?: number;

  method?: string;

  height?: number;

  backgroundColor?: string;

  cameraSnapshot?: string;

  settingsCollapsed?: boolean;

  highlightGroups?: HighlightGroup[];

  savedSelectionRefs?: SavedSelectionViewRef[];

  structureArtifactRef?: StructureCoordinateArtifactRef;

  coordinateSha256?: string;

  structureBinding?: StructureBinding;

  structureViewIdentity?: StructureViewIdentity;

  structureLinkOwnerId?: string;

  structureViewHandoff?: StructureViewHandoffDescriptor;

  scene?: StructureScene;

  view?: StructureViewState;

  molViewSpec?: string;

  molViewSpecSavedReferenceId?: string;

  molecularDocumentId?: string;
  molecularDocumentPath?: string;

  molecularDocumentRevision?: string;

  molecularDocumentSavedReferenceId?: string;
  molecularDocumentHistoricalRevisionId?: string;
  molecularDocumentDraftId?: string;
  molecularDocumentProjectId?: string;
  molecularDocumentReference?: import('../../../../shared/molecular-document-reference').MolecularDocumentReference;

  molecularViewSnapshot?: MolecularView;

  molViewSpecAssets?: Array<{
    name: string;
    label: string;
    format: 'pdb' | 'cif';
    text: string;
    sha256: string;
    sourceReferenceId: string;
  }>;

  molViewSpecPrimarySourceReferenceId?: string;

  molViewSpecSnapshotIndex?: number;

  showSequenceViewer?: boolean;

  residueColorLayers?: ResidueColorLayer[];

  activeColorLayerId?: string;

  error?: string;

  name?: string;
  pdbId?: string;
  uniprotId?: string;
  url?: string;

  [key: string]: unknown;
}

export interface SourceConfig {
  id: Structure3dSource;
  label: string;
  shortLabel: string;
  placeholder: string;
  validate: (value: string) => boolean;
  badgeColor: string;
}

const UNIPROT_ACCESSION_PATTERN =
  /^(?:[A-Z][0-9][A-Z0-9]{3}[0-9]|[A-Z][0-9][A-Z][A-Z0-9]{2}[0-9][A-Z][A-Z0-9]{2}[0-9])(?:-\d+)?$/;

export const SOURCE_CONFIGS: Record<Structure3dSource, SourceConfig> = {
  pdb: {
    id: 'pdb',
    label: 'PDB',
    shortLabel: 'PDB',
    placeholder: 'Enter PDB ID (e.g., 1CRN)',
    validate: (v) => /^[0-9][a-zA-Z0-9]{3}$/.test(v),
    badgeColor: 'bg-blue-500/10 text-blue-600',
  },
  alphafold: {
    id: 'alphafold',
    label: 'AlphaFold',
    shortLabel: 'AF',
    placeholder: 'Enter UniProt ID (e.g., P04637)',
    validate: (v) => UNIPROT_ACCESSION_PATTERN.test(v.toUpperCase()),
    badgeColor: 'bg-green-500/10 text-green-600',
  },
  url: {
    id: 'url',
    label: 'URL',
    shortLabel: 'URL',
    placeholder: 'Enter structure URL (.pdb, .cif)',
    validate: (v) => {
      try {
        new URL(v);
        return true;
      } catch {
        return false;
      }
    },
    badgeColor: 'bg-purple-500/10 text-purple-600',
  },
  file: {
    id: 'file',
    label: 'File',
    shortLabel: 'File',
    placeholder: 'Drop a .pdb or .cif file',
    validate: () => true,
    badgeColor: 'bg-orange-500/10 text-orange-600',
  },
};

export const SOURCE_ORDER: Structure3dSource[] = ['pdb', 'alphafold', 'url', 'file'];

export const REPRESENTATION_OPTIONS: { value: Structure3dRepresentation; label: string }[] = [
  { value: 'cartoon', label: 'Cartoon' },
  { value: 'ball-and-stick', label: 'Ball and Stick' },
  { value: 'spacefill', label: 'Spacefill' },
  { value: 'surface', label: 'Surface' },
  { value: 'illustrative', label: 'Illustrative' },
];

export type ResidueDataSourceType = 'alphamissense' | 'conservation' | 'custom';

export interface ColorScaleConfig {
  type: 'continuous' | 'discrete' | 'diverging';

  colors: number[];

  breakpoints?: number[];

  labels?: string[];
}

export interface ResidueColorLayer {
  id: string;

  label: string;

  sourceType: ResidueDataSourceType;

  sourceId?: string;

  values: Record<number, number>;

  domain: [number, number];

  colorScale: ColorScaleConfig;

  metadata?: {
    fetchedAt?: number;
    description?: string;
    citation?: string;
  };
}

export const HIGHLIGHT_COLORS = {
  hover: {
    bg: 'rgba(255, 102, 153, 0.12)',
    outline: 0xff6699,
  },

  selected: {
    bg: 'rgba(51, 255, 25, 0.12)',
    outline: 0x33ff19,
  },
} as const;

export const HIGHLIGHT_PALETTE = [
  '#f44336',
  '#4caf50',
  '#ff9800',
  '#9c27b0',
  '#00bcd4',
  '#795548',
] as const;

export const CHAIN_COLOR_NUMBERS = [
  0xe6194b, 0x2ca02c, 0x1f77ff, 0xff7f0e, 0x8a2be2, 0x00a6d6, 0xff00a8, 0xd4a000, 0x00a878,
  0xff4b00, 0x5b5fff, 0xd62728,
] as const;

const CHAIN_COLOR_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;

function chainColorCss(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

export function getChainColorNumberByPaletteIndex(index: number): number {
  return CHAIN_COLOR_NUMBERS[index % CHAIN_COLOR_NUMBERS.length];
}

export function getChainColorByPaletteIndex(index: number): string {
  return chainColorCss(getChainColorNumberByPaletteIndex(index));
}

export const CHAIN_COLORS: Record<string, string> = Object.fromEntries(
  CHAIN_COLOR_IDS.map((chainId, index) => [chainId, chainColorCss(CHAIN_COLOR_NUMBERS[index])])
);

export function getChainColor(chainId: string): string {
  if (chainId in CHAIN_COLORS) {
    return CHAIN_COLORS[chainId];
  }

  const match = chainId.match(/^([A-Z]+)(\d+)$/);
  if (match) {
    const [, baseChain] = match;
    if (baseChain in CHAIN_COLORS) {
      return CHAIN_COLORS[baseChain];
    }
  }

  const colors = Object.values(CHAIN_COLORS);
  const hash = chainId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

export function getChainColorKey(
  chain: Pick<ChainSequence, 'chainId' | 'authAsymId' | 'baseChain'>
): string {
  return chain.authAsymId || chain.baseChain || chain.chainId;
}

export function getDisplayChainId(
  chain: Pick<ChainSequence, 'chainId' | 'authAsymId' | 'baseChain'>
): string {
  return getChainColorKey(chain);
}

export function getChainColorForSequenceChain(
  chain: Pick<ChainSequence, 'chainId' | 'authAsymId' | 'baseChain'>
): string {
  return getChainColor(getChainColorKey(chain));
}

export function createStructureChainColoring(
  chains: readonly Pick<
    ChainSequence,
    'chainId' | 'authAsymId' | 'baseChain' | 'molstarChainSerial'
  >[]
): StructureChainColoring {
  const colorIndexByKey = new Map<string, number>();
  const colorByChainId = new Map<string, string>();
  const molstarColorByChainId = new Map<string, number>();
  const assignments: ChainColorAssignment[] = [];
  const molstarPalette: number[] = [];
  const chainOrder = new Map(chains.map((chain, index) => [chain, index] as const));
  const orderedChains = [...chains].sort((left, right) => {
    const leftSerial = left.molstarChainSerial;
    const rightSerial = right.molstarChainSerial;
    if (leftSerial !== undefined && rightSerial !== undefined && leftSerial !== rightSerial) {
      return leftSerial - rightSerial;
    }
    if (leftSerial !== undefined && rightSerial === undefined) return -1;
    if (leftSerial === undefined && rightSerial !== undefined) return 1;
    return (chainOrder.get(left) ?? 0) - (chainOrder.get(right) ?? 0);
  });

  for (const chain of orderedChains) {
    const colorKey = getChainColorKey(chain);
    let colorIndex = colorIndexByKey.get(colorKey);
    if (colorIndex === undefined) {
      colorIndex = colorIndexByKey.size;
      colorIndexByKey.set(colorKey, colorIndex);
      molstarPalette.push(getChainColorNumberByPaletteIndex(colorIndex));
    }
    const molstarColor = getChainColorNumberByPaletteIndex(colorIndex);
    const cssColor = chainColorCss(molstarColor);
    colorByChainId.set(chain.chainId, cssColor);
    molstarColorByChainId.set(chain.chainId, molstarColor);
    assignments.push({
      chainId: chain.chainId,
      colorKey,
      paletteIndex: colorIndex,
      cssColor,
      molstarColor,
    });
  }

  return {
    assignments,
    colorByChainId,
    molstarColorByChainId,
    molstarPalette,
  };
}

export function getChainColorAssignments(
  chains: readonly Pick<ChainSequence, 'chainId' | 'authAsymId' | 'baseChain'>[]
): ReadonlyMap<string, string> {
  return createStructureChainColoring(chains).colorByChainId;
}

export const COLOR_SCALE_PRESETS: Record<string, ColorScaleConfig> = {
  alphamissense: {
    type: 'discrete',
    colors: [0x1e88e5, 0xfdd835, 0xe53935],
    breakpoints: [0.34, 0.564],
    labels: ['Benign', 'Ambiguous', 'Pathogenic'],
  },

  diverging: {
    type: 'diverging',
    colors: [0x2166ac, 0xf7f7f7, 0xb2182b],
  },

  viridis: {
    type: 'continuous',
    colors: [0x440154, 0x21918c, 0xfde725],
  },

  heat: {
    type: 'continuous',
    colors: [0x0000ff, 0x00ffff, 0x00ff00, 0xffff00, 0xff0000],
  },
};
