import type { AssemblyResult } from '../assembly/public/assembly-result-types';
import type {
  AcceptedAssemblyHistoricalComponentSource,
  AcceptedAssemblyVersion,
} from '../assembly/public/accepted-types';
import type {
  AssemblyMethod,
  AssemblyMethodDraftSnapshot,
  AssemblyState,
  AssemblyWorkbenchDesignState,
  DesignAnnotation,
  DesignPrimerPair,
  DesignStatus,
  GoldenGateAssemblySchema,
  GoldenGateConfig,
  GoldenGateJunction,
  HomologyRegion,
  MocloFactoryDesignContext,
  MocloStageOutputLink,
  RegionSourceType,
  RestrictionDigestEnds,
  SavedPrimerLink,
  ValidationError,
} from './assembly-contract';

export { ENZYME_SPECS, GOLDEN_GATE_ENZYME_NAMES } from './assembly-contract';
export type {
  AssemblyMethod,
  AssemblyMethodDraftSnapshot,
  AssemblyState,
  AssemblyWorkbenchDesignState,
  DesignAnnotation,
  DesignStatus,
  ValidationError,
  AssemblyWorkbenchJunctionIdentity,
  AssemblyWorkbenchPrimerEditIntent,
  AssemblyWorkbenchPrimerIdentity,
  DesignPrimer,
  DesignPrimerPair,
  GoldenGateAssemblySchema,
  GoldenGateConfig,
  GoldenGateEnzyme,
  GoldenGateJunction,
  GoldenGateOverhangSource,
  GoldenGatePrimerOverhang,
  GoldenGateRoleEvidence,
  GoldenGateRoleTerm,
  GoldenGateSchemaOrigin,
  GoldenGateSchemaSlot,
  HomologyEncoding,
  HomologyRegion,
  HomologyTemplateBasis,
  MocloFactoryDesignContext,
  MocloFactoryStageInput,
  MocloStageOutputLink,
  RegionSourceType,
  RestrictionDigestEnd,
  RestrictionDigestEnds,
  RestrictionDigestOverhangType,
} from './assembly-contract';

export interface DesignRegion {
  id: string;

  schemaSlotId?: string;

  colorIndex?: number;

  sourceSequenceId: string;

  sourceSequenceName: string;

  sourceStart: number;

  sourceEnd: number;

  sequence: string;

  annotations: DesignAnnotation[];

  sourceSequence?: string;

  sourceLength?: number;

  sourceAnnotations?: DesignAnnotation[];

  sourceIsCircular?: boolean;

  isPlaceholder?: boolean;

  mocloStageOutput?: MocloStageOutputLink;

  sourceType?: RegionSourceType;

  ggType?: 'insert' | 'backbone' | 'unusable' | 'rd';

  rdOverhangs?: {
    upstream: string;

    downstream: string;
  };

  rdSourceEnzyme?: 'BsaI' | 'BbsI' | 'BsmBI' | 'SapI';

  rdSourceEnzymeName?: string;

  rdEnds?: RestrictionDigestEnds;

  rdSiblingOverhangs?: string[];
}

export interface DesignSpacer {
  id: string;

  junctionIndex: number;

  anchor?: { leftRegionId: string; rightRegionId: string };

  sequence: string;

  name?: string;
}

export type AssemblyPlan = never;

export interface SequenceDesign {
  id: string;

  constructId?: string;

  parentAcceptedAssemblyVersionId?: string;
  name: string;
  topology: 'linear' | 'circular';

  regions: DesignRegion[];

  spacers: DesignSpacer[];

  version: number;

  assemblyState: AssemblyState;

  validationErrors: ValidationError[];

  proposedPlans: AssemblyPlan[];

  status?: DesignStatus;

  assemblyMethod: AssemblyMethod;

  backboneSequenceId?: string | null;

  defaultHomologyLength: number;

  homologyRegions: HomologyRegion[];

  goldenGateConfig?: GoldenGateConfig;

  goldenGateJunctions?: GoldenGateJunction[];

  goldenGateSchema?: GoldenGateAssemblySchema;

  pendingGoldenGateKit?: { id: string; name: string };

  mocloFactory?: MocloFactoryDesignContext;

  pcrPolymerase?: string | null;
  primerDesignConstraints?: import('./primer-design-constraints').PrimerDesignConstraints;

  designPrimers: DesignPrimerPair[];

  savedPrimerLinks?: SavedPrimerLink[];

  assemblyWorkbench?: AssemblyWorkbenchDesignState;

  assemblyMethodDrafts?: Partial<Record<AssemblyMethod, AssemblyMethodDraftSnapshot>>;

  selectedJunctionIndex: number | null;

  scrollToPosition: number | null;

  highlightRange: { start: number; end: number; wraps?: boolean } | null;

  activeCutSiteIndex?: number | null;

  hoveredCutSiteRegionId?: string | null;

  assemblyResult?: AssemblyResult;

  acceptedAssemblyVersions?: AcceptedAssemblyVersion[];

  activeAcceptedAssemblyVersionId?: string | null;

  historicalComponentSources?: AcceptedAssemblyHistoricalComponentSource[];

  historicalComponentValidatedVersion?: number;

  createdAt: Date;

  updatedAt: Date;
}

export function getComposedSequence(regions: DesignRegion[], spacers: DesignSpacer[] = []): string {
  if (regions.length === 0) return '';

  let result = '';
  for (let i = 0; i < regions.length; i++) {
    result += regions[i].sequence;

    const spacer = spacers.find((s) => s.junctionIndex === i);
    if (spacer) {
      result += spacer.sequence;
    }
  }
  return result;
}
