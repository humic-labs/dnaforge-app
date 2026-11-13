import type { MutationProteinProduct } from '../../alignment-manager/public/mutation-protein-product';
import type { ProteinIdentityLedger } from '../api/protein-identity';
import type { MolecularCatalogObservation } from '../../../shared/molecular-catalog';

export interface ResolveHints {
  dbXrefs?: string[];
  proteinId?: string;
  locusTag?: string;
  geneName?: string;
  taxonId?: number;
}

export type ResolverSource =
  | 'saved_coordinates'
  | 'computed_coordinates'
  | 'pdb_xref'
  | 'uniprot_xref'
  | 'protein_sequence'
  | 'rcsb_sequence'
  | 'protein_id'
  | 'refseq_xref'
  | 'geneid_xref'
  | 'locus_tag'
  | 'gene_sequence_overlap'
  | 'gene_organism';

export type StructureMoleculeType = 'protein' | 'rna' | 'dna';

export type StructureRef =
  | {
      kind: 'uniprot';
      accession: string;
      providerIdentityKey?: string;
      fragment?: string;
      version?: string;
      modelId?: string;
    }
  | {
      kind: 'pdb';
      pdbId: string;
      providerIdentityKey?: string;
      pdbEntityId?: string;
      labelAsymIds?: string[];
      authAsymIds?: string[];
      assemblyId?: string;
      uniprotFallback?: { accession: string };
    }
  | { kind: 'url'; url: string }
  | {
      kind: 'data';
      format: 'pdb' | 'cif';
      data: string;
      labelAsymIds?: string[];
      coordinateModel?: { blockIndex: number; modelIndex: number };
      catalogProvenance?: MolecularCatalogObservation;
    };

export type StructureProviderKind = 'pdb' | 'alphafold';

export type StructureCandidateGroup = 'rcsb' | 'alphafold';

export interface StructureCandidate {
  id: string;
  provider: StructureProviderKind;
  structure: StructureRef;
  label: string;
  group: StructureCandidateGroup;
  rank: number;
  metadata: {
    title?: string;
    description?: string;
    method?: string;
    resolution?: number;
    chainCount?: number;
    chainIds?: string[];
    polymerTypes?: string[];
    entityDescriptions?: string[];
    organism?: string;
    sourceUrl?: string;
    license?: string;
    attribution?: string;
    depositionDate?: string;
    initialReleaseDate?: string;
    revisionDate?: string;
    revisionVersion?: string;
    meanPlddt?: number;
    uniprotAccession?: string;
    pdbId?: string;
  };
  provenance: {
    resolverSource: ResolverSource;
    identity: number;
    sequenceIdentity?: number;
    externalProtein?: {
      kind: 'uniprot';
      accession: string;
      reviewed?: boolean;
      match: 'exact_sequence' | 'xref' | 'id_mapping' | 'name_search';
      checksumMd5?: string;
      rank: number;
      rankReasons: string[];
    };
    queryIdentity?: {
      kind: 'protein_sequence';
      canonicalForm: 'waypoint-protein-v2';
      checksumMd5: string;
      checksumSha256: string;
      ineligible: boolean;
      evidenceKinds: string[];
    };
    structureIdentity?: {
      kind: 'rcsb' | 'alphafold';
      providerIdentityKey: string;
      pdbId?: string;
      pdbEntityId?: string;
      labelAsymIds?: string[];
      authAsymIds?: string[];
      assemblyId?: string;
      accession?: string;
      version?: string;
      fragment?: string;
      modelId?: string;
    };
    externalResourceId?: string;
    cacheHit?: boolean;
  };
}

export interface RankedStructureCandidates {
  recommendedCandidateId: string;
  candidates: StructureCandidate[];
}

export interface ResolverResult {
  source: ResolverSource;
  identity: number;
  structure: StructureRef;
  proteinIdentity?: ProteinIdentityLedger;
  recommendedCandidateId?: string;
  candidates?: StructureCandidate[];
  confidenceNote?: string;
}

export interface ResolverStep {
  name: ResolverSource;
  hintsRequired: (keyof ResolveHints)[];
  priority: number;
  resolve(
    translation: string,
    hints: ResolveHints,
    signal: AbortSignal,
    request?: StructureDrawerRequest
  ): Promise<ResolverResult | null>;
}

export type StructureDrawerStatus =
  | 'idle'
  | 'resolving'
  | 'rendering'
  | 'ready'
  | 'no_match'
  | 'error';

export interface StructureDrawerRequest {
  alleleOf?: StructureDrawerRequest;
  comparisonOf?: StructureDrawerRequest;
  variantContext?: {
    product?: MutationProteinProduct;
    trackId: string;
    trackLabel: string;
    mutationId: string;
    position: number;
    referenceBase: string;
    alternateBase: string;
    residueIndices: number[];
    mutationType?: 'substitution' | 'insertion' | 'deletion';
    proteinEffect?:
      | 'synonymous'
      | 'missense'
      | 'stop-gained'
      | 'conditional-stop'
      | 'frameshift'
      | 'in-frame-insertion'
      | 'in-frame-deletion';
    changes?: Array<{ residue: number; reference: string; alternate: string }>;
    affectedTail?: { start: number; end: number };
  };
  refusal?: StructureDrawerRefusal;
  translation: string;
  moleculeType?: StructureMoleculeType;
  proteinIdentity?: ProteinIdentityLedger;
  identityRequestKey?: string;
  cdsLabel?: string;
  entityId?: string;
  sourceWorkspaceRoot?: string;
  residueMolecule?: {
    moleculeId: string;
    moleculeKind: 'translated-cds' | 'protein';
    label?: string;
  };
  cdsBounds?: {
    cdsStart: number;
    cdsEnd: number;
    strand: 1 | -1;
  };
  hints: ResolveHints;
  skipSteps?: ResolverSource[];
}

export type StructureResolver = (
  request: StructureDrawerRequest,
  signal: AbortSignal
) => Promise<{ result: ResolverResult | null; cacheHit: boolean }>;

export interface StructureDrawerError {
  code: string;
  message: string;
  failedStep?: ResolverSource;
}

export type StructureDrawerRefusal = StructureDrawerError;
