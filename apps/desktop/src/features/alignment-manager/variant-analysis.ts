import { savedNgsReadEvidenceSchema } from './ngs-read-evidence';
import { z } from 'zod';
import {
  classifyMutation,
  resolveSequenceGeneticCode,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import {
  sequenceVariantCallsRouteTilesVariantsSequenceCallsPost,
  type SequenceVariantCall,
  type VariantSourceResult,
} from '@waypoint/api-client';
import { createEntityReference, getEntityReference } from '../../db/entity-references';
import { getCurrentWorkspaceScope } from '../../stores/workspaceStore';
import { useCanvasStore } from '../canvas/public/store';
import { sha256Hex } from '../structure-drawer/public/api/protein-identity';
import { inspectMutationProtein } from './inspect-mutation-protein';
import { toMutationEffect } from './utils/mutation-computation';
import { buildMutationProteinContext } from './utils/mutation-protein-context';
import {
  startVariantSourceOperation,
  waitForVariantSourceResult,
} from '../sequence/public/variant-source-operation-client';
import { clearStructureInspection } from '../structure-drawer/public/structure-inspection';
import { primerBindingToViewState } from '../sequence/public/primer-binding-viewstate';
import type { Mutation } from './types';

export const callSchema: z.ZodType<SequenceVariantCall> = z
  .object({
    id: z.string(),
    position: z.number().int().positive(),
    reference: z.string(),
    alternate: z.string(),
    allele_index: z.number().int().positive(),
    quality: z.number().nullable(),
    filters: z.array(z.string()),
    genotype: z.string().nullable(),
    reference_count: z.number().int().nonnegative().nullable().optional(),
    alternate_count: z.number().int().nonnegative().nullable().optional(),
    total_allele_count: z.number().int().nonnegative().nullable().optional(),
    allele_fraction: z.number().min(0).max(1).nullable().optional(),
    unsupported_reason: z.string().nullable().optional(),
  })
  .strict();
export const variantAnalysisSchema = z
  .object({
    kind: z.literal('sequence-variant-analysis'),
    version: z.literal(1),
    documentId: z.string(),
    name: z.string(),
    sourceLabel: z.string(),
    sourceIdentity: z.string(),
    referenceSha256: z.string(),
    chrom: z.string(),
    sample: z.string(),
    countBasis: z.string(),
    calls: z.array(callSchema).max(5000),
    createdAt: z.number(),
    readEvidence: savedNgsReadEvidenceSchema.optional(),
  })
  .strict();
export type VariantAnalysis = z.infer<typeof variantAnalysisSchema>;

export async function prepareSequenceVariantSource(
  path: string,
  chrom: string,
  sequenceLength: number
): Promise<VariantSourceResult> {
  const operation = await startVariantSourceOperation({
    variantPath: path,
    references: [{ name: chrom, length: sequenceLength }],
  });
  return waitForVariantSourceResult(operation.id);
}

export async function importSequenceVariantAnalysis(input: {
  documentId: string;
  sequence: AnnotatedSequence;
  source: VariantSourceResult;
  chrom: string;
  sample: string;
  name: string;
}) {
  const response = await sequenceVariantCallsRouteTilesVariantsSequenceCallsPost({
    source: input.source,
    sequence: input.sequence.sequence,
    chrom: input.chrom,
    sample: input.sample,
  });
  if (response.status !== 200)
    throw new Error('The variant calls could not be matched to this reference.');
  const result = response.data;
  const data = variantAnalysisSchema.parse({
    kind: 'sequence-variant-analysis',
    version: 1,
    documentId: input.documentId,
    name: input.name,
    sourceLabel: input.source.label,
    sourceIdentity: result.source_identity,
    referenceSha256: result.reference_sha256,
    chrom: result.chrom,
    sample: result.sample,
    countBasis: result.count_basis,
    calls: result.calls,
    createdAt: Date.now(),
  });
  return persistVariantAnalysis(data);
}

export async function persistVariantAnalysis(data: VariantAnalysis, id?: string) {
  data = variantAnalysisSchema.parse(data);

  if (id) {
    const existing = await getEntityReference(id);
    if (existing) {
      const saved = await loadVariantAnalysis(id);
      if (saved.documentId !== data.documentId || saved.sourceIdentity !== data.sourceIdentity)
        throw new Error('This analysis identity belongs to different evidence.');
      activateVariantAnalysis(data.documentId, id);
      return { analysisId: id, data: saved };
    }
  }
  let reference;
  try {
    reference = await createEntityReference(
      {
        entityType: 'variant-analysis',
        displayLabel: data.name,
        locator: `entity://variant-analysis/${id ?? crypto.randomUUID()}`,
        data,
        deepLinkParams: null,
        workspaceScope: getCurrentWorkspaceScope(),
        workspaceRootPath: null,
        source: 'sequence-analysis',
      },
      id ? { id } : {}
    );
  } catch (error) {
    if (id && (await getEntityReference(id))) {
      const saved = await loadVariantAnalysis(id);
      if (saved.documentId === data.documentId && saved.sourceIdentity === data.sourceIdentity) {
        activateVariantAnalysis(data.documentId, id);
        return { analysisId: id, data: saved };
      }
    }
    throw error;
  }
  activateVariantAnalysis(data.documentId, reference.id);
  return { analysisId: reference.id, data };
}

export class VariantAnalysisNotFoundError extends Error {
  constructor(analysisId: string) {
    super(
      `No saved variant analysis exists with identifier ${analysisId}. Read the available evidence again and use its exact analysisId and returned inspection arguments.`
    );
    this.name = 'VariantAnalysisNotFoundError';
  }
}

export async function loadVariantAnalysis(analysisId: string): Promise<VariantAnalysis> {
  const row = await getEntityReference(analysisId);
  if (!row || row.entity_type !== 'variant-analysis')
    throw new VariantAnalysisNotFoundError(analysisId);
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return variantAnalysisSchema.parse(data);
}

export function activateVariantAnalysis(documentId: string, analysisId: string) {
  const canvas = useCanvasStore.getState();
  const found = canvas.findTab('sequence', documentId);
  if (!found) throw new Error('Open the source sequence to review these variant calls.');
  const tab = canvas.panels[found.panelId].tabs.find((tab) => tab.id === found.tabId)!;
  const old = tab.viewState?.variantAnalysisIds;
  const ids = Array.isArray(old) ? old.filter((id): id is string => typeof id === 'string') : [];
  canvas.setTabViewState(found.panelId, found.tabId, {
    variantAnalysisId: analysisId,
    variantAnalysisIds: [...new Set([...ids, analysisId])],
    alignmentReviewRequestId: crypto.randomUUID(),
  });
}

export function variantCallMutation(
  call: SequenceVariantCall,
  sequence: AnnotatedSequence
): Mutation {
  if (call.unsupported_reason) throw new Error(call.unsupported_reason);
  let reference = call.reference,
    alternate = call.alternate,
    position = call.position;
  if (
    sequence.sequence.slice(position - 1, position - 1 + reference.length).toUpperCase() !==
    reference.toUpperCase()
  )
    throw new Error('The reference DNA no longer matches this call.');
  while (reference.length && alternate.length && reference[0] === alternate[0]) {
    reference = reference.slice(1);
    alternate = alternate.slice(1);
    position++;
  }
  while (
    reference.length &&
    alternate.length &&
    reference[reference.length - 1] === alternate[alternate.length - 1]
  ) {
    reference = reference.slice(0, -1);
    alternate = alternate.slice(0, -1);
  }
  if (!reference && !alternate) throw new Error('This record does not change the reference.');
  const type = !reference ? 'insertion' : !alternate ? 'deletion' : 'substitution';
  const mutation: Mutation = {
    id: call.id,
    position: type === 'insertion' ? position - 1 : position,
    type,
    referenceBase: reference,
    alternateBase: alternate,
    length: Math.max(reference.length, alternate.length),
  };

  if (reference.length === alternate.length) {
    const query =
      sequence.sequence.slice(0, position - 1) +
      alternate +
      sequence.sequence.slice(position - 1 + reference.length);
    const geneticCode = resolveSequenceGeneticCode(sequence);
    const impact = classifyMutation(
      { type, position, ref_base: reference, query_base: alternate, length: mutation.length },
      sequence.sequence,
      query,
      sequence.annotations ?? [],
      geneticCode.code
    );
    mutation.effect = toMutationEffect(impact, type);
  }
  return mutation;
}

export function inspectVariantAnalysisCall(
  analysis: VariantAnalysis,
  sequence: AnnotatedSequence,
  callId: string
): string | undefined {
  try {
    if (sha256Hex(sequence.sequence.toUpperCase()) !== analysis.referenceSha256)
      throw new Error(
        'The reference changed since these calls were imported. Import them again before mapping proteins.'
      );
    const call = analysis.calls.find((call) => call.id === callId);
    if (!call) throw new Error('This variant does not belong to the saved analysis.');
    const mutation = variantCallMutation(call, sequence);
    const canvas = useCanvasStore.getState();
    const tab = canvas.findTab('sequence', analysis.documentId);
    if (tab)
      canvas.setTabViewState(tab.panelId, tab.tabId, {
        variantSelectedCallId: callId,
        ...primerBindingToViewState(call.position, call.position + call.reference.length - 1),
        sequenceNavigationRequestId: crypto.randomUUID(),
      });
    return inspectMutationProtein({
      documentId: analysis.documentId,
      sequence,
      mutation,
      track: {
        id: analysis.sourceIdentity,
        label: `${analysis.name} · ${analysis.sample.split(/[\\/]/).pop()}`,
      },
    });
  } catch (error) {
    clearStructureInspection(
      analysis.documentId,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

export function describeVariantCalls(
  analysis: VariantAnalysis,
  sequence: AnnotatedSequence,
  calls: ReadonlyArray<SequenceVariantCall>,
  analysisId?: string
) {
  const stale = sha256Hex(sequence.sequence.toUpperCase()) !== analysis.referenceSha256;
  return calls.map((call) => {
    try {
      if (stale)
        throw new Error(
          'The reference changed since these calls were imported. Import them again before mapping proteins.'
        );
      const context = buildMutationProteinContext({
        sequence,
        documentId: analysis.documentId,
        mutation: variantCallMutation(call, sequence),
        trackId: analysis.sourceIdentity,
        trackLabel: analysis.name,
      });
      if (!context.ok) throw new Error(context.reason);
      const { request } = context;
      const variant = request.variantContext!;
      return {
        ...call,
        ...(analysisId
          ? {
              inspection: {
                tool: 'inspect_variant_call',
                arguments: { analysisId, callId: call.id },
              },
            }
          : {}),
        proteinContext: {
          status: 'mapped' as const,
          basis: 'current coding annotation',
          moleculeId: request.residueMolecule?.moleculeId,
          label: request.cdsLabel,
          proteinSequenceSha256: sha256Hex(request.translation),
          proteinLength: request.translation.length,
          residues: variant.residueIndices.map((index) => index + 1),
          effect: variant.proteinEffect,
          changes: variant.changes,
          affectedTail: variant.affectedTail,
        },
      };
    } catch (error) {
      return {
        ...call,
        proteinContext: {
          status: 'unavailable' as const,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}
