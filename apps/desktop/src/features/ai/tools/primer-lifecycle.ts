import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool, DesignToolEffects } from './design-tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import type { LimsEntity } from '../../../shared/lims';
import type { DBCatalogEntityFile } from '../../../db/workspace-catalog';
import { resolveWorkspaceScope } from '../../../db/workspace-catalog';
import { pathRelativeToBoundary } from '../../../shared/path-boundary';
import {
  buildFileDnaSequenceRef,
  buildFileDnaSequenceSnapshot,
} from '../../lims/public/dna-sequence';
import {
  PrimerArtifactRevisionError,
  PrimerHistoryError,
  PrimerProjectionError,
  type AttachPrimerArtifactInput,
  type FileAuthoritativePrimerInput,
  type PrimerArtifactBindingMutationResult,
  type ReadPrimerArtifactResult,
  type SavedPrimerArtifact,
  type UpdatePrimerArtifactContentInput,
  type UpdatePrimerArtifactBindingInput,
} from '../../primers/public/primer-artifact-service';
import {
  sha256Hex,
  serializePrimerArtifact,
  type PrimerArtifactBindingV1,
  type PrimerDesignProvenanceV1,
  type PrimerTmCalculationV1,
} from '../../primers/public/primer-artifact';
import {
  IDT_MODIFICATION_CATALOG,
  IDT_VENDOR_DEFINITION,
  displayIdtToken,
  idtModificationCategoryLabel,
  idtModificationCategoryLabels,
  idtModificationNaturalBase,
  idtModificationPlacements,
  parseIdtOligoNotation,
  searchIdtModificationOptions,
  type OligoModificationPlacement,
  type OligoOrderType,
  type PrimerOligoCompositionV1,
} from '../../primers/public/oligo-modifications';
import type { Primer } from '../../primers/public/types';
import { savedOligoSnapshot } from '../../primers/public/saved-oligo-snapshot';
import { NEB_TM_OPTIONS } from '../../design/public/algorithms/tm-model';
import { assemblyUsesOfOligo } from '../../design/public/saved-primer-links';
import { useDesignStore } from '../../design/public/store';
import type { SequenceDesign } from '../../design/public/types';
import { describeAssemblyTmContext } from '../../junction-workbench/public/settings';
import {
  primerServices,
  type Primer3OligoResult,
  type PrimerCandidateSearchRequest,
  type PrimerCandidateSearchResult,
} from '../../primers/public/primer-services';
import { designResourceUri } from './agent-mutation';
import { resolveTmModelById } from './configure-primer-tm';
import { normalizeSequenceDocumentId, resolveWorkspacePath, getUserFolders } from './path-utils';
import { resolveSequenceDocumentById } from '../../sequence/public/sequence-document-repository';
import { DNA_WITH_N_PATTERN, IUPAC_BASES_PATTERN } from '../../../shared/published-schema-patterns';

const DESIGN_CACHE_TTL_MS = 15 * 60_000;
const DESIGN_CACHE_LIMIT = 32;
const MAX_PRIMER3_TEMPLATE_BP = 50_000;
const MAX_PRIMER_BINDING_SEARCH_BP = 50_000;
const MAX_PRIMER_SIZE_BP = 50;
const MAX_PRIMER3_TARGET_BP = MAX_PRIMER3_TEMPLATE_BP - 2 * MAX_PRIMER_SIZE_BP;
const TM_MODEL_IDS = new Set(['local', 'owczarzy', ...NEB_TM_OPTIONS.map((item) => item.prodcode)]);

const applicationSchema = z.enum([
  'pcr',
  'sequencing',
  'qpcr',
  'colony_pcr',
  'gibson',
  'golden_gate',
  'sdm',
  're_cloning',
]);

const targetSchema = z
  .object({
    start: z.number().int().nonnegative().describe('Interval start in coordinateSystem; zero-based by default.'),
    end: z.number().int().nonnegative().describe('Exclusive end for zero_based_half_open; inclusive end for one_based_inclusive.'),
    coordinateSystem: z.enum(['zero_based_half_open', 'one_based_inclusive']).optional().describe('Defaults to zero_based_half_open for existing callers. Use one_based_inclusive when copying find_features or get_sequence positions.'),
  })
  .strict();

const designParameterSchema = z
  .object({
    primerMinSize: z.number().int().min(15).max(50).optional(),
    primerOptSize: z.number().int().min(15).max(50).optional(),
    primerMaxSize: z.number().int().min(15).max(50).optional(),
    primerMinTm: z
      .number()
      .min(40)
      .max(85)
      .optional()
      .describe('Primer3 candidate-selection lower bound, evaluated by Primer3 itself.'),
    primerOptTm: z
      .number()
      .min(40)
      .max(85)
      .optional()
      .describe('Primer3 candidate-ranking target, evaluated by Primer3 itself.'),
    primerMaxTm: z
      .number()
      .min(40)
      .max(85)
      .optional()
      .describe('Primer3 candidate-selection upper bound, evaluated by Primer3 itself.'),
    primerMinGc: z.number().min(20).max(80).optional(),
    primerMaxGc: z.number().min(20).max(80).optional(),
    productMinSize: z.number().int().min(50).max(MAX_PRIMER3_TEMPLATE_BP).optional(),
    productMaxSize: z.number().int().min(50).max(MAX_PRIMER3_TEMPLATE_BP).optional(),
  })
  .strict()
  .superRefine((parameters, context) => {
    validateOrderedBounds(
      context,
      parameters.primerMinSize,
      parameters.primerOptSize,
      parameters.primerMaxSize,
      'primerOptSize',
      'Primer size'
    );
    validateOrderedBounds(
      context,
      parameters.primerMinTm,
      parameters.primerOptTm,
      parameters.primerMaxTm,
      'primerOptTm',
      'Primer Tm'
    );
    validateMinMax(
      context,
      parameters.primerMinGc,
      parameters.primerMaxGc,
      'primerMaxGc',
      'Primer GC percentage'
    );
    validateMinMax(
      context,
      parameters.productMinSize,
      parameters.productMaxSize,
      'productMaxSize',
      'Product size'
    );
  })
  .optional();

export const designPrimersSchema = z
  .object({
    documentId: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        'Stable package/catalog sequence document ID or waypoint://sequence/{documentId} URI.'
      ),
    target: targetSchema,
    application: applicationSchema.default('pcr'),
    polymerase: z.string().min(1).max(100).optional(),
    tmModel: z
      .string()
      .refine((value) => TM_MODEL_IDS.has(value), 'Unknown primer Tm model.')
      .describe(
        'Method used only to recalculate and report Tm after Primer3 returns candidate sequences. ' +
          'It does not change Primer3 candidate positions, filtering, or ranking.'
      )
      .optional(),
    numReturn: z.number().int().min(1).max(10).default(5),
    parameters: designParameterSchema,
  })
  .strict();

export const saveDesignedPrimerSchema = z
  .object({
    designId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    workspace: z.string().min(1).max(2000).optional().describe('Destination project name or exact root for this oligo. Defaults to the template project for existing callers; select the design/notebook project when its source is in a different project.'),
    candidateId: z.string().min(1),
    name: z.string().min(1).max(200),
    artifactPath: z.string().min(1).max(2000),
    overhangSequence: z
      .string()
      .regex(DNA_WITH_N_PATTERN)
      .default(''),
    pbsSequence: z
      .string()
      .min(1)
      .regex(IUPAC_BASES_PATTERN)
      .optional()
      .describe('Author a different annealing sequence, including intentional mismatches.'),
    oligo: z
      .object({
        vendor: z.literal('idt'),
        notation: z.string().min(1).max(10_000),
      })
      .strict()
      .optional()
      .describe(
        'Exact IDT-ready notation for the complete ordered oligo. May replace the candidate bases and include intentional mismatches or modifications.'
      ),
    notes: z.string().max(2000).optional(),
  })
  .strict();

const vendorOligoSchema = z
  .object({
    vendor: z.literal('idt'),
    orderType: z
      .enum(['dna', 'rna'])
      .default('dna')
      .describe(
        'Polymer/order type. RNA notation uses exact IDT rA/rC/rG/rU and mA/mC/mG/mU tokens; bare bases remain DNA bases in a chimera.'
      ),
    notation: z.string().min(1).max(10_000),
  })
  .strict();

