import { z } from 'zod';
import type { DBCatalogEntityFile } from '../../db/workspace-catalog';
import { getCurrentCatalogFileForEntity } from '../../db/workspace-catalog';
import type { LimsEntity } from '../../shared/lims';
import { queryLimsEntities } from '../lims/public/operations';
import { resolveSidecarBaseUrl } from '../../services/sidecar-session';
import { configureRendererSidecarApiClient } from '../../services/sidecar-session';
import { bindPrimerApiToolsPrimersBindPost, designPrimers, isApiError } from '@waypoint/api-client';
import { notifyPrimerBindingsChanged } from './primer-binding-events';
import {
  attachPrimerArtifact,
  persistOwnedPrimerArtifactBindings,
  readSavedPrimerBindingTarget,
  detachPrimerArtifact,
  deletePrimerArtifact,
  readPrimerArtifactForPrimer,
  readPrimerArtifactAtPath,
  resumePrimerArtifactSave,
  savePrimerArtifact,
  updatePrimerArtifactContent,
  updatePrimerArtifactBinding,
  writeAndProjectPrimerArtifact,
  type AttachPrimerArtifactInput,
  type DetachPrimerArtifactInput,
  type DeletePrimerArtifactInput,
  type FileAuthoritativePrimerInput,
  type PrimerArtifactBindingMutationResult,
  type PrimerMutationOptions,
  type ReadPrimerArtifactResult,
  type UpdatePrimerArtifactContentInput,
  type SavedPrimerArtifact,
  type UpdatePrimerArtifactBindingInput,
  type WriteAndProjectedPrimerArtifact,
} from './primer-artifact-service';
import {
  createBinding,
  persistOwnedPrimerBinding,
  deleteBinding,
  deletePrimer,
  getPrimerById,
  listBoundPrimers,
  searchPrimers,
  updatePrimer,
} from './primer-service';
import {
  findBindingCandidates,
  searchLibraryPrimerBindings,
  type LibraryPrimerBindingSearchOptions,
  type BindingHit,
  type PrimerSearchResult,
  type SearchOptions,
} from './primer-search-service';
import { primerTmCalculationService, type PrimerTmCalculationService } from './primer-tm-service';
import type {
  BoundPrimer,
  CreateBindingInput,
  DeleteResult,
  Primer,
  PrimerBinding,
  SearchPrimersInput,
  UpdatePrimerInput,
} from './types';

export type { PrimerTmCalculationService } from './primer-tm-service';

const PRIMER_SIDECAR_TIMEOUT_MS = 30_000;
const MAX_PRIMER3_TEMPLATE_BP = 50_000;
const MAX_PRIMER_SIZE_BP = 50;

const primerDesignApplicationSchema = z.enum([
  'pcr',
  'sequencing',
  'qpcr',
  'colony_pcr',
  'gibson',
  'golden_gate',
  'sdm',
  're_cloning',
]);

export type PrimerDesignApplication = z.infer<typeof primerDesignApplicationSchema>;

export interface PrimerCandidateSearchRequest {
  sequence: string;
  application: PrimerDesignApplication;
  target_start: number;
  target_length: number;
  num_return: number;
  primer_min_size?: number;
  primer_opt_size?: number;
  primer_max_size?: number;
  primer_min_tm?: number;
  primer_opt_tm?: number;
  primer_max_tm?: number;
  primer_min_gc?: number;
  primer_max_gc?: number;
  product_min_size?: number;
  product_max_size?: number;
}

export interface Primer3OligoResult {
  sequence: string;
  start: number;
  length: number;
  tm: number;
  gc_percent: number;
  any_th: number;
  end_th: number;
  hairpin_th: number;
}

export interface PrimerCandidateSearchResult {
  success: boolean;
  message: string;
  application: PrimerDesignApplication;
  primer_pairs: Array<{
    forward: Primer3OligoResult;
    reverse: Primer3OligoResult;
    product_size: number;
    pair_any_th: number;
    pair_end_th: number;
    penalty: number;
  }>;
  warnings: string[];
  sequence_length: number;
  target_region: [number, number] | null;
  params_used: Record<string, string | number | boolean | null>;
}

export interface PrimerBindingTarget {
  bases: string;
  topology: 'linear' | 'circular';
}

export interface PrimerCandidateSearchService {
  search(
    request: PrimerCandidateSearchRequest,
    options?: { signal?: AbortSignal }
  ): Promise<PrimerCandidateSearchResult>;
}

export interface PrimerBindingSearchService {
  match(
    primer: string,
    target: PrimerBindingTarget,
    maxMismatches: number,
    options?: { signal?: AbortSignal }
  ): Promise<BindingHit[]>;
  findLibrary(options: SearchOptions): Promise<PrimerSearchResult[]>;

