import { calculateGcContent } from './tm/tm-calculator';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../path-boundary';
import { validatePrimerSequence } from './primer-validation';
import type { DnaSequenceTopology, LimsRegistrationStatus } from '../lims';
import {
  isLimsFieldType,
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  validateLimsEntityFields,
  type LimsFieldDefinition,
} from '../lims';
import { isPortableEntitySchemaRevisionSnapshot } from '../entity-schema';
import type { PrimerApplication, PrimerEntitySchemaSnapshot } from './types';
import { estimateLegacyPrimerTm, type PrimerTmCalculationV1 } from './primer-tm-compatibility';
import { PRIMER_MANAGED_SCHEMA_FIELD_KEYS } from './primer-schema-contract';
import {
  parseIdtOligoNotation,
  type AppliedOligoModificationV1,
  type PrimerOligoCompositionV1,
} from './oligo-modifications';
import type { OligoOrderType } from './oligo-order-type';
import {
  parsePrimerRegistryRelationships,
  type PrimerRegistryRelationship,
} from '../primer-registry-relationships';

export type { PrimerTmCalculationV1 } from './primer-tm-compatibility';

import { PRIMER_ARTIFACT_SCHEMA } from '../primer-artifact-schema';
export { PRIMER_ARTIFACT_SCHEMA } from '../primer-artifact-schema';
export const PRIMER_ARTIFACT_SCHEMA_VERSION = 3 as const;
export const PRIMER_ARTIFACT_EXTENSION = '.primer.json' as const;
export const BUILTIN_PRIMER_SCHEMA_ID = 'schema-entity-oligo' as const;
export const BUILTIN_PRIMER_SCHEMA_REVISION_ID = 'schema-entity-oligo-v1' as const;
export const BUILTIN_RNA_OLIGO_SCHEMA_ID = 'schema-entity-rna_oligo' as const;
export const BUILTIN_RNA_OLIGO_SCHEMA_REVISION_ID = 'schema-entity-rna_oligo-v1' as const;

export type { PrimerEntitySchemaSnapshot } from './types';

export function createBuiltinPrimerSchemaSnapshot(
  orderType: OligoOrderType = 'dna'
): PrimerEntitySchemaSnapshot {
  const schemaName = orderType === 'rna' ? 'rna_oligo' : 'oligo';
  const oligo = LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === schemaName);
  if (!oligo) throw new Error(`The built-in ${schemaName} schema is missing.`);
  return {
    schemaId: orderType === 'rna' ? BUILTIN_RNA_OLIGO_SCHEMA_ID : BUILTIN_PRIMER_SCHEMA_ID,
    schemaRevisionId:
      orderType === 'rna'
        ? BUILTIN_RNA_OLIGO_SCHEMA_REVISION_ID
        : BUILTIN_PRIMER_SCHEMA_REVISION_ID,
    name: oligo.name,
    displayName: oligo.displayName,
    baseKind: 'primer',
    version: 1,
    description: oligo.description,
    fields: oligo.fields.map((field) => ({ ...field })),
  };
}

export type PrimerDesignApplication =
  | 'pcr'
  | 'sequencing'
  | 'qpcr'
  | 'colony_pcr'
  | 'gibson'
  | 'golden_gate'
  | 'sdm'
  | 're_cloning';

export interface PrimerArtifactBindingV1 {
  id: string;
  relation: 'binds_to_sequence';
  target: {
    documentId: string;
    projectId?: string;
    legacyWorkspaceRelativePath?: string;
    topology: DnaSequenceTopology;
    length: number;
    fileContentHash: string;
    normalizedSequenceHash: string;
  };
  coordinates: {
    system: 'zero_based_half_open';
    start: number;
    end: number;
    strand: 1 | -1;
  };
  source: 'drag-selection' | 'manual' | 'reconciled' | 'agent-design';
  history?: { createdAt: number; updatedAt: number; source: string };
  alignment?: {
    identity: number;
    editDistance: number;
    mismatchPositions: number[];
    threePrimeMatchLength: number;
    effectiveTmC: number;
  };
}

export interface PrimerDesignProvenanceV1 {
  designId: string;
  candidateId: string;
  candidateRank: number;
  role: 'forward' | 'reverse';
  pbsSequence: string;
  overhangSequence: string;
  target: {
    documentId: string;
    projectId?: string;
    legacyWorkspaceRelativePath?: string;
    topology: DnaSequenceTopology;
    length: number;
    fileContentHash: string;
    normalizedSequenceHash: string;
    start: number;
    end: number;
    wrapsOrigin: boolean;
  };
  primer3: {
    application: PrimerDesignApplication;
    parameters: Record<string, string | number | boolean | null>;
    warnings: string[];
  };

  tm: PrimerTmCalculationV1;
}

export interface PrimerAnnealingSegment {
  pbsSequence: string;
  overhangSequence: string;
}

export interface PrimerArtifactV1 {
  schema: typeof PRIMER_ARTIFACT_SCHEMA;
  schemaVersion: 2 | typeof PRIMER_ARTIFACT_SCHEMA_VERSION;
  artifactRevision: number;
  id: string;
  name: string;
  catalogNumber: string;
  sequence: {
    bases: string;
    topology: 'linear';
    length: number;
    contentHash: string;
  };

  oligo?: PrimerOligoCompositionV1;
  annealing?: PrimerAnnealingSegment;
  computed: {
    tmC: number | null;
    gcPercent: number;

    tmCalculation?: PrimerTmCalculationV1;
  };
  metadata: {
    createdAt: string;
    updatedAt: string;
    actor: string;
    source: 'drag-selection' | 'manual' | 'reconciled' | 'assembly' | 'agent-design';
    application: PrimerApplication | null;
    notes: string | null;
  };
  registry: {
    required: true;
    entityId: string;
    kind: string;
    use: 'primer';
  };

  entity?: {
    schema: PrimerEntitySchemaSnapshot;
    fields: Record<string, unknown>;

    otherFields?: Record<string, unknown>;
    state?: {
      registrationStatus: LimsRegistrationStatus;
      domainStatus: string | null;
      archived: boolean;
      archivedAt: number | null;
      status?: string | null;
      source?: string | null;
    };
  };

  recovery?: {
    schema: 'dnaforge.primer-recovery/v1';
    source: 'registry' | 'legacy';
    sourceFingerprint: string;
    sourceActor?: string | null;
    legacyFingerprint?: string;
    relationshipsFingerprint?: string;
    originalComputed?: { length: number; tmC: number | null; gcPercent: number };
  };
  inventory?: {
    origin: string;
    originDetails: Record<string, unknown> | null;
    vendor: string | null;
    orderDate: number | null;
    scale: string | null;
    purification: string | null;
    modifications: string | null;
    stockLocation: string | null;
    concentration: number | null;
  };
  file: {
    workspaceRelativePath: string;
  };
  bindings: PrimerArtifactBindingV1[];

  registryRelationships?: PrimerRegistryRelationship[];
  designProvenance?: PrimerDesignProvenanceV1;
}

export interface PrimerArtifactBuildInput {
  id: string;
  catalogNumber: string;
  name: string;
  sequence: string;
  oligo?: PrimerOligoCompositionV1;
  annealing?: PrimerAnnealingSegment;
  inventory?: PrimerArtifactV1['inventory'];
  workspaceRoot: string;
  artifactPath: string;
  binding?: {
    id: string;
    targetDocumentId: string;
    targetFilePath: string;
    targetLength: number;
    targetTopology: DnaSequenceTopology;
    targetFileContentHash: string;
    targetNormalizedSequenceHash: string;
    start: number;
    end: number;
    strand: 1 | -1;
  };
  application?: PrimerApplication | null;
  notes?: string | null;
  actor?: string;
  source?: 'drag-selection' | 'manual' | 'reconciled' | 'assembly' | 'agent-design';
  designProvenance?: PrimerDesignProvenanceV1;
  tmCalculation?: PrimerTmCalculationV1;
  entitySchema?: PrimerEntitySchemaSnapshot;
  entityFields?: Record<string, unknown>;
  now?: number;
}