export const listOligoModificationsSchema = z
  .object({
    vendor: z.literal('idt').default('idt'),
    orderType: z
      .enum(['dna', 'rna'])
      .default('dna')
      .describe('Return only codes available for this standard IDT oligo product type.'),
    placement: z.enum(['five-prime', 'internal', 'three-prime']).optional(),
    query: z.string().max(200).optional(),
  })
  .strict();

const optionalWorkspaceSchema = z
  .string()
  .min(1)
  .describe(
    'Optional exact name or absolute path of an open project. Omit this when one user project is open. Never infer a project from artifactPath or primerId.'
  )
  .optional();

export const createPrimerSchema = z
  .object({
    name: z.string().min(1).max(200),
    artifactPath: z.string().min(1).max(2000),
    workspace: optionalWorkspaceSchema,
    oligo: vendorOligoSchema,
    annealingLength: z.number().int().positive().optional().describe('Number of natural bases at the 3-prime end used for annealing. Excludes the 5-prime tail from annealing Tm and binding calculations.'),
    notes: z.string().max(2000).optional(),
  })
  .strict();

const updatePrimerBaseSchema = z
  .object({
    primerId: z.string().min(1),
    expectedArtifactRevision: z.number().int().positive(),
    workspace: optionalWorkspaceSchema,
    name: z.string().min(1).max(200).optional(),
    oligo: vendorOligoSchema.optional(),
    annealingLength: z.number().int().positive().optional(),
    notes: z.string().max(2000).nullable().optional(),
    confirmBindingImpact: z.literal(true).optional(),
  })
  .strict();

const containsPrimerUpdate = (input: {
  name?: string;
  oligo?: z.infer<typeof vendorOligoSchema>;
  notes?: string | null;
  annealingLength?: number;
}): boolean => input.name !== undefined || input.oligo !== undefined || input.notes !== undefined || input.annealingLength !== undefined;

export const updatePrimerSchema = updatePrimerBaseSchema.refine(
  containsPrimerUpdate,
  'Provide at least one of name, oligo, or notes.'
);

const singleWorkspaceUpdatePrimerSchema = updatePrimerBaseSchema
  .omit({ workspace: true })
  .refine(containsPrimerUpdate, 'Provide at least one of name, oligo, or notes.');

const bindingMutationShape = {
  workspace: z.string().min(1).max(2000).optional().describe('Project owning the canonical primer artifact, independently of the target document project. Defaults to the target project for existing callers.'),
  primerId: z.string().min(1),
  targetDocumentId: z
    .string()
    .min(1)
    .max(2000)
    .describe('Stable package/catalog target sequence document ID.'),
  start: z.number().int().nonnegative().describe('Zero-based inclusive position on the target document.'),
  end: z.number().int().nonnegative().describe('Zero-based exclusive end on the target document; end below start denotes origin wrapping on a circular target.'),
  coordinateSystem: z.literal('zero_based_half_open').optional().describe('Binding inputs use zero_based_half_open; convert a one-based feature start by subtracting one.'),
  strand: z.union([z.literal(1), z.literal(-1)]),
  expectedArtifactRevision: z.number().int().positive(),
  maxMismatches: z.number().int().min(0).max(10).default(3),
  validationMode: z
    .enum(['auto', 'manual', 'confirmed'])
    .optional()
    .describe(
      'auto records matching evidence when available and otherwise saves a manual placement; manual skips matching; confirmed requires a matching hit.'
    ),
};

export const addPrimerBindingSchema = z.object(bindingMutationShape).strict();
export const updatePrimerBindingSchema = z
  .object({ ...bindingMutationShape, bindingId: z.string().min(1) })
  .strict();
const getPrimerBaseSchema = z
  .object({
    primerId: z.string().min(1),
    workspace: optionalWorkspaceSchema,
  })
  .strict();

export const getPrimerSchema = getPrimerBaseSchema;
const singleWorkspaceGetPrimerSchema = getPrimerBaseSchema.omit({ workspace: true });

export interface PrimerTargetSnapshot {
  documentId: string;
  projectId?: string;
  workspaceRoot: string;

  absolutePath: string;
  workspaceRelativePath: string;
  sequenceId: number;
  bases: string;
  length: number;
  topology: 'linear' | 'circular';
  fileContentHash: string;
  normalizedSequenceHash: string;
}

export type Primer3OligoWire = Primer3OligoResult;
export type Primer3DesignResponse = PrimerCandidateSearchResult;
type Primer3DesignRequest = PrimerCandidateSearchRequest;

interface BindingHitWire {
  start: number;
  end: number;
  strand: number;
  identity: number;
  edit_distance: number;
  mismatch_positions: number[];
  three_prime_match_length: number;
  effective_tm: number;
}

type CalculatedTm = PrimerTmCalculationV1;

export interface PrimerLifecycleDependencies {
  resolveTarget: (folders: WorkspaceFolder[], documentId: string) => Promise<PrimerTargetSnapshot>;
  assertTargetUnchanged: (target: StoredDesign['target']) => Promise<void>;
  designPrimers: (
    request: Primer3DesignRequest,
    options?: { signal?: AbortSignal }
  ) => Promise<Primer3DesignResponse>;
  calculateTm: (
    sequence: string,
    context: {
      polymerase?: string;
      tmModel?: string;
      signal?: AbortSignal;
      grantedCapabilities?: readonly string[];
    }
  ) => Promise<CalculatedTm>;
  savePrimer: (input: FileAuthoritativePrimerInput) => Promise<SavedPrimerArtifact>;
  updatePrimerContent: (input: UpdatePrimerArtifactContentInput) => Promise<SavedPrimerArtifact>;
  getPrimerById: (id: string) => Promise<Primer | null>;
  readPrimerArtifact: (primer: Primer, workspaceRoot: string) => Promise<ReadPrimerArtifactResult>;
  matchPrimer: (
    primer: string,
    target: PrimerTargetSnapshot,
    maxMismatches: number,
    options?: { signal?: AbortSignal }
  ) => Promise<BindingHitWire[]>;
  attachBinding: (input: AttachPrimerArtifactInput) => Promise<PrimerArtifactBindingMutationResult>;
  updateBinding: (
    input: UpdatePrimerArtifactBindingInput
  ) => Promise<PrimerArtifactBindingMutationResult>;
  getCatalogFile: (primerId: string) => Promise<DBCatalogEntityFile | null>;
  getLimsEntity: (primerId: string) => Promise<LimsEntity | null>;
  notifyBindingsChanged: (sequenceId: number) => void;
  listDesigns: () => readonly SequenceDesign[];
}

interface PreparedDesignTemplate {
  template: string;
  targetStart: number;
  targetLength: number;
  rotationOffset: number;
  wrapsOrigin: boolean;
}

interface PreparedBindingSearch {
  target: PrimerTargetSnapshot;
  sourceLength: number;
  sourceTopology: 'linear' | 'circular';
  rotationOffset: number;
}

interface CandidateSnapshot {
  candidateId: string;
  rank: number;
  role: 'forward' | 'reverse';
  pbsSequence: string;
  overhangSequence: string;
  binding: { start: number; end: number; strand: 1 | -1 };
  tm: CalculatedTm;
  primer3: Primer3OligoWire;
}

interface StoredDesign {
  expiresAt: number;
  designId: string;
  application: z.infer<typeof applicationSchema>;
  target: Omit<PrimerTargetSnapshot, 'bases'> & {
    start: number;
    end: number;
    wrapsOrigin: boolean;
  };
  paramsUsed: Record<string, string | number | boolean | null>;
  warnings: string[];
  candidates: Map<string, CandidateSnapshot>;
}

const designCache = new Map<string, StoredDesign>();

export function clearPrimerDesignCacheForTests(): void {
  designCache.clear();
}

function normalizePrimerTarget(target: { start: number; end: number; coordinateSystem?: 'zero_based_half_open' | 'one_based_inclusive' }) {
  const oneBased = target.coordinateSystem === 'one_based_inclusive';
  if (!Number.isInteger(target.start) || !Number.isInteger(target.end) || target.start < (oneBased ? 1 : 0) || target.end < (oneBased ? 1 : 0)) throw new Error('Target coordinates do not match the declared coordinate system.');
  return { start: oneBased ? target.start - 1 : target.start, end: target.end };
}

