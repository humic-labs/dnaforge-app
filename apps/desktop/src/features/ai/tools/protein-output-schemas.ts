import { jsonObjectSchema } from '../../../shared/json-value';
import { z } from 'zod';
import { SUPPORTED_BACKTRANSLATE_HOSTS } from '@waypoint/sequence-utils';
import {
  molecularCatalogObservationSchema,
  encodedMoleculeSchema,
} from '../../../shared/molecular-catalog';
import { residueMeasurementSchema } from '../../page/public/embeds/structure3d/residueMeasurement';

const count = z.number().int().nonnegative();
const ids = z.array(z.number().int());
const strings = z.array(z.string());
const values = jsonObjectSchema.describe(
  'Provider-specific metrics or settings retained verbatim.'
);
const measurement = residueMeasurementSchema.innerType();
export const createProteinOutputSchema = z.object({
  ok: z.literal(true),
  changed: z.literal(true),
  proteinId: z.string(),
  name: z.string(),
  sequenceLength: count,
  artifactPath: z.string(),
  registryEntityId: z.string(),
  gitCommitted: z.boolean(),
});
export const backtranslateOutputSchema = z.object({
  ok: z.literal(true),
  refId: z.string().optional(),
  host: z.enum(SUPPORTED_BACKTRANSLATE_HOSTS),
  aminoAcidSequence: z.string(),
  dnaSequence: z.string(),
  dnaLengthBp: count,
  verified: z.boolean(),
});
const selection = z.object({
  chain: z.string(),
  compId: z.string().optional(),
  baseChain: z.string().optional(),
  labelAsymId: z.string().optional(),
  authAsymId: z.string().optional(),
  entityId: z.string().optional(),
  operator: z.string().optional(),
  regions: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
});
export const highlightResiduesOutputSchema = z.object({
  ok: z.literal(true),
  highlighted: z.literal(true),
  structureRef: z.string(),
  structureId: z.string(),
  structureViewId: z.string().nullable(),
  bindingId: z.string().nullable(),
  viewerId: z.string(),
  residueCount: count,
  selections: z.array(selection),
});
export const proteinMeasurementOutputSchema = z.object({
  ok: z.literal(true),
  structureViewId: z.string(),
  measurementId: z.string(),
  rendered: z.literal(true),
  values: measurement.shape.values,
  derivation: measurement.shape.derivation.optional(),
  mappedResidues: ids,
  unmappedResidues: ids,
  message: z.string(),
});
export const colorVariantProteinOutputSchema = z.object({
  ok: z.literal(true),
  measurementId: z.string(),
  name: z.string(),
  rendered: z.literal(true),
  source: measurement.shape.source,
  scale: measurement.shape.scale,
  aggregation: z.enum(['maximum', 'maximum-absolute']),
  mappedResidues: ids,
  unmappedResidues: ids,
  values: measurement.shape.values,
  excludedCallCount: count,
  unknownResidueCount: count,
});
export const proteinContextOutputSchema = z.object({
  ok: z.literal(true),
  source: z.enum(['protein-mcp', 'uniprot-mcp']),
  agent_artifact_id: z.string().nullable().optional(),
  attribution: z.string().nullable(),
  binding_id: z.string().nullable().optional(),
  cache_hit: z.boolean(),
  external_id: z.string(),
  external_resource_id: z.string(),
  license: z.string().nullable(),
  metadata: values.describe(
    'Original upstream scientific response, with its source-specific fields retained.'
  ),
  provider: z.string(),
  xref_count: count,
});