export function primerArtifactMetadataFields(artifact: PrimerArtifactV1): Record<string, unknown> {
  return {
    ...(artifact.metadata.notes !== null ? { notes: artifact.metadata.notes } : {}),
    ...(artifact.metadata.application !== null
      ? { application: artifact.metadata.application }
      : {}),
    ...artifact.entity?.fields,
  };
}

export function primerArtifactNotes(artifact: PrimerArtifactV1): string | null {
  const notes = primerArtifactMetadataFields(artifact).notes;
  return typeof notes === 'string' ? notes : null;
}

export function resolvePrimerArtifactMetadata(
  schema: PrimerEntitySchemaSnapshot,
  input: Pick<PrimerArtifactBuildInput, 'entityFields' | 'notes'>,
  previous?: PrimerArtifactV1
): { fields: Record<string, unknown>; notes: string | null } {
  const fields = { ...(input.entityFields ?? previous?.entity?.fields ?? {}) };
  const schemaHasNotes = schema.fields.some((field) => field.key === 'notes');
  const previousNotes = previous ? primerArtifactNotes(previous) : null;
  if (
    input.entityFields === undefined &&
    schemaHasNotes &&
    !Object.hasOwn(fields, 'notes') &&
    previousNotes !== null
  ) {
    fields.notes = previousNotes;
  }
  if (input.notes !== undefined) {
    if (
      input.entityFields !== undefined &&
      Object.hasOwn(input.entityFields, 'notes') &&
      (input.entityFields.notes ?? null) !== input.notes
    ) {
      throw new Error('Conflicting primer Notes were supplied in metadata and schema fields.');
    }
    if (schemaHasNotes) {
      if (input.notes === null) delete fields.notes;
      else fields.notes = input.notes;
    }
  }
  const notes =
    input.notes !== undefined
      ? input.notes
      : Object.hasOwn(fields, 'notes')
        ? typeof fields.notes === 'string'
          ? fields.notes
          : null
        : schemaHasNotes
          ? null
          : previousNotes;
  assertPrimerEntityMetadata(schema, fields);
  return { fields, notes };
}

export type PrimerArtifactPathValidation =
  | { valid: true; relativePath: string }
  | { valid: false; error: string };

export function sanitizePrimerArtifactStem(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return sanitized || 'Primer';
}

export function defaultPrimerArtifactPath(workspaceRoot: string, name: string): string {
  const separator = workspaceRoot.includes('\\') ? '\\' : '/';
  const root = workspaceRoot.replace(/[\\/]+$/, '');
  return `${root}${separator}primers${separator}${sanitizePrimerArtifactStem(name)}${PRIMER_ARTIFACT_EXTENSION}`;
}

export function primerArtifactPathInDir(dir: string, name: string): string {
  const separator = dir.includes('\\') ? '\\' : '/';
  const root = dir.replace(/[\\/]+$/, '');
  return `${root}${separator}${sanitizePrimerArtifactStem(name)}${PRIMER_ARTIFACT_EXTENSION}`;
}

export function primerArtifactPathBesideTarget(targetFilePath: string, name: string): string {
  const separator = targetFilePath.includes('\\') ? '\\' : '/';
  const idx = Math.max(targetFilePath.lastIndexOf('/'), targetFilePath.lastIndexOf('\\'));
  const dir = idx > 0 ? targetFilePath.slice(0, idx) : targetFilePath.replace(/[\\/]+$/, '');
  return `${dir}${separator}${sanitizePrimerArtifactStem(name)}${PRIMER_ARTIFACT_EXTENSION}`;
}

export function normalizePrimerArtifactPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.toLowerCase().endsWith(PRIMER_ARTIFACT_EXTENSION)) return trimmed;
  const withoutJson = trimmed.replace(/\.json$/i, '');
  return `${withoutJson}${PRIMER_ARTIFACT_EXTENSION}`;
}

export function validatePrimerArtifactPath(
  artifactPath: string,
  workspaceRoot: string
): PrimerArtifactPathValidation {
  const normalized = normalizePrimerArtifactPath(artifactPath);
  const relativePath = pathRelativeToBoundary(normalized, workspaceRoot);
  if (
    relativePath == null ||
    relativePath.length === 0 ||
    !isSafeWorkspaceRelativePath(relativePath)
  ) {
    return {
      valid: false,
      error: 'Primer files must be saved inside the owning workspace.',
    };
  }
  return { valid: true, relativePath };
}

function assertValidPrimerArtifactBinding(
  binding: NonNullable<PrimerArtifactBuildInput['binding']>,
  workspaceRoot: string
): void {
  if (!binding.targetDocumentId.trim()) {
    throw new Error('The primer target requires a stable sequence document identity.');
  }
  const targetRelativePath = pathRelativeToBoundary(binding.targetFilePath, workspaceRoot);
  if (
    targetRelativePath == null ||
    targetRelativePath.length === 0 ||
    !isSafeWorkspaceRelativePath(targetRelativePath)
  ) {
    throw new Error('The primer target sequence must be inside the owning workspace.');
  }
  if (!Number.isInteger(binding.targetLength) || binding.targetLength < 1) {
    throw new Error('The target sequence length must be a positive integer.');
  }
  if (binding.targetTopology !== 'linear' && binding.targetTopology !== 'circular') {
    throw new Error('The target sequence topology must be linear or circular.');
  }
  if (!binding.targetFileContentHash || !binding.targetNormalizedSequenceHash) {
    throw new Error('Target file and sequence hashes are required.');
  }
  if (!Number.isInteger(binding.start) || !Number.isInteger(binding.end)) {
    throw new Error('Primer binding coordinates must be integers.');
  }
  if (binding.start < 0 || binding.end < 0) {
    throw new Error('Primer binding coordinates cannot be negative.');
  }
  if (binding.start >= binding.targetLength || binding.end > binding.targetLength) {
    throw new Error('Primer binding coordinates exceed the target sequence.');
  }
  if (
    (binding.targetTopology === 'linear' && binding.end <= binding.start) ||
    (binding.targetTopology === 'circular' && binding.end === binding.start)
  ) {
    throw new Error('Primer binding coordinates must span at least one base.');
  }
  if (binding.strand !== 1 && binding.strand !== -1) {
    throw new Error('Primer binding strand must be 1 or -1.');
  }
}