export function preparePrimerDesignTemplate(
  bases: string,
  topology: 'linear' | 'circular',
  inputTarget: { start: number; end: number; coordinateSystem?: 'zero_based_half_open' | 'one_based_inclusive' }
): PreparedDesignTemplate {
  const target = normalizePrimerTarget(inputTarget);
  const sequenceLength = bases.length;
  if (sequenceLength < 50) throw new Error('Primer design requires a sequence of at least 50 bp.');
  if (target.start >= sequenceLength || target.end > sequenceLength) {
    throw new Error(`Target coordinates exceed the ${sequenceLength} bp sequence.`);
  }
  if (topology === 'linear') {
    if (target.end <= target.start) {
      throw new Error('A linear primer target must have end greater than start.');
    }
    if (target.end - target.start < 20) throw new Error('Primer target must span at least 20 bp.');
    const targetLength = target.end - target.start;
    assertBoundedPrimerTarget(targetLength);
    if (sequenceLength <= MAX_PRIMER3_TEMPLATE_BP) {
      return validatePrimer3Template({
        template: bases,
        targetStart: target.start,
        targetLength,
        rotationOffset: 0,
        wrapsOrigin: false,
      });
    }
    const flankBudget = MAX_PRIMER3_TEMPLATE_BP - targetLength;
    const idealStart = target.start - Math.floor(flankBudget / 2);
    const windowStart = Math.min(Math.max(idealStart, 0), sequenceLength - MAX_PRIMER3_TEMPLATE_BP);
    return validatePrimer3Template({
      template: bases.slice(windowStart, windowStart + MAX_PRIMER3_TEMPLATE_BP),
      targetStart: target.start - windowStart,
      targetLength,
      rotationOffset: windowStart,
      wrapsOrigin: false,
    });
  }

  if (target.end === target.start) {
    throw new Error('A circular primer target cannot have identical start and end coordinates.');
  }
  const wrapsOrigin = target.end < target.start;
  const targetLength = wrapsOrigin
    ? sequenceLength - target.start + target.end
    : target.end - target.start;
  if (targetLength < 20) throw new Error('Primer target must span at least 20 bp.');
  assertBoundedPrimerTarget(targetLength);
  const templateLength = Math.min(sequenceLength, MAX_PRIMER3_TEMPLATE_BP);
  const leftFlank = Math.floor((templateLength - targetLength) / 2);
  const rotationOffset = modulo(target.start - leftFlank, sequenceLength);
  return validatePrimer3Template({
    template: circularSlice(bases, rotationOffset, templateLength),
    targetStart: leftFlank,
    targetLength,
    rotationOffset,
    wrapsOrigin,
  });
}

function validatePrimer3Template(prepared: PreparedDesignTemplate): PreparedDesignTemplate {
  if (!/^[ACGTN]+$/i.test(prepared.template)) {
    throw new Error('Primer design accepts only A, C, G, T, and N template bases.');
  }
  return prepared;
}

export function projectPrimer3Binding(
  oligo: Pick<Primer3OligoWire, 'start' | 'length'>,
  role: 'forward' | 'reverse',
  mapping: {
    topology: 'linear' | 'circular';
    sequenceLength: number;
    templateLength?: number;
    rotationOffset: number;
  }
): { start: number; end: number; strand: 1 | -1 } {
  const localStart = role === 'forward' ? oligo.start : oligo.start - oligo.length + 1;
  const localEnd = localStart + oligo.length;
  const templateLength = mapping.templateLength ?? mapping.sequenceLength;
  if (localStart < 0 || localEnd > templateLength) {
    throw new Error(`Primer3 returned invalid ${role} primer coordinates.`);
  }
  if (mapping.topology === 'linear') {
    return {
      start: mapping.rotationOffset + localStart,
      end: mapping.rotationOffset + localEnd,
      strand: role === 'forward' ? 1 : -1,
    };
  }
  const unwrappedStart = mapping.rotationOffset + localStart;
  const unwrappedEnd = mapping.rotationOffset + localEnd;
  return {
    start: modulo(unwrappedStart, mapping.sequenceLength),
    end:
      unwrappedStart < mapping.sequenceLength && unwrappedEnd === mapping.sequenceLength
        ? mapping.sequenceLength
        : modulo(unwrappedEnd, mapping.sequenceLength),
    strand: role === 'forward' ? 1 : -1,
  };
}

function preparePrimerBindingSearch(
  target: PrimerTargetSnapshot,
  requestedStart: number,
  primerLength: number
): PreparedBindingSearch {
  const windowLength = Math.min(target.length, MAX_PRIMER_BINDING_SEARCH_BP);
  if (primerLength > windowLength) {
    throw new Error(
      `Primer PBS length (${primerLength} bp) exceeds the ${windowLength} bp binding target.`
    );
  }
  if (target.length <= MAX_PRIMER_BINDING_SEARCH_BP) {
    return {
      target,
      sourceLength: target.length,
      sourceTopology: target.topology,
      rotationOffset: 0,
    };
  }
  const leftFlank = Math.floor((windowLength - primerLength) / 2);
  const rotationOffset =
    target.topology === 'linear'
      ? Math.min(Math.max(requestedStart - leftFlank, 0), target.length - windowLength)
      : modulo(requestedStart - leftFlank, target.length);
  const bases =
    target.topology === 'linear'
      ? target.bases.slice(rotationOffset, rotationOffset + windowLength)
      : circularSlice(target.bases, rotationOffset, windowLength);

  return {
    target: {
      ...target,
      bases,
      length: bases.length,


      topology: 'linear',
    },
    sourceLength: target.length,
    sourceTopology: target.topology,
    rotationOffset,
  };
}

function projectBindingSearchHit(
  hit: BindingHitWire,
  search: PreparedBindingSearch
): BindingHitWire {
  if (search.sourceTopology === 'linear') {
    return {
      ...hit,
      start: search.rotationOffset + hit.start,
      end: search.rotationOffset + hit.end,
    };
  }

  const start = modulo(search.rotationOffset + hit.start, search.sourceLength);
  const endFromStart = start + (hit.end - hit.start);
  return {
    ...hit,
    start,
    end: endFromStart <= search.sourceLength ? endFromStart : endFromStart - search.sourceLength,
  };
}

const defaultDependencies: PrimerLifecycleDependencies = {
  resolveTarget: resolvePrimerTarget,
  assertTargetUnchanged,
  designPrimers: primerServices.candidateSearch.search,
  calculateTm: (sequence, context) =>
    primerServices.tmCalculation.calculate(sequence, {
      override: context.tmModel ? resolveTmModelById(context.tmModel) : undefined,
      polymerase: context.polymerase,
      signal: context.signal,
      grantedCapabilities: context.grantedCapabilities,
    }),
  savePrimer: primerServices.persistence.saveArtifact,
  updatePrimerContent: primerServices.persistence.updateArtifactContent,
  getPrimerById: primerServices.persistence.getPrimer,
  readPrimerArtifact: primerServices.persistence.readArtifact,
  matchPrimer: async (primer, target, maxMismatches, options) =>
    (await primerServices.bindingSearch.match(primer, target, maxMismatches, options)).map(
      (hit) => ({
        start: hit.start,
        end: hit.end,
        strand: hit.strand,
        identity: hit.identity,
        edit_distance: hit.editDistance,
        mismatch_positions: hit.mismatchPositions,
        three_prime_match_length: hit.threePrimeMatchLength,
        effective_tm: hit.effectiveTm,
      })
    ),
  attachBinding: primerServices.persistence.attachBinding,
  updateBinding: primerServices.persistence.updateBinding,
  getCatalogFile: primerServices.persistence.getCatalogFile,
  getLimsEntity: primerServices.persistence.getLimsEntity,
  notifyBindingsChanged: primerServices.persistence.notifyBindingsChanged,
  listDesigns: () => Object.values(useDesignStore.getState().designs),
};