  findLibraryOnTarget(options: LibraryPrimerBindingSearchOptions): Promise<PrimerSearchResult[]>;
}

export interface PrimerPersistenceService {
  readSavedTarget: typeof readSavedPrimerBindingTarget;
  persistOwnedArtifactBindings: typeof persistOwnedPrimerArtifactBindings;
  persistOwnedLegacyBinding: typeof persistOwnedPrimerBinding;
  deleteArtifact(input: DeletePrimerArtifactInput): ReturnType<typeof deletePrimerArtifact>;
  saveArtifact(
    input: FileAuthoritativePrimerInput,
    options?: PrimerMutationOptions
  ): Promise<SavedPrimerArtifact>;
  writeAndProjectArtifact(
    input: FileAuthoritativePrimerInput,
    options?: PrimerMutationOptions
  ): Promise<WriteAndProjectedPrimerArtifact>;
  readArtifact(primer: Primer, workspaceRoot: string): Promise<ReadPrimerArtifactResult>;
  readArtifactAtPath(
    artifactPath: string,
    workspaceRoot: string
  ): Promise<ReadPrimerArtifactResult>;
  updateArtifactContent(input: UpdatePrimerArtifactContentInput): Promise<SavedPrimerArtifact>;
  resumeArtifactSave(input: {
    entityId: string;
    operationId: string;
    workspaceRoot: string;
  }): Promise<SavedPrimerArtifact>;
  attachBinding(
    input: AttachPrimerArtifactInput,
    options?: PrimerMutationOptions
  ): Promise<PrimerArtifactBindingMutationResult>;
  updateBinding(
    input: UpdatePrimerArtifactBindingInput,
    options?: PrimerMutationOptions
  ): Promise<PrimerArtifactBindingMutationResult>;
  detachBinding(
    input: DetachPrimerArtifactInput,
    options?: PrimerMutationOptions
  ): Promise<SavedPrimerArtifact>;
  getPrimer(id: string): Promise<Primer | null>;
  getCatalogFile(primerId: string): Promise<DBCatalogEntityFile | null>;
  getLimsEntity(primerId: string): Promise<LimsEntity | null>;
  notifyBindingsChanged(sequenceId: number): void;
  updateLegacyPrimer(input: UpdatePrimerInput): Promise<Primer | null>;
  searchLegacyPrimers(input: SearchPrimersInput): Promise<Primer[]>;
  deleteLegacyPrimer(id: string): Promise<DeleteResult>;
  createLegacyBinding(input: CreateBindingInput): Promise<PrimerBinding>;
  deleteLegacyBinding(bindingId: string): Promise<void>;
  listLegacyBoundPrimers(sequenceId: number): Promise<BoundPrimer[]>;
}

export interface PrimerServices {
  candidateSearch: PrimerCandidateSearchService;
  tmCalculation: PrimerTmCalculationService;
  bindingSearch: PrimerBindingSearchService;
  persistence: PrimerPersistenceService;
}

const primer3OligoSchema = z
  .object({
    sequence: z.string().regex(/^[ACGTN]+$/i),
    start: z.number().int().nonnegative(),
    length: z.number().int().positive().max(MAX_PRIMER_SIZE_BP),
    tm: z.number().finite(),
    gc_percent: z.number().min(0).max(100),
    any_th: z.number().finite(),
    end_th: z.number().finite(),
    hairpin_th: z.number().finite(),
  })
  .strict();

export const primerCandidateSearchResultSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    application: primerDesignApplicationSchema,
    primer_pairs: z
      .array(
        z
          .object({
            forward: primer3OligoSchema,
            reverse: primer3OligoSchema,
            product_size: z.number().int().positive().max(MAX_PRIMER3_TEMPLATE_BP),
            pair_any_th: z.number().finite(),
            pair_end_th: z.number().finite(),
            penalty: z.number().finite(),
          })
          .strict()
      )
      .max(10),
    warnings: z.array(z.string()),
    sequence_length: z.number().int().positive().max(MAX_PRIMER3_TEMPLATE_BP),
    target_region: z
      .tuple([z.number().int().nonnegative(), z.number().int().positive()])
      .nullable(),
    params_used: z.record(
      z.string(),
      z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
    ),
  })
  .strict();

const bindingHitSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    strand: z.union([z.literal(1), z.literal(-1)]),
    identity: z.number().min(0).max(1),
    edit_distance: z.number().int().nonnegative(),
    mismatch_positions: z.array(z.number().int().nonnegative()),
    three_prime_match_length: z.number().int().nonnegative(),
    effective_tm: z.number().finite(),
  })
  .strict();

