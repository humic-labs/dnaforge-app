import type {
  AssemblyMethod,
  AssemblyWorkbenchDesignState,
  DesignPrimerPair,
  GoldenGateConfig,
  GoldenGateJunction,
  HomologyRegion,
  RestrictionDigestEnds,
} from '../design/public/assembly-contract';

export const ACCEPTED_ASSEMBLY_SCHEMA_VERSION = 1 as const;

export type AcceptedAssemblyStrand = 'forward' | 'reverse' | 'none';
export type AcceptedAssemblyCopiedDirection = 'forward' | 'reverse-complement';

export type AcceptedAssemblyQualifierValue = string | readonly string[];
export type AcceptedAssemblyQualifierBag = Record<string, AcceptedAssemblyQualifierValue>;

export type AcceptedAssemblyCoordinateRange = {
  start: number;
  end: number;
  wraps?: boolean;
};

export type AcceptedAssemblyCoordinateSegment = AcceptedAssemblyCoordinateRange & {
  strand?: AcceptedAssemblyStrand;
  role:
    | 'included-template'
    | 'included-spacer'
    | 'source-flank'
    | 'restriction-scar'
    | 'primer-tail'
    | 'primer-binding-site';
};

export type AcceptedAssemblySourceAnnotationSnapshot = {
  name: string;
  type: string;
  start: number;
  end: number;
  strand: AcceptedAssemblyStrand;
  color?: string;
  qualifiers?: AcceptedAssemblyQualifierBag;
};

export type AcceptedAssemblySourceProvenanceSnapshot = {
  regionId: string;
  sourceType: 'pcr' | 'restriction-digest';
  sourceSequenceId: string;
  sourceSequenceName: string;

  sourceConstructId?: string;

  sourceSequenceVersionId?: string;

  sourceLocator?: string;
  sourceSequenceChecksum?: string;
  sourceLength?: number;
  sourceIsCircular?: boolean;
  copiedDirection: AcceptedAssemblyCopiedDirection;
  selectedSourceRange: AcceptedAssemblyCoordinateRange;
  includedSourceSegments: readonly AcceptedAssemblyCoordinateSegment[];
  sourceAnnotations: readonly AcceptedAssemblySourceAnnotationSnapshot[];
  copiedAnnotations: readonly AcceptedAssemblySourceAnnotationSnapshot[];
  rdEnds?: RestrictionDigestEnds;
};

export type AcceptedAssemblyRegionInput = {
  id: string;
  colorIndex?: number;
  sourceSequenceId: string;
  sourceSequenceName: string;
  sourceType: 'pcr' | 'rd';
  sourceStart: number;
  sourceEnd: number;
  sequence: string;
  annotations: readonly AcceptedAssemblySourceAnnotationSnapshot[];
  ggType?: 'insert' | 'backbone' | 'unusable' | 'rd';
  rdOverhangs?: {
    upstream: string;
    downstream: string;
  };
  rdSourceEnzyme?: string;
  rdSourceEnzymeName?: string;
  rdEnds?: RestrictionDigestEnds;
  rdSiblingOverhangs?: readonly string[];
};

export type AcceptedAssemblySpacerInput = {
  id: string;
  junctionIndex: number;
  sequence: string;
  name?: string;
};

export type AcceptedAssemblyHistoricalComponentSource = {
  kind: 'region' | 'spacer' | 'join' | 'primer-pair';
  sourceAcceptedAssemblyVersionId: string;
  sourceCanonicalDraftChecksum: string;
  sourceComponentId: string;
  sourceComponentDigest: string;
  targetComponentId: string;
  stagedComponentDigest: string;

  sourceProvenance?: AcceptedAssemblySourceProvenanceSnapshot;
};

export type AcceptedAssemblyCanonicalDraftInput = {
  schemaVersion: typeof ACCEPTED_ASSEMBLY_SCHEMA_VERSION;
  designId: string;

  constructId?: string;

  parentAcceptedAssemblyVersionId?: string;
  designName: string;
  topology: 'linear' | 'circular';
  assemblyMethod: AssemblyMethod;
  backboneSequenceId: string | null;
  defaultHomologyLength: number;
  pcrPolymerase?: string | null;
  primerDesignConstraints?: import('../design/public/primer-design-constraints').PrimerDesignConstraints;
  productSequence: string;
  regions: readonly AcceptedAssemblyRegionInput[];
  spacers: readonly AcceptedAssemblySpacerInput[];
  homologyRegions: readonly HomologyRegion[];
  goldenGateConfig?: GoldenGateConfig;
  goldenGateJunctions?: readonly GoldenGateJunction[];
  designPrimers: readonly DesignPrimerPair[];
  optimizationFingerprint?: string;
  assemblyWorkbench?: AssemblyWorkbenchDesignState;
  sourceProvenance: readonly AcceptedAssemblySourceProvenanceSnapshot[];

  historicalComponentSources?: readonly AcceptedAssemblyHistoricalComponentSource[];
};