export function createDesignPrimersTool(
  folders: WorkspaceFolder[],
  dependencies: PrimerLifecycleDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Design bounded primer pairs for an exact project target. Primer3 chooses and ranks the ' +
      'candidate positions and sequences using the Primer3 Tm thresholds in parameters. The Tm ' +
      'model changes only the separate calculation reported after Primer3 returns candidates; it ' +
      'does not change those candidates. Returns pinned candidates, normalized bindings, both ' +
      'Primer3 Tm and selected reported-Tm provenance. Call save_designed_primer to persist one.',
    inputSchema: designPrimersSchema as z.ZodTypeAny,
    execute: async (
      input: z.infer<typeof designPrimersSchema>,
      context?: { abortSignal?: AbortSignal; grantedCapabilities?: string[] }
    ) =>
      runDesignTool('DESIGN_PRIMERS_FAILED', async () => {
        try {
          const target = await dependencies.resolveTarget(folders, input.documentId);
          const coordinates = normalizePrimerTarget(input.target);
          const prepared = preparePrimerDesignTemplate(target.bases, target.topology, coordinates);
          const request = designRequest(input, prepared);
          const response = await dependencies.designPrimers(request, {
            signal: context?.abortSignal,
          });
          if (!response.success || response.primer_pairs.length === 0) {
            return toolSuccess({
              designed: false,
              code: 'PRIMER3_NO_RESULT',
              message: response.message,
              warnings: response.warnings,
              parameters: response.params_used,
            });
          }
          if (response.application !== input.application) {
            throw new Error('Primer3 response application did not match the request.');
          }
          if (response.sequence_length !== prepared.template.length) {
            throw new Error('Primer3 response template length did not match the bounded request.');
          }
          if (
            !response.target_region ||
            response.target_region[0] !== prepared.targetStart ||
            response.target_region[1] !== prepared.targetLength
          ) {
            throw new Error('Primer3 response target region did not match the bounded request.');
          }
          if (response.primer_pairs.length > input.numReturn) {
            throw new Error('Primer3 returned more candidate pairs than requested.');
          }
          const calculatedPairs = await Promise.all(
            response.primer_pairs.map(async (pair) => ({
              forward: await dependencies.calculateTm(pair.forward.sequence, {
                polymerase: input.polymerase,
                tmModel: input.tmModel,
                signal: context?.abortSignal,
                grantedCapabilities: context?.grantedCapabilities,
              }),
              reverse: await dependencies.calculateTm(pair.reverse.sequence, {
                polymerase: input.polymerase,
                tmModel: input.tmModel,
                signal: context?.abortSignal,
                grantedCapabilities: context?.grantedCapabilities,
              }),
            }))
          );
          const designFingerprint = await sha256Hex(
            stableJson({
              workspaceRoot: target.workspaceRoot,
              documentId: target.documentId,
              fileContentHash: target.fileContentHash,
              normalizedSequenceHash: target.normalizedSequenceHash,
              target: coordinates,
              request,
              response,
              reportedTm: calculatedPairs,
            })
          );
          const designId = `sha256:${designFingerprint}`;
          const candidates = new Map<string, CandidateSnapshot>();
          const pairs = response.primer_pairs.map((pair, rank) => {
            const project = (
              role: 'forward' | 'reverse',
              oligo: Primer3OligoWire,
              tm: CalculatedTm
            ) => {
              if (oligo.sequence.length !== oligo.length) {
                throw new Error(`Primer3 returned inconsistent ${role} primer length.`);
              }
              const candidateId = `${designId}:pair-${rank}:${role}`;
              const candidate: CandidateSnapshot = {
                candidateId,
                rank,
                role,
                pbsSequence: oligo.sequence,
                overhangSequence: '',
                binding: projectPrimer3Binding(oligo, role, {
                  topology: target.topology,
                  sequenceLength: target.length,
                  templateLength: prepared.template.length,
                  rotationOffset: prepared.rotationOffset,
                }),
                tm,
                primer3: oligo,
              };
              candidates.set(candidateId, candidate);
              return projectCandidate(candidate);
            };
            return {
              rank,
              forward: project('forward', pair.forward, calculatedPairs[rank].forward),
              reverse: project('reverse', pair.reverse, calculatedPairs[rank].reverse),
              productSize: pair.product_size,
              pairAnyTh: pair.pair_any_th,
              pairEndTh: pair.pair_end_th,
              penalty: pair.penalty,
            };
          });
          storeDesign({
            expiresAt: Date.now() + DESIGN_CACHE_TTL_MS,
            designId,
            application: input.application,
            target: pinDesignTarget(target, coordinates, prepared.wrapsOrigin),
            paramsUsed: response.params_used,
            warnings: response.warnings,
            candidates,
          });
          return toolSuccess({
            designed: true,
            designId,
            target: projectTarget(target, coordinates, prepared.wrapsOrigin),
            application: input.application,
            warnings: response.warnings,
            parameters: response.params_used,
            pairs,
          });
        } catch (error) {
          if (isAbortError(error, context?.abortSignal)) throw error;
          return failure('PRIMER_DESIGN_FAILED', error);
        }
      }),
  });
}

export const SAVE_DESIGNED_PRIMER_DESCRIPTION =
  "Save a candidate from design_primers or an agent-authored variation. Supply pbsSequence to replace its annealing bases, overhangSequence for a 5' tail, or exact complete oligo notation for arbitrary bases and chemistry. Intentional mismatches and length changes are allowed. Edited candidates are saved as authored primers with fresh calculations rather than claiming the original candidate's scientific evidence.";

export function createSaveDesignedPrimerTool(
  folders: WorkspaceFolder[],
  dependencies: PrimerLifecycleDependencies = defaultDependencies
) {
  return resultTool({
    description: SAVE_DESIGNED_PRIMER_DESCRIPTION,
    inputSchema: saveDesignedPrimerSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof saveDesignedPrimerSchema>) =>
      runDesignTool('SAVE_DESIGNED_PRIMER_FAILED', async (effects) => {
      const design = loadDesign(input.designId);
      if (!design)
        return failure('PRIMER_DESIGN_EXPIRED', 'Design is absent or expired; design again.');
      const candidate = design.candidates.get(input.candidateId);
      if (!candidate)
        return failure('PRIMER_CANDIDATE_NOT_FOUND', 'Candidate does not belong to this design.');
      if (!getUserFolders(folders).some((folder) => folder.path === design.target.workspaceRoot)) {
        return failure(
          'PRIMER_DESIGN_WORKSPACE_CLOSED',
          'The project used for this design is no longer open; open it and design again.'
        );
      }
      try {
        await dependencies.assertTargetUnchanged(design.target);
        const workspaceRoot = input.workspace ? selectWorkspaceRoot(folders, input.workspace) : design.target.workspaceRoot;
        const artifactPath = resolveWorkspacePath(workspaceRoot, input.artifactPath);
        const overhang = input.overhangSequence ?? '';
        const expectedSequence = `${overhang}${input.pbsSequence ?? candidate.pbsSequence}`;
        const oligo = input.oligo ? parseAgentOligo(input.oligo) : null;
        if (
          input.pbsSequence &&
          oligo &&
          oligo.sequence.toUpperCase() !== expectedSequence.toUpperCase()
        ) {
          return failure(
            'PRIMER_OLIGO_SEQUENCE_MISMATCH',
            'The notation and the explicitly supplied overhang/annealing sequences disagree.'
          );
        }
        const sequence = oligo?.sequence ?? expectedSequence;
        if (!sequence.toUpperCase().startsWith(overhang.toUpperCase()))
          return failure('PRIMER_OLIGO_SEQUENCE_MISMATCH', 'The complete oligo does not begin with the explicitly supplied 5-prime tail.');
        const annealing = { pbsSequence: sequence.slice(overhang.length), overhangSequence: sequence.slice(0, overhang.length) };
        const candidateEdited =
          sequence.toUpperCase() !== `${overhang}${candidate.pbsSequence}`.toUpperCase();
        const provenance = candidateEdited
          ? undefined
          : designProvenance(design, candidate, overhang);
        effects.attemptedMutation();
        const saved = await dependencies.savePrimer({
          name: input.name,
          sequence,
          annealing,
          ...(oligo?.composition ? { oligo: oligo.composition } : {}),
          workspaceRoot,
          artifactPath,
          requireRegistry: true,
          application: artifactApplication(design.application),
          notes: input.notes,
          origin: 'manual',
          artifactSource: candidateEdited ? 'manual' : 'agent-design',
          actor: 'agent',
          designProvenance: provenance,
        });
        effects.changed({ kind: 'primer-artifact-saved', path: saved.artifact.file.workspaceRelativePath });
        return toolSuccess({
          saved: true,
          workspaceRoot,
          primerId: saved.artifact.id,
          artifactRevision: saved.artifact.artifactRevision,
          artifactPath: saved.artifact.file.workspaceRelativePath,
          artifactChecksum: `sha256:${await sha256Hex(serializePrimerArtifact(saved.artifact))}`,
          registryEntityId: saved.limsEntity.id,
          gitCommitted: saved.gitCommitted,
          candidateId: candidate.candidateId,
          candidateEdited,
          bindingCount: saved.artifact.bindings.length,
          idtNotation: saved.artifact.oligo?.notation ?? sequence,
        });
      } catch (error) {
        return mutationFailure(error, effects);
      }
      }),
  });
}