export async function buildPrimerArtifact(
  input: PrimerArtifactBuildInput
): Promise<PrimerArtifactV1> {
  if (!input.id || !input.catalogNumber || !input.name.trim()) {
    throw new Error('Primer identity, catalog number, and name are required.');
  }
  const orderType = input.oligo?.orderType ?? 'dna';
  const validation = validatePrimerSequence(input.sequence, { orderType });
  if (!validation.valid) {
    throw new Error('Invalid primer sequence for artifact.');
  }
  const sequence = validation.trimmed ?? input.sequence.trim();
  const oligo = input.oligo ? cloneAndValidatePrimerOligo(input.oligo, sequence) : undefined;
  const artifactPath = normalizePrimerArtifactPath(input.artifactPath);
  const artifactPathValidation = validatePrimerArtifactPath(artifactPath, input.workspaceRoot);
  if (!artifactPathValidation.valid) throw new Error(artifactPathValidation.error);
  let binding: PrimerArtifactBindingV1 | null = null;
  if (input.binding) {
    assertValidPrimerArtifactBinding(input.binding, input.workspaceRoot);
    binding = {
      id: input.binding.id,
      relation: 'binds_to_sequence',
      target: {
        documentId: input.binding.targetDocumentId,
        topology: input.binding.targetTopology,
        length: input.binding.targetLength,
        fileContentHash: input.binding.targetFileContentHash,
        normalizedSequenceHash: input.binding.targetNormalizedSequenceHash,
      },
      coordinates: {
        system: 'zero_based_half_open',
        start: input.binding.start,
        end: input.binding.end,
        strand: input.binding.strand,
      },

      source: input.source === 'assembly' ? 'manual' : (input.source ?? 'drag-selection'),
    };
  }
  const now = input.now ?? Date.now();
  const timestamp = new Date(now).toISOString();
  const source = input.source ?? 'drag-selection';
  const entitySchema = clonePrimerSchemaSnapshot(
    input.entitySchema ?? createBuiltinPrimerSchemaSnapshot(orderType)
  );
  const { fields: entityFields, notes } = resolvePrimerArtifactMetadata(entitySchema, input);

  if (input.tmCalculation && !isValidTmCalculation(input.tmCalculation)) {
    throw new Error('Primer artifact Tm provenance is invalid.');
  }
  if (orderType === 'rna' && input.tmCalculation) {
    throw new Error('RNA oligo orders cannot use a DNA primer Tm calculation.');
  }
  if (orderType === 'rna' && binding) {
    throw new Error('RNA oligo orders cannot use DNA-template primer bindings.');
  }

  assertPrimerAnnealingSegment(input.annealing, sequence);
  const artifact: PrimerArtifactV1 = {
    schema: PRIMER_ARTIFACT_SCHEMA,
    schemaVersion: PRIMER_ARTIFACT_SCHEMA_VERSION,
    artifactRevision: 1,
    id: input.id,
    name: input.name,
    catalogNumber: input.catalogNumber,
    sequence: {
      bases: sequence,
      topology: 'linear',
      length: sequence.length,
      contentHash: await sha256Hex(sequence),
    },
    ...(oligo ? { oligo } : {}),
    ...(input.annealing ? { annealing: { ...input.annealing } } : {}),
    ...(input.inventory ? { inventory: input.inventory } : {}),
    computed: {
      tmC:
        orderType === 'rna'
          ? null
          : (input.tmCalculation?.valueC ??
            estimateLegacyPrimerTm(input.annealing?.pbsSequence ?? sequence)),
      gcPercent: calculateGcContent(sequence),
      ...(input.tmCalculation ? { tmCalculation: input.tmCalculation } : {}),
    },
    metadata: {
      createdAt: timestamp,
      updatedAt: timestamp,
      actor: input.actor ?? 'local-user',
      source,
      application: input.application ?? null,
      notes,
    },
    registry: {
      required: true,
      entityId: input.id,
      kind: entitySchema.name,
      use: 'primer',
    },
    entity: {
      schema: entitySchema,
      fields: entityFields,
    },
    file: {
      workspaceRelativePath: artifactPathValidation.relativePath,
    },
    bindings: binding ? [binding] : [],
    ...(input.designProvenance ? { designProvenance: input.designProvenance } : {}),
  };
  return parsePrimerArtifact(serializePrimerArtifact(artifact));
}

