export type AssemblyMethod = 'gibson' | 'nebuilder' | 'goldengate';

export const GOLDEN_GATE_ENZYME_NAMES = ['BsaI', 'BbsI', 'BsmBI', 'SapI'] as const;
export type GoldenGateEnzyme = (typeof GOLDEN_GATE_ENZYME_NAMES)[number];

export interface GoldenGateRoleTerm {
  id?: string;
  label: string;
}

export interface GoldenGateRoleEvidence extends GoldenGateRoleTerm {
  source: string;
}

export type GoldenGateSchemaOrigin =
  | { type: 'custom' }
  | { type: 'kit'; kitId: string; kitName: string; schemaId?: string }
  | { type: 'imported'; sourceLabel: string };

export interface GoldenGateSchemaSlot {
  id: string;
  label: string;
  outgoingOverhang: string | null;
  preferredRoles: GoldenGateRoleTerm[];
}

export interface GoldenGateAssemblySchema {
  id: string;
  name: string;
  revision: number;
  origin: GoldenGateSchemaOrigin;
  enzyme: GoldenGateEnzyme;
  slots: GoldenGateSchemaSlot[];
}

export interface MocloFactoryStageInput {
  slotId: string;
  sourceStageId: string;
}

export type MocloStageOutputLink =
  | {
      status: 'unresolved';
      runId: string;
      kitId: string;
      kitRevision: number;
      recipeId: string;
      sourceStageId: string;
    }
  | {
      status: 'live';
      runId: string;
      kitId: string;
      kitRevision: number;
      recipeId: string;
      sourceStageId: string;
      sourceDesignId: string;
    };

export interface MocloFactoryDesignContext {
  runId: string;
  kitId: string;
  kitRevision: number;
  recipeId: string;
  stageId: string;
  stageInputs: MocloFactoryStageInput[];
}

export const ENZYME_SPECS: Record<
  GoldenGateEnzyme,
  {
    site: string;
    cutOffset: number;
    overhangLength: number;
    spacer: string;
    padding5prime: string;
  }
> = {
  BsaI: { site: 'GGTCTC', cutOffset: 1, overhangLength: 4, spacer: 'A', padding5prime: 'GCGC' },
  BbsI: { site: 'GAAGAC', cutOffset: 2, overhangLength: 4, spacer: 'AA', padding5prime: 'GCGC' },
  BsmBI: { site: 'CGTCTC', cutOffset: 1, overhangLength: 4, spacer: 'A', padding5prime: 'GCGC' },
  SapI: { site: 'GCTCTTC', cutOffset: 1, overhangLength: 3, spacer: 'AAA', padding5prime: 'GCGC' },
};

export interface GoldenGateConfig {
  enzyme: GoldenGateEnzyme;
  offsetLimitBp?: number;
}

export type GoldenGateOverhangSource =
  | { type: 'rd-fixed'; fromRegionIndex: number }
  | { type: 'pcr-designed' }
  | { type: 'pcr-matched-rd'; matchedRegionIndex: number };

export interface GoldenGateJunction {
  junctionIndex: number;

  junctionPosition: number;

  offset: number;

  overhangStart: number;

  overhangEnd: number;

  overhang: string;

  source: GoldenGateOverhangSource;

  isValid: boolean;
  validationError?: string;
}

export interface GoldenGatePrimerOverhang {
  padding5prime: string;
  enzymeSite: string;
  spacer: string;
  overhang: string;
  literalExtra: string;
  literalSpacerLength?: number;
  fullSequence: string;
}

export interface HomologyEncoding {
  onLeft: number;
  onRight: number;
}

export interface HomologyTemplateBasis {
  leftHomologyEnd: number;
  rightHomologyStart: number;
  spacerLength: number;
  spacerContributesToAnnealing: boolean;
  leftSpacerIncludedInHomology: boolean;
  leftHomologyAllowed?: boolean;
  rightHomologyAllowed?: boolean;
}

export interface HomologyRegion {
  id: string;
  junctionIndex: number;
  junctionPosition: number;
  start: number;
  end: number;
  encoding: HomologyEncoding;
  templateBasis?: HomologyTemplateBasis;
  metadata?: {
    sequence?: string;
    tmEstimate?: number;
    gcContent?: number;
  };
}

