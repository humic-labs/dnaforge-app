import { z } from 'zod';
import { isApiError } from '@waypoint/api-client';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { platform } from '../../../platform';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import { managedOperations } from '../../../services/managed-operations';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  getUserFolders,
  loadSequenceDocumentBiologyFile,
  resolveMultiRootPath,
} from './path-utils';
import { openTabInCanvas } from './open-tab';
import {
  importNgsReadAnalysis,
  retainNgsReadOperation,
} from '../../alignment-manager/public/ngs-read-analysis';
import { useSequenceStore } from '../../sequence/public/store';
import { useCanvasStore } from '../../canvas/public/store';
import { describeVariantCalls } from '../../alignment-manager/public/variant-analysis';
const NGS_ANALYSIS_PREVIEW_CALLS = 25;

export const analyzeNgsReadsSchema = z
  .object({
    documentId: z.string().min(1),
    path: z
      .string()
      .min(1)
      .describe(
        'Raw FASTQ reads inside an open project, plain or gzip compressed. VCF/BCF already contain called variants: use start_variant_calls and import_variant_calls for them. A filename mentioning reads or .fastq does not make VCF content raw reads.'
      ),
    name: z.string().min(1).max(200),
    preset: z
      .enum(['sr', 'map-ont', 'lr:hq', 'map-hifi'])
      .describe(
        'Explicit minimap2 preset: sr for short reads, map-ont for Nanopore, lr:hq for high-accuracy long reads, map-hifi for PacBio HiFi. Inspect original headers and read length/quality distributions with your own script before selecting. A filename or read length alone does not establish sequencing technology. If technology is unknown, describe and retain the selected preset as an exploratory assumption.'
      ),
    minBaseQuality: z.number().int().min(0).max(60).default(20),
    minMappingQuality: z.number().int().min(0).max(60).default(20),
    minDepth: z.number().int().positive().default(10),
    minAlternateCount: z.number().int().positive().default(3),
    minAlleleFraction: z.number().min(0).max(1).default(0.02),
  })
  .strict();
const failure = (error: unknown) =>
  toolFailure({
    code: 'NGS_ANALYSIS_FAILED',
    error: error instanceof Error ? error.message : String(error),
    retriable: false,
    stateChanged: 'unknown',
    partialEffects: [],
  });
export const ANALYZE_NGS_READS_DESCRIPTION =
  'Align raw FASTQ reads, plain or gzip compressed, against an imported small reference (up to 250 kb, 100,000 reads/500 million bases). For VCF/BCF called variants use start_variant_calls then import_variant_calls; for assembled clone sequences use analyze_clone. Uses real minimap2 and bcftools pileup, preserves every read in accounting, reference topology, exact thresholds, coverage and source hashes. Inspect original read metadata, lengths and quality before selecting a preset; if technology is unknown, retain the choice as an exploratory assumption. Returns a job identity promptly and a complete get_ngs_analysis continuation. Copy continuation.arguments exactly, including documentId, operationId and name, to observe the job and open its completed candidate review. Requires installed minimap2, samtools and bcftools.';
export function createAnalyzeNgsReadsTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: ANALYZE_NGS_READS_DESCRIPTION,
    inputSchema: analyzeNgsReadsSchema,
    execute: async ({ documentId, path, name, preset, ...settings }) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(documentId, folders),
          resolved = resolveMultiRootPath(getUserFolders(folders), path);
        const [source, root] = await Promise.all([
          platform().fs.stat(resolved.absolutePath),
          platform().fs.stat(resolved.folder.path),
        ]);
        if (!source.isFile || !isPathInsideBoundary(source.canonicalPath, root.canonicalPath))
          throw new Error('The raw reads must be inside their open project.');
        const sequence =
          useSequenceStore.getState().getSequence(loaded.documentId) ?? loaded.biology.sequence;
        return toolSuccess({
          documentId: loaded.documentId,
          name,
          input: {
            documentId: loaded.documentId,
            readPath: source.canonicalPath,
            referenceSequence: sequence.sequence,
            isCircular: !!sequence.circular,
            preset,
            threads: 2,
            ...settings,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}
export const getNgsAnalysisSchema = z
  .object({
    documentId: z.string().min(1),
    operationId: z
      .string()
      .min(1)
      .describe(
        'Copy the exact opaque operationId returned by analyze_ngs_reads. Do not reconstruct, edit or substitute a document, MCP job or analysis identity.'
      ),
    name: z.string().min(1).max(200),
  })
  .strict();
export const GET_NGS_ANALYSIS_DESCRIPTION =
  'Observe the durable raw-read job and open its review beside the source reference. Copy the complete continuation.arguments from analyze_ngs_reads, including documentId, operationId and name; operationId alone is incomplete. An unknown identity is a lookup refusal, not evidence that the admitted analysis failed. When complete, persists read accounting, coverage, exact parameters and hashes plus candidate alleles. Each returned call includes proteinContext from current coding annotations: mapped reports the protein and single-allele consequence and includes complete inspection.arguments for inspect_variant_call, unavailable explains the limitation. Copy those arguments exactly. This does not establish available structure coordinates. Returns analysisId, a bounded first page and explicit continuation arguments for get_variant_analysis pagination. For a requested DNA position, call get_variant_analysis with start and end both equal to that position; do not parse a spilled result file with shell tools. All calls remain available through native pagination; color_variant_protein uses that exact analysisId. Failed/incomplete jobs are not evidence.';

function operationLookupFailure(error: unknown, operationId: string, documentId: string) {


  const payload = isApiError(error) ? error.body : error;
  const detail =
    payload && typeof payload === 'object' && 'detail' in payload ? payload.detail : undefined;
  const typed = detail && typeof detail === 'object' ? detail : undefined;
  const code =
    typed && 'code' in typed && typeof typed.code === 'string'
      ? typed.code
      : 'NGS_OPERATION_LOOKUP_FAILED';
  const message =
    typed && 'message' in typed && typeof typed.message === 'string'
      ? typed.message
      : error instanceof Error
        ? error.message
        : typeof detail === 'string'
          ? detail
          : 'The raw-read job could not be observed.';
  const recoveryActions: Array<{
    tool: 'get_ngs_analysis';
    arguments: { documentId: string; operationId: string; name: string };
  }> = [];
  if (code === 'OPERATION_NOT_FOUND') {
    const seen = new Set<string>();


    for (const panel of Object.values(useCanvasStore.getState().panels)) {
      for (const tab of panel.tabs) {
        if (tab.type !== 'sequence' || tab.entityId !== documentId) continue;
        const retained = tab.viewState?.ngsReadOperation as
          | { operationId?: unknown; name?: unknown }
          | undefined;
        if (
          typeof retained?.operationId !== 'string' ||
          !retained.operationId ||
          retained.operationId === operationId ||
          seen.has(retained.operationId) ||
          typeof retained.name !== 'string' ||
          !retained.name
        )
          continue;
        seen.add(retained.operationId);
        recoveryActions.push({
          tool: 'get_ngs_analysis',
          arguments: { documentId, operationId: retained.operationId, name: retained.name },
        });
      }
    }
  }
  return toolFailure({
    code,
    error:
      code === 'OPERATION_NOT_FOUND'
        ? `${message}. Copy the exact operationId returned by analyze_ngs_reads; this lookup does not establish that the analysis failed.${recoveryActions.length ? ' The reference already retains an admitted job: copy its complete recoveryActions arguments to observe it. Do not resubmit the analysis to repair an identity typo.' : ''}`
        : message,
    retriable: false,
    stateChanged: false,
    partialEffects: [],
    details: { operationId, ...(recoveryActions.length ? { recoveryActions } : {}) },
  });
}

export function createGetNgsAnalysisTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: GET_NGS_ANALYSIS_DESCRIPTION,
    inputSchema: getNgsAnalysisSchema,
    execute: async ({ documentId, operationId, name }) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
        let operation: Awaited<ReturnType<typeof managedOperations.getOperation>>;
        try {
          operation = await managedOperations.getOperation(operationId);
        } catch (error) {


          return operationLookupFailure(error, operationId, loaded.documentId);
        }
        if (operation.kind !== 'ngs-read-analysis')
          throw new Error('This job did not analyze raw reads.');
        const opened = await openTabInCanvas(
          {
            type: 'sequence',
            entityId: loaded.documentId,
            label: loaded.name ?? 'Raw-read review',
          },
          folders
        );
        if (opened.error) throw new Error(opened.error);
        retainNgsReadOperation(loaded.documentId, operationId, name);
        if (operation.state !== 'succeeded')
          return toolSuccess({ operationId, status: operation.state, error: operation.error });
        const sequence =
          useSequenceStore.getState().getSequence(loaded.documentId) ?? loaded.biology.sequence;
        const result = await importNgsReadAnalysis(operationId, loaded.documentId, sequence, name),
          evidence = result.data.readEvidence!;
        return toolSuccess({
          operationId,
          status: 'imported',
          analysisId: result.analysisId,
          sourceSha256: evidence.sourceSha256,
          referenceSha256: evidence.referenceSha256,
          totalReads: evidence.totalReads,
          totalBases: evidence.totalBases,
          mappedReads: evidence.mappedReads,
          unmappedReads: evidence.unmappedReads,
          mappingQualityReads: evidence.mappingQualityReads,
          uncoveredBases: evidence.coverage.filter((depth) => !depth).length,
          circularMethod: evidence.circularMethod,
          versions: evidence.versions,
          callCount: result.data.calls.length,
          calls: describeVariantCalls(
            result.data,
            sequence,
            result.data.calls.slice(0, NGS_ANALYSIS_PREVIEW_CALLS),
            result.analysisId
          ),
          nextOffset: result.data.calls.length > NGS_ANALYSIS_PREVIEW_CALLS ? NGS_ANALYSIS_PREVIEW_CALLS : null,
          continuationTool: 'get_variant_analysis',
          ...(result.data.calls.length > NGS_ANALYSIS_PREVIEW_CALLS
            ? {
                continuation: {
                  tool: 'get_variant_analysis',
                  arguments: { analysisId: result.analysisId, offset: NGS_ANALYSIS_PREVIEW_CALLS, limit: NGS_ANALYSIS_PREVIEW_CALLS },
                },
              }
            : {}),
          countBasis: evidence.countBasis,
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}