const primerBindingResponseSchema = z.object({ hits: z.array(bindingHitSchema) }).strict();

async function primerSidecarRequest(
  toolName: string,
  request: (options: RequestInit) => Promise<{ data: unknown }>,
  upstreamSignal?: AbortSignal
): Promise<unknown> {
  const baseUrl = await resolveSidecarBaseUrl(toolName);
  configureRendererSidecarApiClient(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRIMER_SIDECAR_TIMEOUT_MS);
  const abort = () => controller.abort();
  upstreamSignal?.addEventListener('abort', abort, { once: true });
  if (upstreamSignal?.aborted) controller.abort();
  try {
    const response = await request({ signal: controller.signal });
    return response.data;
  } catch (error) {
    if (controller.signal.aborted && !upstreamSignal?.aborted) {
      throw new Error(
        `Sidecar request timed out after ${PRIMER_SIDECAR_TIMEOUT_MS / 1000} seconds.`
      );
    }
    if (isApiError(error)) {
      const detail = error.detail ?? error.bodyPreview;
      throw new Error(`Sidecar returned HTTP ${error.status}${detail ? `: ${detail}` : ''}.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', abort);
  }
}

const candidateSearch: PrimerCandidateSearchService = {
  async search(request, options = {}): Promise<PrimerCandidateSearchResult> {
    const response = await primerSidecarRequest(
      'design_primers',
      (requestOptions) => designPrimers(request, requestOptions),
      options.signal
    );
    return primerCandidateSearchResultSchema.parse(response) as PrimerCandidateSearchResult;
  },
};

const bindingSearch: PrimerBindingSearchService = {
  async match(primer, target, maxMismatches, options = {}): Promise<BindingHit[]> {
    const response = await primerSidecarRequest(
      'primer_binding',
      (requestOptions) =>
        bindPrimerApiToolsPrimersBindPost(
          {
            primer,
            sequence: target.bases,
            max_edit_distance: maxMismatches,
            circular: target.topology === 'circular',
          },
          requestOptions
        ),
      options.signal
    );
    return primerBindingResponseSchema.parse(response).hits.map((hit) => ({
      start: hit.start,
      end: hit.end,
      strand: hit.strand,
      identity: hit.identity,
      editDistance: hit.edit_distance,
      mismatchPositions: hit.mismatch_positions,
      threePrimeMatchLength: hit.three_prime_match_length,
      effectiveTm: hit.effective_tm,
    }));
  },

  findLibrary: findBindingCandidates,
  findLibraryOnTarget: searchLibraryPrimerBindings,
};

const persistence: PrimerPersistenceService = {
  readSavedTarget: readSavedPrimerBindingTarget,
  persistOwnedArtifactBindings: persistOwnedPrimerArtifactBindings,
  persistOwnedLegacyBinding: persistOwnedPrimerBinding,
  deleteArtifact: deletePrimerArtifact,
  saveArtifact: savePrimerArtifact,
  writeAndProjectArtifact: writeAndProjectPrimerArtifact,
  readArtifact: readPrimerArtifactForPrimer,
  readArtifactAtPath: (artifactPath, workspaceRoot) =>
    readPrimerArtifactAtPath(artifactPath, workspaceRoot, { bindingResolution: 'projected' }),
  updateArtifactContent: updatePrimerArtifactContent,
  resumeArtifactSave: resumePrimerArtifactSave,
  attachBinding: attachPrimerArtifact,
  updateBinding: updatePrimerArtifactBinding,
  detachBinding: detachPrimerArtifact,
  getPrimer: getPrimerById,
  getCatalogFile: getCurrentCatalogFileForEntity,
  getLimsEntity: async (primerId) =>
    (await queryLimsEntities({ id: primerId, includeArchived: true, limit: 1 }))[0] ?? null,
  notifyBindingsChanged: notifyPrimerBindingsChanged,
  updateLegacyPrimer: updatePrimer,
  searchLegacyPrimers: searchPrimers,
  deleteLegacyPrimer: deletePrimer,
  createLegacyBinding: createBinding,
  deleteLegacyBinding: deleteBinding,
  listLegacyBoundPrimers: listBoundPrimers,
};

export const primerServices: PrimerServices = {
  candidateSearch,
  tmCalculation: primerTmCalculationService,
  bindingSearch,
  persistence,
};

export const manualPrimerCreationServices: Readonly<Pick<PrimerServices, 'tmCalculation'>> = {
  tmCalculation: primerServices.tmCalculation,
};