export function serializePrimerArtifact(artifact: PrimerArtifactV1): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function parsePrimerArtifactJson(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Primer artifact is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.schema !== PRIMER_ARTIFACT_SCHEMA) {
    throw new Error(`Primer artifact schema must be ${PRIMER_ARTIFACT_SCHEMA}.`);
  }
  const isLegacyV1 = parsed.schemaVersion === 1;
  if (
    !isLegacyV1 &&
    parsed.schemaVersion !== 2 &&
    parsed.schemaVersion !== PRIMER_ARTIFACT_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported primer artifact schema version: ${String(parsed.schemaVersion)}.`);
  }
  if (
    parsed.schemaVersion !== 3 &&
    (parsed.recovery !== undefined ||
      parsed.registryRelationships !== undefined ||
      parsed.inventory !== undefined ||
      (isRecord(parsed.entity) &&
        (parsed.entity.state !== undefined || parsed.entity.otherFields !== undefined)))
  ) {
    throw new Error('Saved entity state and recovery evidence require primer artifact version 3.');
  }
  return parsed;
}

function primerOrderType(parsed: Record<string, unknown>): OligoOrderType {
  return isRecord(parsed.oligo) && parsed.oligo.orderType === 'rna' ? 'rna' : 'dna';
}

function requirePrimerIdentity(parsed: Record<string, unknown>): void {
  if (
    typeof parsed.artifactRevision !== 'number' ||
    !Number.isInteger(parsed.artifactRevision) ||
    parsed.artifactRevision < 1 ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    typeof parsed.catalogNumber !== 'string' ||
    !parsed.catalogNumber
  ) {
    throw new Error('Primer artifact identity or revision is invalid.');
  }
}

function requirePrimerName(parsed: Record<string, unknown>): void {
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    throw new Error('Primer artifact name and catalog number are required.');
  }
}

function requirePrimerSequence(
  parsed: Record<string, unknown>,
  orderType: OligoOrderType
): Record<string, unknown> {
  if (
    !isRecord(parsed.sequence) ||
    typeof parsed.sequence.bases !== 'string' ||
    parsed.sequence.topology !== 'linear' ||
    typeof parsed.sequence.length !== 'number' ||
    typeof parsed.sequence.contentHash !== 'string'
  ) {
    throw new Error('Primer artifact sequence is required.');
  }
  const validation = validatePrimerSequence(parsed.sequence.bases, { orderType });
  if (
    !validation.valid ||
    parsed.sequence.bases !== validation.trimmed ||
    !Number.isInteger(parsed.sequence.length) ||
    parsed.sequence.length !== parsed.sequence.bases.length ||
    !parsed.sequence.contentHash
  ) {
    throw new Error('Primer artifact sequence is invalid.');
  }
  return parsed.sequence;
}

function maybeValidateOligo(parsed: Record<string, unknown>, bases: string): void {
  if (parsed.oligo !== undefined) {
    cloneAndValidatePrimerOligo(parsed.oligo as PrimerOligoCompositionV1, bases, false);
  }
}

function requirePrimerComputed(
  parsed: Record<string, unknown>,
  sequence: Record<string, unknown>,
  orderType: OligoOrderType
): void {
  if (
    !isRecord(parsed.computed) ||
    (orderType === 'rna'
      ? parsed.computed.tmC !== null
      : typeof parsed.computed.tmC !== 'number' || !Number.isFinite(parsed.computed.tmC)) ||
    typeof parsed.computed.gcPercent !== 'number' ||
    !Number.isFinite(parsed.computed.gcPercent)
  ) {
    throw new Error('Primer artifact computed metadata is invalid.');
  }
  const tmCalculation = parsed.computed.tmCalculation;
  if (!isValidTmCalculation(tmCalculation)) {
    throw new Error('Primer artifact Tm provenance is invalid.');
  }
  if (orderType === 'rna' && tmCalculation !== undefined) {
    throw new Error('RNA oligo artifacts cannot contain a DNA primer Tm calculation.');
  }
  const expectedTm =
    orderType === 'rna'
      ? null
      : isRecord(tmCalculation)
        ? (tmCalculation.valueC as number)
        : estimateLegacyPrimerTm(
            isRecord(parsed.annealing)
              ? (parsed.annealing.pbsSequence as string)
              : (sequence.bases as string)
          );
  const expectedGc = calculateGcContent(sequence.bases as string);
  if (
    (expectedTm !== null &&
      typeof parsed.computed.tmC === 'number' &&
      Math.abs(parsed.computed.tmC - expectedTm) > 1e-9) ||
    Math.abs(parsed.computed.gcPercent - expectedGc) > 1e-9
  ) {
    throw new Error(
      'Primer artifact computed metadata does not match its sequence or recorded provenance.'
    );
  }
}

function requirePrimerMetadata(parsed: Record<string, unknown>): Record<string, unknown> {
  if (
    !isRecord(parsed.metadata) ||
    typeof parsed.metadata.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.metadata.createdAt)) ||
    typeof parsed.metadata.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.metadata.updatedAt)) ||
    typeof parsed.metadata.actor !== 'string' ||
    typeof parsed.metadata.source !== 'string'
  ) {
    throw new Error('Primer artifact metadata is invalid.');
  }

  if (
    parsed.metadata.source !== 'drag-selection' &&
    parsed.metadata.source !== 'manual' &&
    parsed.metadata.source !== 'reconciled' &&
    parsed.metadata.source !== 'assembly' &&
    parsed.metadata.source !== 'agent-design'
  ) {
    parsed.metadata.source = 'manual';
  }
  return parsed.metadata;
}

function requirePrimerRegistry(parsed: Record<string, unknown>): Record<string, unknown> {
  if (
    !isRecord(parsed.registry) ||
    parsed.registry.required !== true ||
    parsed.registry.entityId !== parsed.id ||
    typeof parsed.registry.kind !== 'string' ||
    !parsed.registry.kind ||
    parsed.registry.use !== 'primer'
  ) {
    throw new Error('Primer artifact must require registry projection.');
  }
  return parsed.registry;
}

function requirePrimerEntity(
  parsed: Record<string, unknown>,
  registry: Record<string, unknown>
): void {
  if (parsed.entity !== undefined) {
    if (
      !isRecord(parsed.entity) ||
      !isPortableEntitySchemaRevisionSnapshot(parsed.entity.schema, 'primer') ||
      !isRecord(parsed.entity.fields) ||
      registry.kind !== parsed.entity.schema.name
    ) {
      throw new Error('Primer artifact entity schema binding is invalid.');
    }
    assertPrimerEntityMetadata(
      parsed.entity.schema as PrimerEntitySchemaSnapshot,
      parsed.entity.fields
    );
    if (parsed.entity.otherFields !== undefined) {
      if (!isRecord(parsed.entity.otherFields))
        throw new Error('Primer retained fields are invalid.');
      const defined = new Set(parsed.entity.schema.fields.map((field) => field.key));
      for (const [key, value] of Object.entries(parsed.entity.otherFields)) {
        if (defined.has(key) || PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(key))
          throw new Error('Primer retained fields cannot replace schema or managed fields.');
        assertJsonSafePrimerField(value, key);
      }
    }
    if (parsed.entity.state !== undefined) {
      const state = parsed.entity.state;
      if (
        !isRecord(state) ||
        !['tracked', 'registered', 'drifted', 'unresolved'].includes(
          String(state.registrationStatus)
        ) ||
        (state.domainStatus !== null && typeof state.domainStatus !== 'string') ||
        typeof state.archived !== 'boolean' ||
        (state.archivedAt !== null &&
          (typeof state.archivedAt !== 'number' || !Number.isFinite(state.archivedAt))) ||
        (state.status !== undefined && state.status !== null && typeof state.status !== 'string') ||
        (state.source !== undefined && state.source !== null && typeof state.source !== 'string')
      )
        throw new Error('Primer saved entity state is invalid.');
    }
    return;
  }
  if (registry.kind !== 'oligo') {
    throw new Error('Legacy primer artifacts must use the built-in oligo Registry kind.');
  }
}

function requirePrimerFile(parsed: Record<string, unknown>): void {
  if (
    !isRecord(parsed.file) ||
    typeof parsed.file.workspaceRelativePath !== 'string' ||
    !isSafeWorkspaceRelativePath(parsed.file.workspaceRelativePath)
  ) {
    throw new Error('Primer artifact file path must be workspace-relative.');
  }
}

function migrateLegacyBindingPath(binding: Record<string, unknown>): void {
  if (!isRecord(binding.target)) return;
  const legacyPath = binding.target.workspaceRelativePath;
  if (typeof legacyPath === 'string' && isSafeWorkspaceRelativePath(legacyPath)) {
    binding.target.legacyWorkspaceRelativePath = legacyPath;
    binding.target.documentId = '';
    delete binding.target.workspaceRelativePath;
  }
}

const INVALID_PRIMER_BINDING = 'Primer artifact contains an invalid sequence binding relationship.';

function rejectInvalidBinding(): never {
  throw new Error(INVALID_PRIMER_BINDING);
}

function assertBindingIdentity(binding: Record<string, unknown>): void {
  if (binding.relation !== 'binds_to_sequence' || typeof binding.id !== 'string' || !binding.id) {
    rejectInvalidBinding();
  }
  if (
    binding.source !== 'drag-selection' &&
    binding.source !== 'manual' &&
    binding.source !== 'reconciled' &&
    binding.source !== 'agent-design'
  ) {
    rejectInvalidBinding();
  }
  if (!isValidBindingAlignment(binding.alignment)) {
    rejectInvalidBinding();
  }
}

function assertBindingTarget(target: unknown): asserts target is Record<string, unknown> {
  if (!isRecord(target)) rejectInvalidBinding();
  if (typeof target.documentId !== 'string') rejectInvalidBinding();
  if (
    target.projectId !== undefined &&
    (typeof target.projectId !== 'string' || !target.projectId.trim())
  )
    rejectInvalidBinding();
  if (
    !target.documentId &&
    (typeof target.legacyWorkspaceRelativePath !== 'string' ||
      !isSafeWorkspaceRelativePath(target.legacyWorkspaceRelativePath))
  ) {
    rejectInvalidBinding();
  }
  if (target.topology !== 'linear' && target.topology !== 'circular') rejectInvalidBinding();
  if (typeof target.length !== 'number' || !Number.isInteger(target.length) || target.length < 1) {
    rejectInvalidBinding();
  }
  if (typeof target.fileContentHash !== 'string' || !target.fileContentHash) {
    rejectInvalidBinding();
  }
  if (typeof target.normalizedSequenceHash !== 'string' || !target.normalizedSequenceHash) {
    rejectInvalidBinding();
  }
}

function assertBindingCoordinates(coordinates: unknown, target: Record<string, unknown>): void {
  if (!isRecord(coordinates)) rejectInvalidBinding();
  if (coordinates.system !== 'zero_based_half_open') rejectInvalidBinding();
  if (typeof coordinates.start !== 'number' || !Number.isInteger(coordinates.start)) {
    rejectInvalidBinding();
  }
  if (typeof coordinates.end !== 'number' || !Number.isInteger(coordinates.end)) {
    rejectInvalidBinding();
  }
  const length = target.length;
  if (typeof length !== 'number') rejectInvalidBinding();
  if (coordinates.start < 0 || coordinates.start >= length) rejectInvalidBinding();
  if (coordinates.end < 0 || coordinates.end > length) rejectInvalidBinding();
  if (coordinates.strand !== 1 && coordinates.strand !== -1) rejectInvalidBinding();
  if (target.topology === 'linear' && coordinates.end <= coordinates.start) {
    rejectInvalidBinding();
  }
  if (target.topology === 'circular' && coordinates.end === coordinates.start) {
    rejectInvalidBinding();
  }
}

function assertValidPrimerBinding(binding: unknown): asserts binding is Record<string, unknown> {
  if (!isRecord(binding)) rejectInvalidBinding();
  assertBindingIdentity(binding);
  assertBindingTarget(binding.target);
  assertBindingCoordinates(binding.coordinates, binding.target);
}

function parsePrimerBindings(parsed: Record<string, unknown>, isLegacyV1: boolean): unknown[] {
  if (!Array.isArray(parsed.bindings)) {
    throw new Error('Primer artifact bindings must be an array.');
  }
  const bindingIds = new Set<string>();
  for (const binding of parsed.bindings) {
    if (isRecord(binding) && isLegacyV1) {
      migrateLegacyBindingPath(binding);
    }
    assertValidPrimerBinding(binding);
    if (bindingIds.has(binding.id as string)) {
      throw new Error('Primer artifact contains duplicate binding identities.');
    }
    bindingIds.add(binding.id as string);
  }
  return parsed.bindings;
}

function migrateLegacyDesignProvenancePath(
  parsed: Record<string, unknown>,
  isLegacyV1: boolean
): void {
  if (isLegacyV1 && isRecord(parsed.designProvenance) && isRecord(parsed.designProvenance.target)) {
    const legacyPath = parsed.designProvenance.target.workspaceRelativePath;
    if (typeof legacyPath === 'string' && isSafeWorkspaceRelativePath(legacyPath)) {
      parsed.designProvenance.target.legacyWorkspaceRelativePath = legacyPath;
      parsed.designProvenance.target.documentId = '';
      delete parsed.designProvenance.target.workspaceRelativePath;
    }
  }
}

function requirePrimerDesignProvenance(
  parsed: Record<string, unknown>,
  metadata: Record<string, unknown>,
  sequence: Record<string, unknown>,
  bindings: unknown[]
): void {
  if (!isValidDesignProvenance(parsed.designProvenance)) {
    throw new Error('Primer artifact design provenance is invalid.');
  }
  const designProvenance = parsed.designProvenance as PrimerDesignProvenanceV1 | undefined;
  if (
    (metadata.source === 'agent-design') !== (designProvenance !== undefined) ||
    (designProvenance !== undefined &&
      sequence.bases !== `${designProvenance.overhangSequence}${designProvenance.pbsSequence}`)
  ) {
    throw new Error('Primer artifact design provenance does not match its sequence or source.');
  }
  if (!designProvenance) return;
  if (
    !isRecord(parsed.computed) ||
    stableJson(designProvenance.tm) !== stableJson(parsed.computed.tmCalculation)
  ) {
    throw new Error('Primer artifact design Tm provenance does not match its computed Tm.');
  }
  for (const binding of bindings) {
    if (
      isRecord(binding) &&
      binding.source === 'agent-design' &&
      !isValidBindingAlignmentForPrimer(binding.alignment, designProvenance.pbsSequence.length)
    ) {
      throw new Error('Primer artifact contains an invalid sequence binding relationship.');
    }
  }
}

function requirePrimerInventory(parsed: Record<string, unknown>): void {
  if (parsed.inventory !== undefined) {
    const inventory = parsed.inventory;
    if (
      !isRecord(inventory) ||
      typeof inventory.origin !== 'string' ||
      (inventory.originDetails !== null && !isRecord(inventory.originDetails)) ||
      ['vendor', 'scale', 'purification', 'modifications', 'stockLocation'].some(
        (key) => inventory[key] !== null && typeof inventory[key] !== 'string'
      ) ||
      ['orderDate', 'concentration'].some(
        (key) =>
          inventory[key] !== null &&
          (typeof inventory[key] !== 'number' || !Number.isFinite(inventory[key]))
      )
    )
      throw new Error('Primer inventory is invalid.');
    assertJsonSafePrimerField(inventory, 'inventory');
  }
}

function requirePrimerRecovery(parsed: Record<string, unknown>): void {
  if (parsed.recovery !== undefined) {
    const recovery = parsed.recovery;
    if (
      !isRecord(recovery) ||
      recovery.schema !== 'dnaforge.primer-recovery/v1' ||
      !['registry', 'legacy'].includes(String(recovery.source)) ||
      typeof recovery.sourceFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(recovery.sourceFingerprint) ||
      (recovery.legacyFingerprint !== undefined &&
        (typeof recovery.legacyFingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(recovery.legacyFingerprint))) ||
      (recovery.relationshipsFingerprint !== undefined &&
        (typeof recovery.relationshipsFingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(recovery.relationshipsFingerprint))) ||
      (recovery.sourceActor !== undefined &&
        recovery.sourceActor !== null &&
        typeof recovery.sourceActor !== 'string')
    )
      throw new Error('Primer recovery identity evidence is invalid.');
    assertJsonSafePrimerField(recovery, 'recovery');
  }
}

function requirePrimerBindingHistory(parsed: Record<string, unknown>, bindings: unknown[]): void {
  for (const binding of bindings) {
    if (isRecord(binding) && binding.history !== undefined) {
      const history = binding.history;
      if (
        parsed.schemaVersion !== 3 ||
        !isRecord(history) ||
        typeof history.createdAt !== 'number' ||
        !Number.isFinite(history.createdAt) ||
        typeof history.updatedAt !== 'number' ||
        !Number.isFinite(history.updatedAt) ||
        typeof history.source !== 'string'
      )
        throw new Error('Primer binding history is invalid.');
    }
  }
}

export function parsePrimerArtifact(content: string): PrimerArtifactV1 {
  const parsed = parsePrimerArtifactJson(content);
  const isLegacyV1 = parsed.schemaVersion === 1;
  const orderType = primerOrderType(parsed);
  requirePrimerIdentity(parsed);
  requirePrimerName(parsed);
  const sequence = requirePrimerSequence(parsed, orderType);
  maybeValidateOligo(parsed, sequence.bases as string);
  assertPrimerAnnealingSegment(parsed.annealing, sequence.bases as string);
  requirePrimerComputed(parsed, sequence, orderType);
  const metadata = requirePrimerMetadata(parsed);
  const registry = requirePrimerRegistry(parsed);
  requirePrimerEntity(parsed, registry);
  requirePrimerInventory(parsed);
  requirePrimerRecovery(parsed);
  requirePrimerFile(parsed);
  if (parsed.registryRelationships !== undefined) {
    parsePrimerRegistryRelationships(parsed.registryRelationships, String(parsed.id));
    assertJsonSafePrimerField(parsed.registryRelationships, 'registryRelationships');
  }
  const bindings = parsePrimerBindings(parsed, isLegacyV1);
  requirePrimerBindingHistory(parsed, bindings);
  migrateLegacyDesignProvenancePath(parsed, isLegacyV1);
  requirePrimerDesignProvenance(parsed, metadata, sequence, bindings);
  if (isLegacyV1) parsed.schemaVersion = 2;
  return parsed as unknown as PrimerArtifactV1;
}

function clonePrimerSchemaSnapshot(schema: PrimerEntitySchemaSnapshot): PrimerEntitySchemaSnapshot {
  return {
    ...schema,
    fields: schema.fields.map((field) => ({
      ...field,
      ...(field.enumOptions ? { enumOptions: [...field.enumOptions] } : {}),
    })),
  };
}

function assertPrimerEntityMetadata(
  schema: PrimerEntitySchemaSnapshot,
  fields: Record<string, unknown>
): void {
  if (!isPortableEntitySchemaRevisionSnapshot(schema, 'primer')) {
    throw new Error('Primer artifact entity schema binding is invalid.');
  }
  if (!Number.isInteger(schema.version) || schema.version < 1) {
    throw new Error('Primer artifact entity schema version is invalid.');
  }
  const definitions = new Map(schema.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(fields)) {
    if (!definitions.has(key) || PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(key)) {
      throw new Error(`Primer artifact field ${key} is not editable in schema ${schema.name}.`);
    }
    assertJsonSafePrimerField(fields[key], key);
  }
  const editableDefinitions = schema.fields.filter(
    (field) => !PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(field.key)
  );
  for (const field of editableDefinitions) {
    const value = fields[field.key];
    if (
      field.required &&
      (value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim().length === 0))
    ) {
      throw new Error(`Primer artifact is missing required schema field ${field.label}.`);
    }
  }
  const supportedDefinitions = editableDefinitions.filter(
    (field): field is typeof field & LimsFieldDefinition => isLimsFieldType(field.type)
  );
  const validationErrors = validateLimsEntityFields(schema.name, fields, supportedDefinitions);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid primer schema fields: ${validationErrors.join('; ')}`);
  }
}

