import { z } from 'zod';
import { ENCODED_SEQUENCE_MAX_LENGTH, type EncodedMolecule } from './encoded-molecule';
import type { FrozenComputeRequest, ProviderReportedComputeRequest } from './compute-request';

export const MOLECULAR_CATALOG_NORMALIZER_VERSION = 1;
export { MOLECULAR_COORDINATE_MAX_BYTES as MOLECULAR_CATALOG_MAX_COORDINATE_BYTES } from './molecular-storage';
export const molecularCatalogFormatSchema = z.enum(['pdb', 'cif', 'bcif']);
export type MolecularCatalogFormat = z.infer<typeof molecularCatalogFormatSchema>;
const identifier = z.string().min(1).max(4096);
export const encodedMoleculeSchema = z
  .object({
    kind: z.enum(['protein', 'rna', 'dna']),
    sequence: z.string().min(1).max(ENCODED_SEQUENCE_MAX_LENGTH),
  })
  .strict();

export const molecularCatalogRegisterSchema = z
  .object({
    workspaceRoot: identifier,
    filePath: identifier,
    format: molecularCatalogFormatSchema.optional(),
    label: z.string().min(1).max(500).optional(),
    source: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('import'), uri: identifier.optional() }).strict(),
        z
          .object({
            kind: z.literal('prediction'),
            jobRecordId: identifier,
            outputKey: identifier.optional(),
          })
          .strict(),
      ])
      .default({ kind: 'import' }),

    molecules: z.array(encodedMoleculeSchema).max(100).optional(),
  })
  .strict();
export type MolecularCatalogRegisterInput = z.infer<typeof molecularCatalogRegisterSchema>;

export const molecularCatalogListSchema = z
  .object({
    molecule: encodedMoleculeSchema.optional(),
    jobRecordId: identifier.optional(),

    requestHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),

    providerRequestHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type MolecularCatalogListInput = z.infer<typeof molecularCatalogListSchema>;

export interface MolecularCatalogObservedResidue {
  labelSequenceId: number | null;
  authorSequenceId: number | null;
  insertionCode: string;
  componentIds: string[];
  encodedCode: string | null;
  atomCount: number;
}

export interface MolecularCatalogChain {
  key: string;
  blockIndex: number;
  modelIndex: number;
  modelNumber: number;
  labelAsymId: string;
  authAsymId: string;
  entityId: string;
  kind: 'protein' | 'rna' | 'dna' | 'mixed' | 'unknown' | 'non-polymer';
  sequence: string | null;
  sequenceEvidence: 'declared' | 'observed-only' | 'unresolved' | 'non-polymer';
  sequencePositions: number[];
  declaredComponents: string[];
  unresolved: Array<{ sequenceIndex: number; components: string[]; reason: string }>;
  observedResidues: MolecularCatalogObservedResidue[];
}

export interface MolecularCatalogInventory {
  version: typeof MOLECULAR_CATALOG_NORMALIZER_VERSION;
  coordinateSha256: string;
  byteCount: number;
  blockCount: number;
  modelCount: number;
  chains: MolecularCatalogChain[];
}

export interface MolecularCatalogMapping {
  molecule: EncodedMolecule;
  chainKey: string;
  relationship: 'exact' | 'partial' | 'homolog' | 'unresolved';
  status: 'mapped' | 'unavailable';
  method:
    | 'encoded-identity-v1'
    | 'author-numbering'
    | 'sequence-alignment'
    | 'declared-empty-chain';

  residues: Array<{ sequencePosition: number; observedResidueIndex: number }>;
  sequenceLength: number;
  mappedCount: number;
  matchCount: number;
  mismatchCount: number;
  unavailableReason?: string;
}

export interface MolecularCatalogObservation {
  id: string;
  coordinateId: string;
  coordinateSha256: string;
  format: MolecularCatalogFormat;
  byteCount: number;
  label: string;
  sourceKind: 'import' | 'prediction' | 'legacy-unverified';
  origin: { workspaceRoot: string; filePath: string; uri?: string };

  run: null | {
    jobRecordId: string;
    provider: string;
    remoteId: string;
    toolId: string;
    settingsHash: string;
    settingsDigest: string;
    settings: Record<string, unknown>;
    createdAt: string;
    outputKey: string;
  };
  metrics: Record<string, unknown>;
  provenance: Record<string, string>;
  requestEvidence?: MolecularCatalogRequestEvidence;
  createdAt: number;
}

const molecularCatalogRequestEvidenceSchema = z
  .object({
    clientSha256: z.string().regex(/^[0-9a-f]{64}$/),
    providerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    model: z.string().min(1).max(256),
    version: z.string().min(1).max(256),
  })
  .strict();
export type MolecularCatalogRequestEvidence = z.infer<typeof molecularCatalogRequestEvidenceSchema>;
export interface MolecularCatalogPredictionRequest {
  client: FrozenComputeRequest;
  provider: ProviderReportedComputeRequest;
}

export const molecularCatalogObservationSchema = z
  .object({
    id: identifier,
    coordinateId: identifier,
    coordinateSha256: z.string().regex(/^[0-9a-f]{64}$/),
    format: molecularCatalogFormatSchema,
    byteCount: z.number().int().positive(),
    label: z.string().min(1).max(500),
    sourceKind: z.enum(['import', 'prediction', 'legacy-unverified']),
    origin: z
      .object({ workspaceRoot: identifier, filePath: identifier, uri: identifier.optional() })
      .strict(),
    run: z
      .object({
        jobRecordId: identifier,
        provider: identifier,
        remoteId: identifier,
        toolId: identifier,
        settingsHash: identifier,
        settingsDigest: identifier,
        settings: z.record(z.unknown()),
        createdAt: identifier,
        outputKey: identifier,
      })
      .strict()
      .nullable(),
    metrics: z.record(z.unknown()),
    provenance: z.record(z.string()),
    requestEvidence: molecularCatalogRequestEvidenceSchema.optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export interface MolecularCatalogMatch {
  observation: Omit<MolecularCatalogObservation, 'run'> & {
    run: Omit<NonNullable<MolecularCatalogObservation['run']>, 'settings'> | null;
  };
  chains: Array<
    Pick<
      MolecularCatalogChain,
      | 'key'
      | 'blockIndex'
      | 'modelIndex'
      | 'modelNumber'
      | 'labelAsymId'
      | 'authAsymId'
      | 'entityId'
      | 'kind'
      | 'sequenceEvidence'
    > & {
      sequenceLength: number;
      observedResidueCount: number;
      unresolvedCount: number;
      relationship: MolecularCatalogMapping['relationship'] | null;
      mappedCount: number;
      matchCount: number;
      mismatchCount: number;
    }
  >;
}

export interface MolecularCatalogLoaded {
  observation: MolecularCatalogObservation;

  bytes: Uint8Array;
  inventory: MolecularCatalogInventory;
  mappings: MolecularCatalogMapping[];

  predictionRequest?: MolecularCatalogPredictionRequest;
}

export interface MolecularCatalogAPI {
  register(input: MolecularCatalogRegisterInput): Promise<MolecularCatalogMatch>;
  list(input: MolecularCatalogListInput): Promise<MolecularCatalogMatch[]>;
  load(observationId: string): Promise<MolecularCatalogLoaded>;
}