export function createListOligoModificationsTool() {
  return resultTool({
    description:
      'List placement-verified oligo modification definitions from a vendor catalog. Use this before authoring modified notation; placement and natural-base behavior come from this catalog, never from model inference.',
    inputSchema: listOligoModificationsSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof listOligoModificationsSchema>) =>
      runDesignTool('LIST_OLIGO_MODIFICATIONS_FAILED', async () => {
        const placement = input.placement as OligoModificationPlacement | undefined;
        const orderType = input.orderType ?? 'dna';
        const matches = searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, input.query ?? '', {
          orderType,
          ...(placement ? { placement } : {}),
        });
        return toolSuccess({
          vendor: 'idt',
          orderType,
          notation: IDT_VENDOR_DEFINITION.notation,
          catalogSourceUrl: IDT_VENDOR_DEFINITION.catalogSourceUrl,
          catalogRetrievedAt: IDT_VENDOR_DEFINITION.catalogRetrievedAt,
          catalogEntryCount: searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '', {
            orderType,
          }).length,
          constraints: IDT_VENDOR_DEFINITION.rules,
          count: matches.length,
          modifications: matches.map((entry) => ({
            code: entry.vendorCode,
            token: displayIdtToken(entry.vendorCode),
            label: entry.label,
            category: entry.category,
            categoryLabel: idtModificationCategoryLabel(entry),
            categoryLabels: idtModificationCategoryLabels(entry),
            placement: entry.placement,
            allowedPlacements: idtModificationPlacements(entry),
            behavior: entry.behavior,
            naturalBase: idtModificationNaturalBase(entry, orderType) ?? null,
            supportedOrderTypes: entry.supportedOrderTypes,
            productUrl: entry.productUrl ?? null,
          })),
        });
      }),
  });
}

export const CREATE_PRIMER_DESCRIPTION =
  'Create a standalone file-authoritative DNA or RNA oligo from exact vendor-ready notation. RNA uses IDT rA/rC/rG/rU and mA/mC/mG/mU notation; exact vendor notation remains authoritative for copying and ordering. The shared parser derives natural bases and modification anchors, rejects invalid placement, and writes the same canonical artifact/projections/Git history as the human primer editor. When exactly one project is open, it is selected automatically and the project selector is intentionally unavailable.';

export function createCreatePrimerTool(
  folders: WorkspaceFolder[],
  dependencies: PrimerLifecycleDependencies = defaultDependencies
) {
  const inputSchema =
    getUserFolders(folders).length === 1
      ? createPrimerSchema.omit({ workspace: true })
      : createPrimerSchema;
  return resultTool({
    description: CREATE_PRIMER_DESCRIPTION,
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof createPrimerSchema>) =>
      runDesignTool('CREATE_PRIMER_FAILED', async (effects) => {
      try {
        const workspaceRoot = selectWorkspaceRoot(folders, input.workspace);
        const artifactPath = resolveWorkspacePath(workspaceRoot, input.artifactPath);
        const oligo = parseAgentOligo(input.oligo);
        effects.attemptedMutation();
        const saved = await dependencies.savePrimer({
          name: input.name,
          sequence: oligo.sequence,
          ...(input.annealingLength !== undefined ? { annealing: agentAnnealingSegment(oligo.sequence, input.annealingLength) } : {}),
          ...(oligo.composition ? { oligo: oligo.composition } : {}),
          workspaceRoot,
          artifactPath,
          requireRegistry: true,
          notes: input.notes,
          origin: 'manual',
          artifactSource: 'manual',
          actor: 'agent',
        });
        effects.changed({ kind: 'primer-artifact-saved', path: saved.artifact.file.workspaceRelativePath });
        return toolSuccess(projectPrimerMutation(saved));
      } catch (error) {
        return mutationFailure(error, effects);
      }
      }),
  });
}

export const UPDATE_PRIMER_DESCRIPTION =
  'Freely update a saved DNA or RNA primer: name, notes, bases, length, tails and chemical modifications through exact vendor-ready notation. Intentional mismatches are allowed. Attached/shared primers remain the same entity and update all their uses. No additional per-edit confirmation is required. Read its current artifact revision before writing.';

export function createUpdatePrimerTool(
  folders: WorkspaceFolder[],
  dependencies: PrimerLifecycleDependencies = defaultDependencies
) {
  const inputSchema =
    getUserFolders(folders).length === 1 ? singleWorkspaceUpdatePrimerSchema : updatePrimerSchema;
  return resultTool({
    description: UPDATE_PRIMER_DESCRIPTION,
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof updatePrimerSchema>) =>
      runDesignTool('UPDATE_PRIMER_FAILED', async (effects) => {
      try {
        const primer = await dependencies.getPrimerById(input.primerId);
        if (!primer) return failure('PRIMER_NOT_FOUND', `Primer not found: ${input.primerId}`);
        const workspaceRoot = workspaceRootForPrimer(folders, primer, input.workspace);
        const read = await dependencies.readPrimerArtifact(primer, workspaceRoot);
        const oligo = input.oligo ? parseAgentOligo(input.oligo) : null;
        const nextSequence = oligo?.sequence ?? read.artifact.sequence.bases;
        const nextComposition = input.oligo ? (oligo?.composition ?? null) : read.artifact.oligo;
        effects.attemptedMutation();
        const saved = await dependencies.updatePrimerContent({
          artifactPath: read.path,
          workspaceRoot,
          expectedArtifactRevision: input.expectedArtifactRevision,
          ...(read.acceptedRevision ? { acceptedRevision: read.acceptedRevision } : {}),
          name: input.name ?? read.artifact.name,
          sequence: nextSequence,
          ...(input.annealingLength !== undefined ? { annealing: agentAnnealingSegment(nextSequence, input.annealingLength) } : {}),
          ...(input.oligo ? { oligo: nextComposition ?? null } : {}),
          ...(Object.prototype.hasOwnProperty.call(input, 'notes') ? { notes: input.notes } : {}),
          actor: 'agent',
        });
        effects.changed({ kind: 'primer-artifact-saved', path: saved.artifact.file.workspaceRelativePath });
        return toolSuccess(projectPrimerMutation(saved));
      } catch (error) {
        return mutationFailure(error, effects);
      }
      }),
  });
}

export const ADD_PRIMER_BINDING_DESCRIPTION =
  'Attach a saved primer at the requested location and strand only when the user requests that attachment. Drafted assembly primers belong to the design and its accepted history; using source parts does not authorize attaching primers to those sources. auto validation records matcher evidence when available and otherwise preserves an explicitly unverified manual placement. manual skips matching; confirmed requires a matcher hit. Intentional mismatches are allowed. Revision guards and duplicate detection remain in force.';

export function createAddPrimerBindingTool(
  folders: WorkspaceFolder[],
  dependencies: PrimerLifecycleDependencies = defaultDependencies
) {
  return resultTool({
    description: ADD_PRIMER_BINDING_DESCRIPTION,
    inputSchema: addPrimerBindingSchema as z.ZodTypeAny,
    execute: async (
      input: z.infer<typeof addPrimerBindingSchema>,
      context?: { abortSignal?: AbortSignal }
    ) =>
      runDesignTool('ADD_PRIMER_BINDING_FAILED', async (effects) =>
        mutateBinding('add', folders, input, dependencies, context?.abortSignal, effects)
      ),
  });
}

export const UPDATE_PRIMER_BINDING_DESCRIPTION =
  'Move or reverse an existing primer binding while preserving its identity. auto validation records matcher evidence when available or saves a manual placement; manual skips matching; confirmed requires a matcher hit. Requires the artifact revision last returned by get_primer.';

export function createUpdatePrimerBindingTool(
  folders: WorkspaceFolder[],
  dependencies: PrimerLifecycleDependencies = defaultDependencies
) {
  return resultTool({
    description: UPDATE_PRIMER_BINDING_DESCRIPTION,
    inputSchema: updatePrimerBindingSchema as z.ZodTypeAny,
    execute: async (
      input: z.infer<typeof updatePrimerBindingSchema>,
      context?: { abortSignal?: AbortSignal }
    ) =>
      runDesignTool('UPDATE_PRIMER_BINDING_FAILED', async (effects) =>
        mutateBinding('update', folders, input, dependencies, context?.abortSignal, effects)
      ),
  });
}