function assertJsonSafePrimerField(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafePrimerField(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafePrimerField(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`Primer artifact field ${path} is not JSON-safe.`);
}

export function addPrimerArtifactBinding(
  artifact: PrimerArtifactV1,
  binding: PrimerArtifactBindingV1,
  now = Date.now()
): PrimerArtifactV1 {
  assertAgentDesignBindingAlignment(artifact, binding);
  if (artifact.bindings.some((existing) => existing.id === binding.id)) {
    throw new Error(`Primer binding ${binding.id} already exists in the artifact.`);
  }
  return revisePrimerArtifact(artifact, [...artifact.bindings, binding], now);
}

export function removePrimerArtifactBinding(
  artifact: PrimerArtifactV1,
  bindingId: string,
  now = Date.now()
): PrimerArtifactV1 {
  const bindings = artifact.bindings.filter((binding) => binding.id !== bindingId);
  if (bindings.length === artifact.bindings.length) {
    throw new Error(`Primer binding ${bindingId} does not exist in the artifact.`);
  }
  return revisePrimerArtifact(artifact, bindings, now);
}

export function replaceOwnedPrimerArtifactBindings(
  artifact: PrimerArtifactV1,
  ownedIds: ReadonlySet<string>,
  bindings: PrimerArtifactBindingV1[],
  now = Date.now()
): PrimerArtifactV1 {
  for (const binding of bindings) {
    if (!ownedIds.has(binding.id)) throw new Error('A copied binding has no ownership intent.');
    assertAgentDesignBindingAlignment(artifact, binding);
  }
  return revisePrimerArtifact(
    artifact,
    [...artifact.bindings.filter((binding) => !ownedIds.has(binding.id)), ...bindings],
    now
  );
}

export function updatePrimerArtifactBinding(
  artifact: PrimerArtifactV1,
  bindingId: string,
  replacement: PrimerArtifactBindingV1,
  now = Date.now()
): PrimerArtifactV1 {
  assertAgentDesignBindingAlignment(artifact, replacement);
  if (replacement.id !== bindingId) {
    throw new Error('A primer binding update must preserve the binding identity.');
  }
  const index = artifact.bindings.findIndex((binding) => binding.id === bindingId);
  if (index < 0) {
    throw new Error(`Primer binding ${bindingId} does not exist in the artifact.`);
  }
  const bindings = [...artifact.bindings];
  bindings[index] = replacement;
  return revisePrimerArtifact(artifact, bindings, now);
}

export interface PrimerArtifactContentRevisionInput {
  name: string;
  sequence: string;

  oligo?: PrimerOligoCompositionV1 | null;
  annealing?: PrimerAnnealingSegment | null;
  notes?: string | null;
  application?: PrimerApplication | null;
  inventory?: PrimerArtifactV1['inventory'];
  entityState?: NonNullable<PrimerArtifactV1['entity']>['state'];
  actor?: string;
  entitySchema?: PrimerEntitySchemaSnapshot;
  entityFields?: Record<string, unknown>;
  tmCalculation?: PrimerTmCalculationV1;
}

export async function revisePrimerArtifactContent(
  artifact: PrimerArtifactV1,
  input: PrimerArtifactContentRevisionInput,
  now = Date.now()
): Promise<PrimerArtifactV1> {
  if (!input.name.trim()) throw new Error('Primer name is required.');
  const requestedOligo = Object.prototype.hasOwnProperty.call(input, 'oligo')
    ? input.oligo
    : artifact.oligo;
  const orderType = requestedOligo?.orderType ?? 'dna';
  const existingOrderType = artifact.oligo?.orderType ?? 'dna';
  if (orderType !== existingOrderType) {
    throw new Error('An existing oligo entity type cannot change between DNA and RNA.');
  }
  const validation = validatePrimerSequence(input.sequence, { orderType });
  if (!validation.valid) throw new Error('Invalid primer sequence for artifact.');
  const sequence = validation.trimmed ?? input.sequence.trim();
  const oligo = requestedOligo ? cloneAndValidatePrimerOligo(requestedOligo, sequence) : undefined;
  const annealing =
    input.annealing === undefined
      ? sequence === artifact.sequence.bases
        ? artifact.annealing
        : undefined
      : (input.annealing ?? undefined);
  assertPrimerAnnealingSegment(annealing, sequence);
  const schema = clonePrimerSchemaSnapshot(
    input.entitySchema ?? artifact.entity?.schema ?? createBuiltinPrimerSchemaSnapshot()
  );
  const { fields, notes } = resolvePrimerArtifactMetadata(schema, input, artifact);
  if (input.tmCalculation && !isValidTmCalculation(input.tmCalculation)) {
    throw new Error('Primer artifact Tm provenance is invalid.');
  }
  if (orderType === 'rna' && input.tmCalculation) {
    throw new Error('RNA oligo orders cannot use a DNA primer Tm calculation.');
  }
  if (orderType === 'rna' && artifact.bindings.length > 0) {
    throw new Error('RNA oligo orders cannot use DNA-template primer bindings.');
  }

  const scientificContentChanged =
    sequence !== artifact.sequence.bases ||
    stableJson(oligo) !== stableJson(artifact.oligo) ||
    stableJson(annealing) !== stableJson(artifact.annealing);
  const timestamp = new Date(now).toISOString();
  const tmCalculation = scientificContentChanged
    ? orderType === 'rna'
      ? undefined
      : input.tmCalculation
    : artifact.computed.tmCalculation;
  const revised: PrimerArtifactV1 = {
    ...artifact,
    schemaVersion: PRIMER_ARTIFACT_SCHEMA_VERSION,
    artifactRevision: artifact.artifactRevision + 1,
    name: input.name.trim(),
    sequence: {
      ...artifact.sequence,
      bases: sequence,
      topology: 'linear',
      length: sequence.length,
      contentHash: await sha256Hex(sequence),
    },
    ...(oligo ? { oligo } : {}),
    computed: {
      ...artifact.computed,
      tmC:
        orderType === 'rna'
          ? null
          : (tmCalculation?.valueC ?? estimateLegacyPrimerTm(annealing?.pbsSequence ?? sequence)),
      gcPercent: calculateGcContent(sequence),
      tmCalculation,
    },
    metadata: {
      ...artifact.metadata,
      updatedAt: timestamp,
      actor: input.actor ?? 'local-user',
      source: scientificContentChanged ? 'manual' : artifact.metadata.source,
      notes,
      application:
        input.application === undefined ? artifact.metadata.application : input.application,
    },
    registry: {
      ...artifact.registry,
      kind: schema.name,
    },
    entity: {
      ...artifact.entity,
      schema,
      fields,
      ...(input.entityState ? { state: input.entityState } : {}),
    },
    ...(input.inventory ? { inventory: input.inventory } : {}),
    bindings: scientificContentChanged
      ? artifact.bindings.map(({ alignment: _alignment, ...binding }) => binding)
      : artifact.bindings.map((binding) => ({ ...binding })),
  };
  if (!oligo) delete revised.oligo;
  if (annealing) revised.annealing = { ...annealing };
  else delete revised.annealing;
  if (scientificContentChanged) delete revised.designProvenance;
  return parsePrimerArtifact(serializePrimerArtifact(revised));
}

function assertPrimerAnnealingSegment(value: unknown, sequence: string): void {
  if (value === undefined) return;
  if (
    !isRecord(value) ||
    typeof value.pbsSequence !== 'string' ||
    !value.pbsSequence.length ||
    typeof value.overhangSequence !== 'string' ||
    (value.overhangSequence + value.pbsSequence).toUpperCase() !== sequence.toUpperCase()
  )
    throw new Error(
      'The primer annealing and tail segments must reconstruct its exact natural-base sequence.'
    );
}

function assertAgentDesignBindingAlignment(
  artifact: PrimerArtifactV1,
  binding: PrimerArtifactBindingV1
): void {
  if (
    artifact.designProvenance &&
    binding.source === 'agent-design' &&
    !isValidBindingAlignmentForPrimer(
      binding.alignment,
      artifact.designProvenance.pbsSequence.length
    )
  ) {
    throw new Error('An agent-designed primer binding requires valid alignment evidence.');
  }
}

function revisePrimerArtifact(
  artifact: PrimerArtifactV1,
  bindings: PrimerArtifactBindingV1[],
  now: number
): PrimerArtifactV1 {
  return {
    ...artifact,
    schemaVersion: PRIMER_ARTIFACT_SCHEMA_VERSION,
    artifactRevision: artifact.artifactRevision + 1,
    metadata: {
      ...artifact.metadata,
      updatedAt: new Date(now).toISOString(),
    },
    bindings,
  };
}

function cloneAndValidatePrimerOligo(
  value: PrimerOligoCompositionV1,
  sequence: string,
  enforceVendorConstraints = true
): PrimerOligoCompositionV1 {
  if (
    !isRecord(value) ||
    typeof value.vendor !== 'string' ||
    !value.vendor.trim() ||
    typeof value.notation !== 'string' ||
    !value.notation ||
    !Array.isArray(value.modifications)
  ) {
    throw new Error('Primer oligo composition is invalid.');
  }
  const modifications = value.modifications.map((modification) =>
    cloneAndValidateAppliedModification(modification, sequence)
  );
  const composition: PrimerOligoCompositionV1 = {
    vendor: value.vendor,
    ...(value.orderType === 'rna' ? { orderType: value.orderType } : {}),
    notation: value.notation,
    modifications,
  };
  if (value.orderType !== undefined && value.orderType !== 'dna' && value.orderType !== 'rna') {
    throw new Error('Primer oligo order type is invalid.');
  }
  if (value.vendor === 'idt') {
    const parsed = parseIdtOligoNotation(value.notation, {
      orderType: value.orderType ?? 'dna',
      enforceVendorConstraints,
      enforceOrderTypeAvailability: enforceVendorConstraints,
    });
    if (parsed.errors.length > 0) {
      throw new Error(`IDT oligo notation is invalid: ${parsed.errors[0]}`);
    }
    if (parsed.bases.toUpperCase() !== sequence.toUpperCase()) {
      throw new Error('IDT oligo notation does not match the natural primer sequence.');
    }
    if (stableJson(parsed.composition?.modifications) !== stableJson(modifications)) {
      throw new Error('IDT oligo notation does not match its modification anchors.');
    }
  }
  return composition;
}

const APPLIED_OLIGO_PLACEMENTS = new Set(['five-prime', 'internal', 'three-prime']);
const APPLIED_OLIGO_BEHAVIORS = new Set([
  'terminal-attachment',
  'between-bases',
  'modified-base',
  'linkage',
]);
const APPLIED_OLIGO_NATURAL_BASES = new Set(['A', 'C', 'G', 'T', 'U', 'N']);

function isValidAppliedModificationIdentity(value: AppliedOligoModificationV1): boolean {
  return (
    isRecord(value) &&
    typeof value.chemistryId === 'string' &&
    Boolean(value.chemistryId) &&
    typeof value.vendor === 'string' &&
    Boolean(value.vendor) &&
    typeof value.vendorCode === 'string' &&
    Boolean(value.vendorCode) &&
    APPLIED_OLIGO_PLACEMENTS.has(value.placement) &&
    APPLIED_OLIGO_BEHAVIORS.has(value.behavior) &&
    isRecord(value.anchor)
  );
}

function isValidAppliedModificationNaturalBase(
  naturalBase: AppliedOligoModificationV1['naturalBase']
): boolean {
  return naturalBase === undefined || APPLIED_OLIGO_NATURAL_BASES.has(naturalBase);
}

function cloneValidatedModificationAnchor(
  value: AppliedOligoModificationV1,
  sequence: string
): AppliedOligoModificationV1['anchor'] {
  if (value.anchor.kind === 'terminus') {
    if (
      (value.anchor.end !== 'five-prime' && value.anchor.end !== 'three-prime') ||
      value.behavior !== 'terminal-attachment' ||
      value.anchor.end !== value.placement
    ) {
      throw new Error('Primer oligo modification terminus is invalid.');
    }
    return { kind: 'terminus', end: value.anchor.end };
  }
  if (value.anchor.kind === 'between-bases') {
    if (
      typeof value.anchor.offset !== 'number' ||
      !Number.isInteger(value.anchor.offset) ||
      value.anchor.offset <= 0 ||
      value.anchor.offset >= sequence.length ||
      value.placement !== 'internal' ||
      (value.behavior !== 'between-bases' && value.behavior !== 'linkage')
    ) {
      throw new Error('Primer oligo modification between-base anchor is invalid.');
    }
    return { kind: 'between-bases', offset: value.anchor.offset };
  }
  if (value.anchor.kind !== 'base') {
    throw new Error('Primer oligo modification anchor is invalid.');
  }
  if (
    typeof value.anchor.index !== 'number' ||
    !Number.isInteger(value.anchor.index) ||
    value.anchor.index < 0 ||
    value.anchor.index >= sequence.length ||
    value.behavior !== 'modified-base' ||
    !value.naturalBase ||
    sequence[value.anchor.index].toUpperCase() !== value.naturalBase ||
    (value.placement === 'five-prime' && value.anchor.index !== 0) ||
    (value.placement === 'three-prime' && value.anchor.index !== sequence.length - 1) ||
    (value.placement === 'internal' &&
      (value.anchor.index === 0 || value.anchor.index === sequence.length - 1))
  ) {
    throw new Error('Primer oligo modification natural-base analogue is invalid.');
  }
  return { kind: 'base', index: value.anchor.index };
}

function cloneAndValidateAppliedModification(
  value: AppliedOligoModificationV1,
  sequence: string
): AppliedOligoModificationV1 {
  if (!isValidAppliedModificationIdentity(value)) {
    throw new Error('Primer oligo modification is invalid.');
  }
  if (!isValidAppliedModificationNaturalBase(value.naturalBase)) {
    throw new Error('Primer oligo modification natural-base analogue is invalid.');
  }
  const anchor = cloneValidatedModificationAnchor(value, sequence);
  return {
    chemistryId: value.chemistryId,
    vendor: value.vendor,
    vendorCode: value.vendorCode,
    placement: value.placement,
    behavior: value.behavior,
    anchor,
    ...(value.naturalBase ? { naturalBase: value.naturalBase } : {}),
  };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isValidBindingAlignment(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.identity === 'number' &&
    Number.isFinite(value.identity) &&
    value.identity >= 0 &&
    value.identity <= 1 &&
    typeof value.editDistance === 'number' &&
    Number.isInteger(value.editDistance) &&
    value.editDistance >= 0 &&
    Array.isArray(value.mismatchPositions) &&
    value.mismatchPositions.every(
      (position) => typeof position === 'number' && Number.isInteger(position) && position >= 0
    ) &&
    typeof value.threePrimeMatchLength === 'number' &&
    Number.isInteger(value.threePrimeMatchLength) &&
    value.threePrimeMatchLength >= 0 &&
    typeof value.effectiveTmC === 'number' &&
    Number.isFinite(value.effectiveTmC)
  );
}

const DESIGN_PROVENANCE_ID = /^sha256:[a-f0-9]{64}$/;
const DESIGN_PROVENANCE_PBS = /^[ACGTN]+$/i;
const DESIGN_PROVENANCE_OVERHANG = /^[ACGTN]*$/i;
const PRIMER3_APPLICATIONS = new Set([
  'pcr',
  'sequencing',
  'qpcr',
  'colony_pcr',
  'gibson',
  'golden_gate',
  'sdm',
  're_cloning',
]);

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidProvenanceTargetCoordinates(target: Record<string, unknown>): boolean {
  if (
    !isPositiveInt(target.length) ||
    !isNonNegativeInt(target.start) ||
    target.start >= target.length ||
    !isNonNegativeInt(target.end) ||
    target.end > target.length ||
    target.end === target.start
  ) {
    return false;
  }
  if (target.topology === 'linear') {
    return target.end > target.start && target.wrapsOrigin === false;
  }
  if (target.topology === 'circular') {
    return target.wrapsOrigin === target.end < target.start;
  }
  return false;
}

function isValidPrimer3Provenance(primer3: Record<string, unknown>): boolean {
  if (typeof primer3.application !== 'string' || !PRIMER3_APPLICATIONS.has(primer3.application)) {
    return false;
  }
  if (!isRecord(primer3.parameters)) return false;
  if (
    !Object.values(primer3.parameters).every(
      (parameter) =>
        parameter === null ||
        typeof parameter === 'string' ||
        typeof parameter === 'number' ||
        typeof parameter === 'boolean'
    )
  ) {
    return false;
  }
  return (
    Array.isArray(primer3.warnings) &&
    primer3.warnings.every((warning) => typeof warning === 'string')
  );
}

function isValidProvenanceTargetIdentity(target: Record<string, unknown>): boolean {
  return (
    typeof target.documentId === 'string' &&
    (target.documentId.length > 0 ||
      (typeof target.legacyWorkspaceRelativePath === 'string' &&
        isSafeWorkspaceRelativePath(target.legacyWorkspaceRelativePath))) &&
    (target.topology === 'linear' || target.topology === 'circular') &&
    isValidProvenanceTargetCoordinates(target) &&
    typeof target.fileContentHash === 'string' &&
    target.fileContentHash.length > 0 &&
    typeof target.normalizedSequenceHash === 'string' &&
    target.normalizedSequenceHash.length > 0
  );
}

function isValidDesignProvenanceIdentity(
  value: Record<string, unknown>,
  designId: string
): boolean {
  return (
    DESIGN_PROVENANCE_ID.test(designId) &&
    typeof value.candidateId === 'string' &&
    isNonNegativeInt(value.candidateRank) &&
    (value.role === 'forward' || value.role === 'reverse') &&
    value.candidateId === `${designId}:pair-${value.candidateRank}:${value.role}`
  );
}

function isValidDesignProvenanceSequences(pbsSequence: string, overhangSequence: string): boolean {
  return (
    DESIGN_PROVENANCE_PBS.test(pbsSequence) && DESIGN_PROVENANCE_OVERHANG.test(overhangSequence)
  );
}

function isValidDesignProvenanceRecord(value: Record<string, unknown>): boolean {
  if (!isRecord(value.target) || !isRecord(value.primer3) || !isRecord(value.tm)) return false;
  const designId = typeof value.designId === 'string' ? value.designId : '';
  const pbsSequence = typeof value.pbsSequence === 'string' ? value.pbsSequence : '';
  const overhangSequence = typeof value.overhangSequence === 'string' ? value.overhangSequence : '';
  if (!isValidDesignProvenanceIdentity(value, designId)) return false;
  if (!isValidDesignProvenanceSequences(pbsSequence, overhangSequence)) return false;
  if (!isValidProvenanceTargetIdentity(value.target)) return false;
  if (!isValidPrimer3Provenance(value.primer3)) return false;
  return isValidTmCalculation(value.tm);
}

function isValidDesignProvenance(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return isValidDesignProvenanceRecord(value);
}

function isValidTmCalculationModel(model: Record<string, unknown>): boolean {
  return (
    (model.kind === 'local' &&
      (model.algorithm === 'santalucia98' || model.algorithm === 'santalucia-owczarzy')) ||
    (model.kind === 'neb' &&
      typeof model.prodcode === 'string' &&
      typeof model.polymerase === 'string')
  );
}

function isValidTmCalculationSource(source: unknown): boolean {
  return (
    source === 'call-override' ||
    source === 'reaction' ||
    source === 'user-setting' ||
    source === 'default'
  );
}

function isValidTmCalculationStatus(status: unknown): boolean {
  return status === 'verified' || status === 'local' || status === 'fallback';
}

function tmProviderMatchesValue(value: Record<string, unknown>): boolean {
  return (
    isRecord(value.provider) &&
    typeof value.provider.tm === 'number' &&
    value.provider.tm === value.valueC
  );
}

function tmModelMatchesProvider(model: Record<string, unknown>, provider: unknown): boolean {
  return (
    isRecord(provider) &&
    ((model.kind === 'local' && provider.source === 'local') ||
      (model.kind === 'neb' &&
        (provider.source === 'neb-api' || provider.source === 'neb-q5-offline')))
  );
}

function tmStatusMatchesProvider(value: Record<string, unknown>): boolean {
  return (
    isRecord(value.provider) &&
    ((value.provider.source === 'local' &&
      value.status === 'local' &&
      value.provider.verified === false &&
      value.provider.pendingNebVerification !== true) ||
      (value.provider.source === 'neb-api' &&
        value.status === 'verified' &&
        value.provider.verified === true &&
        value.provider.pendingNebVerification !== true) ||
      (value.provider.source === 'neb-q5-offline' &&
        value.status === 'fallback' &&
        value.provider.verified === false &&
        value.provider.pendingNebVerification === true))
  );
}

function isValidTmCalculationRecord(value: Record<string, unknown>): boolean {
  if (!isRecord(value.model) || !isValidTmCalculationModel(value.model)) return false;
  if (!isValidTmCalculationSource(value.source)) return false;
  if (typeof value.reason !== 'string') return false;
  if (typeof value.valueC !== 'number' || !Number.isFinite(value.valueC)) return false;
  if (!isValidTmCalculationStatus(value.status)) return false;
  if (!isValidTmProvider(value.provider)) return false;
  if (!tmProviderMatchesValue(value)) return false;
  if (!tmModelMatchesProvider(value.model, value.provider)) return false;
  if (!tmStatusMatchesProvider(value)) return false;
  return true;
}

function isValidTmCalculation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return isValidTmCalculationRecord(value);
}