const presented = z.object({
  status: z.literal('presented'),
  tabId: z.string(),
  panelId: z.string(),
  tabType: z.string(),
  disposition: z.enum(['created', 'reused']),
  content: z.enum(['ready', 'loading', 'missing', 'error']),
});
const run = z.object({
  jobRecordId: z.string(),
  provider: z.string(),
  remoteId: z.string(),
  toolId: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
  settingsHash: z.string(),
});
const predictionSummary = z.object({
  kind: z.literal('protein-prediction-result'),
  version: z.literal(1),
  run,
  origin: z.object({ workspaceRoot: z.string(), filePath: z.string() }),
  chainCount: count,
  metrics: values,
  provenance: z.record(z.string()),
  id: z.string(),
  chainId: z.string(),
  proteinLength: count,
});
export const proteinStructureComparisonOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    predictions: z.array(predictionSummary),
    notices: strings,
    runs: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        toolId: z.string(),
        remoteId: z.string().nullable(),
        label: z.string().nullable(),
        state: z.enum([
          'intent',
          'submitted',
          'queued',
          'running',
          'completed',
          'failed',
          'canceled',
          'imported',
        ]),
        createdAt: z.string(),
        workspaceRoot: z.string().nullable(),
        settingsHash: z.string(),
        lastError: z.string().nullable(),
      })
    ),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal('protein-required'),
    documentId: z.string(),
    message: z.string(),
  }),
  presented.extend({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(true),
    views: z.array(z.object({ id: z.string(), display_label: z.string(), created_at: z.number() })),
  }),
  z.object({
    ok: z.literal(true),
    referenceId: z.string(),
    proteinKey: z.string(),
    chainId: z.string(),
    jobRecordId: z.string(),
    nextAction: z.object({
      tool: z.literal('mol_list_structures'),
      input: z.object({}),
      reason: z.string(),
    }),
  }),
  z.object({ ok: z.literal(true), referenceId: z.string(), proteinKey: z.string() }),
  z.object({
    ok: z.literal(true),
    status: z.literal('loading'),
    comparison: z.object({
      referenceId: z.string(),
      alternateId: z.string(),
      referenceSha256: z.string(),
      alternateSha256: z.string(),
      referenceChain: z.string().optional(),
      alternateChain: z.string().optional(),
    }),
  }),
]);
const chainKind = z.enum(['protein', 'rna', 'dna', 'mixed', 'unknown', 'non-polymer']);
const sequenceEvidence = z.enum(['declared', 'observed-only', 'unresolved', 'non-polymer']);
const chainIdentity = {
  key: z.string(),
  blockIndex: count,
  modelIndex: count,
  modelNumber: z.number().int(),
  labelAsymId: z.string(),
  authAsymId: z.string(),
  entityId: z.string(),
  kind: chainKind,
  sequenceEvidence,
};
const relationship = z.enum(['exact', 'partial', 'homolog', 'unresolved']);
const catalogMatch = z.object({
  observation: molecularCatalogObservationSchema.extend({
    run: molecularCatalogObservationSchema.shape.run.unwrap().omit({ settings: true }).nullable(),
  }),
  chains: z.array(
    z.object({
      ...chainIdentity,
      sequenceLength: count,
      observedResidueCount: count,
      unresolvedCount: count,
      relationship: relationship.nullable(),
      mappedCount: count,
      matchCount: count,
      mismatchCount: count,
    })
  ),
});
const catalogChain = z.object({
  ...chainIdentity,
  sequence: z.string().nullable(),
  sequencePositions: ids,
  declaredComponents: strings,
  unresolved: z.array(z.object({ sequenceIndex: count, components: strings, reason: z.string() })),
  observedResidues: z.array(
    z.object({
      labelSequenceId: z.number().int().nullable(),
      authorSequenceId: z.number().int().nullable(),
      insertionCode: z.string(),
      componentIds: strings,
      encodedCode: z.string().nullable(),
      atomCount: count,
    })
  ),
});
const catalogMapping = z.object({
  molecule: encodedMoleculeSchema,
  chainKey: z.string(),
  relationship,
  status: z.enum(['mapped', 'unavailable']),
  method: z.enum([
    'encoded-identity-v1',
    'author-numbering',
    'sequence-alignment',
    'declared-empty-chain',
  ]),
  residues: z.array(
    z.object({ sequencePosition: z.number().int().positive(), observedResidueIndex: count })
  ),
  sequenceLength: count,
  mappedCount: count,
  matchCount: count,
  mismatchCount: count,
  unavailableReason: z.string().optional(),
});
export const molecularStructuresOutputSchema = z.union([
  z.object({ ok: z.literal(true), match: catalogMatch }),
  z.object({ ok: z.literal(true), matches: z.array(catalogMatch) }),
  z.object({
    ok: z.literal(true),
    observation: molecularCatalogObservationSchema,
    chain: catalogChain,
    mappings: z.array(catalogMapping),
  }),
  z.object({
    ok: z.literal(true),
    documentId: z.string(),
    observationId: z.string(),
    chainKey: z.string(),
  }),
  z.object({ ok: z.literal(true), opened: presented }),
]);