export interface DesignPrimer {
  id: string;
  name: string;
  manuallyEdited?: boolean;
  manuallyNamed?: boolean;
  oligo?: import('../primers/public/oligo-modifications').PrimerOligoCompositionV1;

  sequence: string;

  pbs: {
    start: number;

    end: number;

    sequence: string;
  };

  overhang: {
    length: number;

    sequence: string;

    tailLength?: number;

    spacerSequence?: string;
  };

  goldenGateOverhang?: GoldenGatePrimerOverhang;

  direction: 'forward' | 'reverse';

  fragmentIndex: number;

  junctionIndex: number | null;

  tm?: number;

  cognate4bpLength?: number;

  synthetic4bpSpacerLength?: number;

  tmProvenance?: {
    source: string;
    verified: boolean;

    model?: import('./algorithms/tm-model').TmModel;

    concNm?: number;
    pending?: boolean;
    ta?: number;
    meta?: Record<string, unknown>;
  };
}

export type SavedPrimerLinkOrigin = 'saved-from-assembly' | 'matched-existing';

export interface SavedPrimerLink {
  primerId: string;
  oligoId: string;
  artifactRevision: number;
  sequenceContentHash: string;
  linkedAtDesignVersion: number;
  linkedAt: string;
  via: SavedPrimerLinkOrigin;
}

export interface DesignPrimerPair {
  forward: DesignPrimer;
  reverse: DesignPrimer;
  fragmentIndex: number;
}

export interface AssemblyWorkbenchJunctionIdentity {
  id: string;
  slot: number;
  leftRegionId: string | null;
  rightRegionId: string | null;
  createdAtVersion?: number;
}

export interface AssemblyWorkbenchPrimerIdentity {
  id: string;
  regionId: string;
  direction: 'forward' | 'reverse';
  createdAtVersion?: number;
}

export interface AssemblyWorkbenchPrimerEditIntent {
  id: string;
  regionId: string;
  direction: 'forward' | 'reverse';
  junctionIndex: number | null;
  field: 'pbsLength' | 'tailLength' | 'homologyLength';
  length: number;
  updatedAtVersion?: number;
}

export interface AssemblyWorkbenchDesignState {
  junctions: AssemblyWorkbenchJunctionIdentity[];
  primers: AssemblyWorkbenchPrimerIdentity[];
  primerEditIntents?: AssemblyWorkbenchPrimerEditIntent[];
  autoDraftPrimers?: boolean;
}

export type DesignStatus = 'draft' | 'computed' | 'assembled';

export type AssemblyState =
  | 'preflight'
  | 'drafting'
  | 'validating'
  | 'ready'
  | 'running'
  | 'assembled';

export interface ValidationError {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  field?: string;
  fragmentIndex?: number;
}

export interface AssemblyMethodDraftSnapshot {
  id: string;
  method: AssemblyMethod;
  compositionKey: string;
  savedAtVersion: number;
  savedAtMs: number;
  assemblyState: AssemblyState;
  status?: DesignStatus;
  validationErrors: ValidationError[];
  homologyRegions: HomologyRegion[];
  goldenGateConfig?: GoldenGateConfig;
  goldenGateJunctions?: GoldenGateJunction[];
  designPrimers: DesignPrimerPair[];
  assemblyWorkbench?: AssemblyWorkbenchDesignState;
  selectedJunctionIndex: number | null;
  scrollToPosition: number | null;
  highlightRange: { start: number; end: number; wraps?: boolean } | null;
}

export interface DesignAnnotation {
  name: string;
  type: string;
  start: number;
  end: number;
  strand: 'forward' | 'reverse' | 'none';
  color?: string;
  qualifiers?: Record<string, string>;
}

export type RegionSourceType = 'pcr' | 'rd';

export type RestrictionDigestOverhangType = 'blunt' | '5_prime' | '3_prime';

export interface RestrictionDigestEnd {
  overhang?: string;
  overhangType?: RestrictionDigestOverhangType;
  recognitionSequence?: string;
  recognitionStart?: number;
  recognitionEnd?: number;
  cutPositionTop?: number;
  cutPositionBottom?: number;
  strand?: 'forward' | 'reverse';
  retainedScarSequence?: string;
  retainedScarLength?: number;
  nebuilderResectionBases?: number;
}

export interface RestrictionDigestEnds {
  upstream?: RestrictionDigestEnd;
  downstream?: RestrictionDigestEnd;
}