function isValidBindingAlignmentForPrimer(value: unknown, primerLength: number): boolean {
  if (!isValidBindingAlignment(value) || !isRecord(value)) return false;
  const threePrimeMatchLength = value.threePrimeMatchLength as number;
  const mismatchPositions = value.mismatchPositions as number[];
  return (
    threePrimeMatchLength <= primerLength &&
    mismatchPositions.every((position) => position < primerLength)
  );
}

function isValidOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isValidOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isValidOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isValidOptionalParsedDate(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function isValidTmProviderSource(source: unknown): boolean {
  return source === 'neb-api' || source === 'neb-q5-offline' || source === 'local';
}

function isValidTmProvider(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isValidTmProviderSource(value.source)) return false;
  if (typeof value.tm !== 'number' || !Number.isFinite(value.tm)) return false;
  if (typeof value.conc_nM !== 'number' || !Number.isFinite(value.conc_nM) || value.conc_nM <= 0) {
    return false;
  }
  if (typeof value.verified !== 'boolean') return false;
  if (!isValidOptionalFiniteNumber(value.ta)) return false;
  if (!isValidOptionalBoolean(value.pendingNebVerification)) return false;
  if (!isValidOptionalString(value.polymerase)) return false;
  if (!isValidOptionalString(value.prodcode)) return false;
  if (!isValidOptionalString(value.nebApiVersion)) return false;
  if (!isValidOptionalParsedDate(value.fetchedAt)) return false;
  return true;
}