export function createGetPrimerTool(
  folders: WorkspaceFolder[],
  dependencies: PrimerLifecycleDependencies = defaultDependencies
) {
  const inputSchema =
    getUserFolders(folders).length === 1 ? singleWorkspaceGetPrimerSchema : getPrimerSchema;
  return resultTool({
    description:
      'Read one file-authoritative primer and its exact artifact, binding, target identity, mismatch evidence, design/Tm provenance, LIMS registry projection, catalog file relation, and compatibility projection. assemblyUses lists each assembly design primer linked to this oligo, with its binding part, 5-prime tail, source site and whether the link is still current. Use the returned artifactRevision for the next mutation.',
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof getPrimerSchema>) =>
      runDesignTool('GET_PRIMER_FAILED', async (effects) => {
        try {
          const primer = await dependencies.getPrimerById(input.primerId);
          if (!primer) return failure('PRIMER_NOT_FOUND', `Primer not found: ${input.primerId}`);
          const workspaceRoot = workspaceRootForPrimer(folders, primer, input.workspace);
          return toolSuccess(await projectPrimerReadback(primer, workspaceRoot, dependencies));
        } catch (error) {
          return mutationFailure(error, effects);
        }
      }),
  });
}

async function mutateBinding(
  mode: 'add' | 'update',
  folders: WorkspaceFolder[],
  input: z.infer<typeof addPrimerBindingSchema> | z.infer<typeof updatePrimerBindingSchema>,
  dependencies: PrimerLifecycleDependencies,
  signal: AbortSignal | undefined,
  effects: DesignToolEffects
) {
  try {
    const primer = await dependencies.getPrimerById(input.primerId);
    if (!primer) return failure('PRIMER_NOT_FOUND', `Primer not found: ${input.primerId}`);
    const target = await dependencies.resolveTarget(folders, input.targetDocumentId);
    validateBindingCoordinates(target, input.start, input.end);
    const workspaceRoot = input.workspace ? workspaceRootForPrimer(folders, primer, input.workspace) : target.workspaceRoot;
    const read = await dependencies.readPrimerArtifact(primer, workspaceRoot);
    const previousSequenceId =
      mode === 'update'
        ? read.resolvedBindings.find(
            (resolved) =>
              resolved.binding.id === (input as z.infer<typeof updatePrimerBindingSchema>).bindingId
          )?.sequenceId
        : undefined;
    const recordedBinding = read.artifact.annealing?.pbsSequence ?? read.artifact.designProvenance?.pbsSequence;
    const pbs = recordedBinding ?? read.artifact.sequence.bases;
    const search = preparePrimerBindingSearch(target, input.start, pbs.length);
    const localHits =
      input.validationMode === 'manual'
        ? []
        : await dependencies.matchPrimer(pbs, search.target, input.maxMismatches, {
            signal,
          });
    for (const candidate of localHits) {
      validateBindingHit(candidate, pbs.length, search.target, input.maxMismatches);
    }
    const hits = localHits.map((candidate) => projectBindingSearchHit(candidate, search));
    for (const candidate of hits) {
      validateBindingHit(candidate, pbs.length, target, input.maxMismatches);
    }
    const hit = hits.find(
      (candidate) =>
        candidate.start === input.start &&
        candidate.end === input.end &&
        candidate.strand === input.strand
    );
    if (!hit && input.validationMode === 'confirmed') {
      const requestedLength =
        target.topology === 'circular' && input.end < input.start
          ? target.length - input.start + input.end
          : input.end - input.start;
      const bindingSplitRecorded = recordedBinding != null;
      return designToolFailure('PRIMER_BINDING_SITE_NOT_FOUND', {
        changed: false,
        code: 'PRIMER_BINDING_SITE_NOT_FOUND',
        coordinateSystem: 'zero_based_half_open',
        message:
          'The primer matcher did not confirm the requested coordinate and strand. Start is zero-based inclusive; end is exclusive. Copy start, end and strand from a suitable availableHits entry unchanged, then retry with the same artifact revision. Do not increment start.',
        requested: { start: input.start, end: input.end, strand: input.strand },
        availableHits: hits.slice(0, 10).map(projectBindingHit),
        searchedSequenceLength: pbs.length,
        bindingSplitRecorded,
        ...(!bindingSplitRecorded && pbs.length > requestedLength
          ? {
              hint: 'This oligo has no saved binding and tail split, so the whole oligo, including any 5-prime tail, was searched. Record the split with update_primer annealingLength, or with save_design_primers restoreMissingBindingSplit for an assembly primer, then retry.',
            }
          : {}),
      }, effects);
    }
    const mutationInput = {
      primer,
      workspaceRoot,
      targetWorkspaceRoot: target.workspaceRoot,
      targetDocumentId: target.documentId,
      targetFilePath: target.absolutePath,
      bindingSequenceId: target.sequenceId,
      bindingStart: input.start,
      bindingEnd: input.end,
      bindingStrand: input.strand,
      expectedArtifactRevision: input.expectedArtifactRevision,
      source: hit ? ('agent-design' as const) : ('manual' as const),
      alignment: hit ? alignmentFromHit(hit) : undefined,
    };
    effects.attemptedMutation();
    const result =
      mode === 'add'
        ? await dependencies.attachBinding(mutationInput)
        : await dependencies.updateBinding({
            ...mutationInput,
            bindingId: (input as z.infer<typeof updatePrimerBindingSchema>).bindingId,
          });
    if (result.bindingMutation === 'duplicate') effects.unchanged();
    else effects.changed({ kind: 'primer-binding-saved', bindingId: result.bindingId });
    dependencies.notifyBindingsChanged(target.sequenceId);
    if (previousSequenceId != null && previousSequenceId !== target.sequenceId) {
      dependencies.notifyBindingsChanged(previousSequenceId);
    }
    return toolSuccess({
      changed: result.bindingMutation !== 'duplicate',
      status: result.bindingMutation,
      primerId: result.artifact.id,
      bindingId: result.bindingId,
      artifactRevision: result.artifact.artifactRevision,
      bindingConfirmed: Boolean(hit),
      warnings: hit
        ? []
        : [
            'The requested placement is stored as manual; binding has not been computationally confirmed.',
          ],
      binding: projectBindingForAgent(
        result.artifact.bindings.find((binding) => binding.id === result.bindingId) ?? null,
        target.sequenceId
      ),
      gitCommitted: result.gitCommitted,
    });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return mutationFailure(error, effects);
  }
}

async function projectPrimerReadback(
  primer: Primer,
  workspaceRoot: string,
  dependencies: PrimerLifecycleDependencies
) {
  const read = await dependencies.readPrimerArtifact(primer, workspaceRoot);
  const [catalogFile, limsEntity] = await Promise.all([
    dependencies.getCatalogFile(primer.id),
    dependencies.getLimsEntity(read.artifact.registry.entityId),
  ]);
  const sequenceIdByBinding = new Map(
    read.resolvedBindings.map((resolved) => [resolved.binding.id, resolved.sequenceId])
  );
  return {
    found: true,
    workspaceRoot,
    primerId: primer.id,
    artifactRevision: read.artifact.artifactRevision,
    name: read.artifact.name,
    catalogNumber: read.artifact.catalogNumber,
    sequence: read.artifact.sequence,
    annealing: read.artifact.annealing ?? null,
    oligo: read.artifact.oligo ?? null,
    idtNotation: read.artifact.oligo?.notation ?? read.artifact.sequence.bases,
    computed: read.artifact.computed,
    designProvenance: projectDesignProvenanceForAgent(read.artifact.designProvenance),
    artifact: {
      path: read.artifact.file.workspaceRelativePath,
      checksum: `sha256:${await sha256Hex(read.content)}`,
      schema: read.artifact.schema,
      schemaVersion: read.artifact.schemaVersion,
    },
    bindings: read.artifact.bindings.map((binding) =>
      projectBindingForAgent(binding, sequenceIdByBinding.get(binding.id) ?? null)
    ),
    assemblyUses: assemblyUsesOfOligo(
      savedOligoSnapshot(read.artifact),
      dependencies.listDesigns()
    ).map(({ use, link, state, polymerase, sourceAttachment }) => ({
      designId: use.designId,
      designUri: designResourceUri(use.designId),
      designName: use.designName,
      designVersion: use.designVersion,
      primerId: use.primerId,
      primerName: use.primerName,
      partNumber: use.partNumber,
      direction: use.direction,
      bindingSequence: use.bindingSequence,
      tailSequence: use.tailSequence,
      tmC: use.tmC,
      tm: describeAssemblyTmContext(polymerase),
      sourceSite: use.sourceSite,
      state,
      linkedAtDesignVersion: link.linkedAtDesignVersion,
      linkedArtifactRevision: link.artifactRevision,
      sourceAttachment: sourceAttachment.kind,
    })),
    registry: {
      limsEntity: limsEntity
        ? {
            id: limsEntity.id,
            kind: limsEntity.kind,
            registrationStatus: limsEntity.registrationStatus,
            domainStatus: limsEntity.domainStatus,
            fields: limsEntity.fields,
          }
        : null,
      catalogFile: catalogFile
        ? {
            entityId: catalogFile.entity_id,
            path: catalogFile.path,
            relativePath: catalogFile.relative_path,
            fileKind: catalogFile.file_kind,
            status: catalogFile.status,
            contentHash: catalogFile.content_hash,
          }
        : null,
    },
  };
}