export type AcceptedAssemblyProjectionInput = AcceptedAssemblyCanonicalDraftInput & {
  canonicalDraftChecksum: string;
};

export type AcceptedAssemblyValidationIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  field?: string;
  fragmentIndex?: number;
  junctionIndex?: number;
};

export type AcceptedAssemblyValidationSnapshot = {
  schemaVersion: typeof ACCEPTED_ASSEMBLY_SCHEMA_VERSION;
  designId: string;
  designVersion: number;
  assemblyMethod: AssemblyMethod;
  projectionInputChecksum: string;
  validatedAt: string;
  clean: boolean;
  issues: readonly AcceptedAssemblyValidationIssue[];
};

export type AcceptedAssemblyLifecycleState =
  | 'draft'
  | 'accepted'
  | 'writing'
  | 'written'
  | 'write_failed'
  | 'reopen_conflict';

export type AcceptedAssemblyWorkspaceWriteTarget = {
  workspaceFolderId: string;
  relativeDirectory: string;
  basename: string;
  overwrite?: boolean;
};

export type AcceptedAssemblyAbsoluteWriteTarget = {
  absoluteProductPath: string;
  overwrite?: boolean;

  parentIsExistingPackage?: boolean;
};

export type AcceptedAssemblyWriteTarget =
  | AcceptedAssemblyWorkspaceWriteTarget
  | AcceptedAssemblyAbsoluteWriteTarget;

export type AcceptedAssemblyArtifactManifest = {
  productGenBankPath: string;
  sidecarJsonPath: string;
  primerCsvPath: string;
  primerFastaPath: string;
  productSequenceChecksum: string;
  productGenBankChecksum?: string;
  primerCsvChecksum: string;
  primerFastaChecksum: string;
  sidecarChecksum: string;
  canonicalDraftChecksum: string;
};

export type AcceptedAssemblySidecarArtifactSnapshot = Omit<
  AcceptedAssemblyArtifactManifest,
  'sidecarChecksum'
> & {
  sidecarChecksum?: string;
  productGenBankChecksum?: string;
};

export type AcceptedAssemblyPrimerOligo = {
  primerId: string;
  oligoId: string;
  artifactRevision: number;
  sequenceContentHash: string;
};

export type AcceptedAssemblySidecarPayload = {
  type: 'accepted_assembly';
  schemaVersion: typeof ACCEPTED_ASSEMBLY_SCHEMA_VERSION;
  acceptedAssemblyVersionId?: string;

  acceptedVersionId?: string;
  lifecycleState?: AcceptedAssemblyLifecycleState;
  acceptedAt: string;
  acceptedBy?: string;
  designId: string;
  constructId?: string;
  agentOperation?: {
    idempotencyKey: string;
    previewFingerprint: string;
  };
  designName: string;
  construction: {
    method: AssemblyMethod;
    topology: 'linear' | 'circular';
    canonicalDraftChecksum: string;
    optimizationFingerprint?: string;
    regionCount: number;
    spacerCount: number;
  };
  projectionInput: AcceptedAssemblyProjectionInput;
  validationSnapshot: AcceptedAssemblyValidationSnapshot;
  savedPrimerOligos?: readonly AcceptedAssemblyPrimerOligo[];
  artifacts: AcceptedAssemblySidecarArtifactSnapshot;
};

export type AcceptedAssemblyVersion = {
  id: string;
  schemaVersion: typeof ACCEPTED_ASSEMBLY_SCHEMA_VERSION;
  lifecycleState: AcceptedAssemblyLifecycleState;
  acceptedAt: string;
  acceptedBy?: string;
  canonicalDraftChecksum: string;
  projectionInput: AcceptedAssemblyProjectionInput;
  validationSnapshot: AcceptedAssemblyValidationSnapshot;
  savedPrimerOligos?: readonly AcceptedAssemblyPrimerOligo[];
  artifacts?: AcceptedAssemblyArtifactManifest;
};