function projectBindingForAgent(
  binding: PrimerArtifactBindingV1 | null,
  sequenceId: number | null
) {
  if (!binding) return null;
  return {
    id: binding.id,
    relation: binding.relation,
    sequenceId,
    target: {
      documentId: binding.target.documentId,
      ...(binding.target.projectId ? { projectId: binding.target.projectId } : {}),
      topology: binding.target.topology,
      length: binding.target.length,
      fileContentHash: binding.target.fileContentHash,
      normalizedSequenceHash: binding.target.normalizedSequenceHash,
    },
    coordinates: binding.coordinates,
    source: binding.source,
    alignment: binding.alignment ?? null,
  };
}

function projectDesignProvenanceForAgent(provenance: PrimerDesignProvenanceV1 | undefined) {
  if (!provenance) return null;
  const { legacyWorkspaceRelativePath: _legacyMigrationInput, ...target } = provenance.target;
  return { ...provenance, target };
}

async function resolvePrimerTarget(
  folders: WorkspaceFolder[],
  inputDocumentId: string
): Promise<PrimerTargetSnapshot> {
  const documentId = normalizeSequenceDocumentId(inputDocumentId);
  const resolved = await resolveSequenceDocumentById(
    documentId,
    getUserFolders(folders).map((folder) => folder.path)
  );
  const folder = getUserFolders(folders).find(
    (candidate) => pathRelativeToBoundary(resolved.sourcePath, candidate.path) !== null
  );
  if (!folder) throw new Error('Primer target is outside the open user project.');
  const snapshot = await buildFileDnaSequenceSnapshot(resolved.sourcePath, {
    workspaceRoot: folder.path,
    documentId,
  });
  const ref = snapshot.ref;
  if (ref.sequenceId == null) throw new Error('Primer target has no stable sequence identity.');
  const relativePath = pathRelativeToBoundary(resolved.sourcePath, folder.path);
  if (!relativePath) throw new Error('Primer target must be a file inside the project.');
  const bases = snapshot.bases;
  if (bases.length !== ref.length) {
    throw new Error('Parsed primer target length did not match its stable sequence identity.');
  }
  return {
    documentId,
    projectId: (await resolveWorkspaceScope(folder.path)) ?? undefined,
    workspaceRoot: folder.path,
    absolutePath: resolved.sourcePath,
    workspaceRelativePath: relativePath,
    sequenceId: ref.sequenceId,
    bases,
    length: ref.length,
    topology: ref.topology,
    fileContentHash: ref.fileContentHash ?? ref.contentHash,
    normalizedSequenceHash: ref.normalizedSequenceHash ?? ref.contentHash,
  };
}

function pinDesignTarget(
  target: PrimerTargetSnapshot,
  coordinates: { start: number; end: number },
  wrapsOrigin: boolean
): StoredDesign['target'] {
  return {
    documentId: target.documentId,
    ...(target.projectId ? { projectId: target.projectId } : {}),
    workspaceRoot: target.workspaceRoot,
    absolutePath: target.absolutePath,
    workspaceRelativePath: target.workspaceRelativePath,
    sequenceId: target.sequenceId,
    length: target.length,
    topology: target.topology,
    fileContentHash: target.fileContentHash,
    normalizedSequenceHash: target.normalizedSequenceHash,
    start: coordinates.start,
    end: coordinates.end,
    wrapsOrigin,
  };
}

function assertBoundedPrimerTarget(targetLength: number): void {
  if (targetLength <= MAX_PRIMER3_TARGET_BP) return;
  throw new Error(
    `Primer target must fit inside the bounded ${MAX_PRIMER3_TEMPLATE_BP} bp Primer3 window with primer flanks.`
  );
}

function circularSlice(bases: string, start: number, length: number): string {
  const normalizedStart = modulo(start, bases.length);
  const end = normalizedStart + length;
  if (end <= bases.length) return bases.slice(normalizedStart, end);
  return bases.slice(normalizedStart) + bases.slice(0, end - bases.length);
}

function designRequest(
  input: z.infer<typeof designPrimersSchema>,
  prepared: PreparedDesignTemplate
): Primer3DesignRequest {
  const parameters = input.parameters;
  return {
    sequence: prepared.template,
    application: input.application,
    target_start: prepared.targetStart,
    target_length: prepared.targetLength,
    num_return: input.numReturn,
    primer_min_size: parameters?.primerMinSize,
    primer_opt_size: parameters?.primerOptSize,
    primer_max_size: parameters?.primerMaxSize,
    primer_min_tm: parameters?.primerMinTm,
    primer_opt_tm: parameters?.primerOptTm,
    primer_max_tm: parameters?.primerMaxTm,
    primer_min_gc: parameters?.primerMinGc,
    primer_max_gc: parameters?.primerMaxGc,
    product_min_size: parameters?.productMinSize,
    product_max_size: parameters?.productMaxSize,
  };
}

function designProvenance(
  design: StoredDesign,
  candidate: CandidateSnapshot,
  overhangSequence: string
): PrimerDesignProvenanceV1 {
  return {
    designId: design.designId,
    candidateId: candidate.candidateId,
    candidateRank: candidate.rank,
    role: candidate.role,
    pbsSequence: candidate.pbsSequence,
    overhangSequence,
    target: {
      documentId: design.target.documentId,
      ...(design.target.projectId ? { projectId: design.target.projectId } : {}),
      topology: design.target.topology,
      length: design.target.length,
      fileContentHash: design.target.fileContentHash,
      normalizedSequenceHash: design.target.normalizedSequenceHash,
      start: design.target.start,
      end: design.target.end,
      wrapsOrigin: design.target.wrapsOrigin,
    },
    primer3: {
      application: design.application,
      parameters: design.paramsUsed,
      warnings: design.warnings,
    },
    tm: {
      model: candidate.tm.model,
      source: candidate.tm.source,
      reason: candidate.tm.reason,
      valueC: candidate.tm.valueC,
      status: candidate.tm.status,
      provider: candidate.tm.provider,
    },
  };
}

function validateOrderedBounds(
  context: z.RefinementCtx,
  min: number | undefined,
  optimum: number | undefined,
  max: number | undefined,
  path: string,
  label: string
): void {
  const belowMin = min !== undefined && optimum !== undefined && optimum < min;
  const aboveMax = max !== undefined && optimum !== undefined && optimum > max;
  const inverted = min !== undefined && max !== undefined && min > max;
  if (!belowMin && !aboveMax && !inverted) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} bounds must satisfy min <= optimum <= max.`,
  });
}

function validateMinMax(
  context: z.RefinementCtx,
  min: number | undefined,
  max: number | undefined,
  path: string,
  label: string
): void {
  if (min === undefined || max === undefined || min <= max) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} minimum must not exceed its maximum.`,
  });
}

export async function assertTargetUnchanged(target: StoredDesign['target']): Promise<void> {
  const resolved = await resolveSequenceDocumentById(target.documentId, [target.workspaceRoot]);
  const current = await buildFileDnaSequenceRef(resolved.sourcePath, {
    workspaceRoot: target.workspaceRoot,
    documentId: target.documentId,
  });
  if (
    current.sequenceId !== target.sequenceId ||
    current.length !== target.length ||
    current.topology !== target.topology ||
    (current.fileContentHash ?? current.contentHash) !== target.fileContentHash ||
    (current.normalizedSequenceHash ?? current.contentHash) !== target.normalizedSequenceHash
  ) {
    throw new Error('Primer target changed after design; design again before saving.');
  }
}

function validateBindingCoordinates(
  target: PrimerTargetSnapshot,
  start: number,
  end: number
): void {
  if (start >= target.length || end > target.length) {
    throw new Error(`Binding coordinates exceed the ${target.length} bp target.`);
  }
  if (target.topology === 'linear' ? end <= start : end === start) {
    throw new Error('Binding coordinates must span at least one base.');
  }
}

function validateBindingHit(
  hit: BindingHitWire,
  primerLength: number,
  target: PrimerTargetSnapshot,
  maxMismatches: number
): void {
  validateBindingCoordinates(target, hit.start, hit.end);
  const spanLength =
    target.topology === 'circular' && hit.end < hit.start
      ? target.length - hit.start + hit.end
      : hit.end - hit.start;
  const invalidMismatchPosition = hit.mismatch_positions.some(
    (position) => position >= primerLength
  );
  if (
    spanLength !== primerLength ||
    invalidMismatchPosition ||
    hit.three_prime_match_length > primerLength ||
    hit.edit_distance > maxMismatches
  ) {
    throw new Error('Primer matcher returned invalid mismatch evidence.');
  }
}

export function workspaceRootForPrimer(
  folders: WorkspaceFolder[],
  primer: Primer,
  requestedWorkspace?: string
): string {
  const users = getUserFolders(folders);
  const selected = requestedWorkspace
    ? resolveExplicitProjectRoot(users, requestedWorkspace)
    : users.length === 1
      ? users[0]
      : undefined;
  if (!selected) {
    throw new Error(
      requestedWorkspace
        ? `Project not found or ambiguous: ${requestedWorkspace}`
        : 'Multiple projects are open; provide the project name.'
    );
  }
  if (primer.originDetails?.authority !== 'primer_artifact') {
    throw new Error('This primer is not backed by a canonical project artifact.');
  }
  return selected.path;
}

function selectWorkspaceRoot(folders: WorkspaceFolder[], requestedWorkspace?: string): string {
  const users = getUserFolders(folders);
  const selected = requestedWorkspace
    ? resolveExplicitProjectRoot(users, requestedWorkspace)
    : users.length === 1
      ? users[0]
      : undefined;
  if (!selected) {
    throw new Error(
      requestedWorkspace
        ? `Project not found or ambiguous: ${requestedWorkspace}`
        : users.length === 0
          ? 'No project is open.'
          : 'Multiple projects are open; provide the project name.'
    );
  }
  return selected.path;
}

function agentAnnealingSegment(sequence: string, length: number) {
  if (!Number.isInteger(length) || length < 1 || length > sequence.length)
    throw new Error('The annealing length must fit within the complete natural-base sequence.');
  return { pbsSequence: sequence.slice(-length), overhangSequence: sequence.slice(0, sequence.length - length) };
}

function parseAgentOligo(input: { vendor: 'idt'; orderType?: OligoOrderType; notation: string }): {
  sequence: string;
  composition: PrimerOligoCompositionV1 | null;
} {
  const parsed = parseIdtOligoNotation(input.notation, { orderType: input.orderType ?? 'dna' });
  if (parsed.errors.length > 0) throw new Error(parsed.errors.join(' '));
  return {
    sequence: parsed.bases,
    composition: parsed.composition,
  };
}

function projectPrimerMutation(saved: SavedPrimerArtifact) {
  return {
    changed: true,
    primerId: saved.artifact.id,
    artifactRevision: saved.artifact.artifactRevision,
    name: saved.artifact.name,
    sequence: saved.artifact.sequence,
    oligo: saved.artifact.oligo ?? null,
    idtNotation: saved.artifact.oligo?.notation ?? saved.artifact.sequence.bases,
    artifactPath: saved.artifact.file.workspaceRelativePath,
    registryEntityId: saved.limsEntity.id,
    bindingCount: saved.artifact.bindings.length,
    gitCommitted: saved.gitCommitted,
  };
}

function storeDesign(design: StoredDesign): void {
  for (const [id, stored] of designCache) {
    if (stored.expiresAt <= Date.now()) designCache.delete(id);
  }



  designCache.delete(design.designId);
  designCache.set(design.designId, design);
  while (designCache.size > DESIGN_CACHE_LIMIT) {
    const oldest = designCache.keys().next().value as string | undefined;
    if (!oldest) break;
    designCache.delete(oldest);
  }
}

function loadDesign(designId: string): StoredDesign | null {
  const design = designCache.get(designId);
  if (!design || design.expiresAt <= Date.now()) {
    designCache.delete(designId);
    return null;
  }
  return design;
}

function projectCandidate(candidate: CandidateSnapshot) {
  return {
    candidateId: candidate.candidateId,
    role: candidate.role,
    pbsSequence: candidate.pbsSequence,
    overhangSequence: candidate.overhangSequence,
    sequence: `${candidate.overhangSequence}${candidate.pbsSequence}`,
    binding: { ...candidate.binding, coordinateSystem: 'zero_based_half_open' },
    tm: candidate.tm,
    primer3TmC: candidate.primer3.tm,
    gcPercent: candidate.primer3.gc_percent,
    selfComplementarity: {
      anyTh: candidate.primer3.any_th,
      endTh: candidate.primer3.end_th,
      hairpinTh: candidate.primer3.hairpin_th,
    },
  };
}

function projectTarget(
  target: PrimerTargetSnapshot,
  coordinates: { start: number; end: number },
  wrapsOrigin: boolean
) {
  return {
    documentId: target.documentId,
    ...(target.projectId ? { projectId: target.projectId } : {}),
    sequenceId: target.sequenceId,
    length: target.length,
    topology: target.topology,
    fileContentHash: target.fileContentHash,
    normalizedSequenceHash: target.normalizedSequenceHash,
    start: coordinates.start,
    end: coordinates.end,
    wrapsOrigin,
    coordinateSystem: 'zero_based_half_open',
  };
}

function projectBindingHit(hit: BindingHitWire) {
  return {
    coordinateSystem: 'zero_based_half_open',
    start: hit.start,
    end: hit.end,
    strand: hit.strand,
    identity: hit.identity,
    editDistance: hit.edit_distance,
    mismatchPositions: hit.mismatch_positions,
    threePrimeMatchLength: hit.three_prime_match_length,
    effectiveTmC: hit.effective_tm,
  };
}

function alignmentFromHit(hit: BindingHitWire): NonNullable<PrimerArtifactBindingV1['alignment']> {
  return {
    identity: hit.identity,
    editDistance: hit.edit_distance,
    mismatchPositions: hit.mismatch_positions,
    threePrimeMatchLength: hit.three_prime_match_length,
    effectiveTmC: hit.effective_tm,
  };
}

function artifactApplication(application: z.infer<typeof applicationSchema>) {
  if (application === 'pcr' || application === 'sequencing') return application;
  if (application === 'sdm') return 'mutagenesis' as const;
  if (application === 'gibson' || application === 'golden_gate' || application === 're_cloning') {
    return 'cloning' as const;
  }
  return 'pcr' as const;
}

function mutationFailure(error: unknown, effects = new DesignToolEffects()) {
  if (error instanceof PrimerArtifactRevisionError) {
    effects.unchanged();
    return designToolFailure(
      error.code,
      {
        changed: false,
        code: error.code,
        message: error.message,
        expectedArtifactRevision: error.expectedRevision,
        actualArtifactRevision: error.actualRevision,
      },
      effects
    );
  }
  if (error instanceof PrimerProjectionError || error instanceof PrimerHistoryError) {
    effects.changed({ kind: 'primer-artifact-saved', path: error.artifactPath });
    return designToolFailure(
      error.code,
      {
        changed: false,
        code: error.code,
        message: error.message,
        recoveryRequired: true,
        artifactPath: error.artifactPath,
      },
      effects
    );
  }
  return designToolFailure(
    'PRIMER_MUTATION_FAILED',
    { changed: false, message: error instanceof Error ? error.message : String(error) },
    effects
  );
}

function failure(code: string, error: unknown) {
  return designToolFailure(code, {
    changed: false,
    code,
    message: error instanceof Error ? error.message : String(error),
  });
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
