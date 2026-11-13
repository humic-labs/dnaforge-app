import {
  selectInspectionProteinProduct,
  waitForInspectionProteinProduct,
} from '../../structure-drawer/public/inspection-allele';
import {
  applyVariantProteinMeasurement,
  variantProteinMeasurementOptionsSchema,
} from '../../alignment-manager/public/variant-protein-measurement';
import { sha256Hex } from '../../structure-drawer/public/api/protein-identity';
import { useSequenceStore } from '../../sequence/public/store';
import { useCanvasStore } from '../../canvas/public/store';
import { z } from 'zod';
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
import { waitForVariantSourceResult } from '../../sequence/public/variant-source-operation-client';
import {
  activateVariantAnalysis,
  describeVariantCalls,
  importSequenceVariantAnalysis,
  inspectVariantAnalysisCall,
  loadVariantAnalysis,
  VariantAnalysisNotFoundError,
} from '../../alignment-manager/public/variant-analysis';
import { openTabInCanvas } from './open-tab';
import { getWorkspaceResidueSelectionsStore } from '../../structure-drawer/public/state/selected-codon-registry';

export const startSequenceVariantSchema = z
  .object({
    documentId: z.string().min(1),
    path: z
      .string()
      .min(1)
      .describe(
        'VCF or BCF called variants inside an open project, including compressed VCF. Use this even when the filename also mentions reads, fastq, or an upstream sequencing pipeline. Raw FASTQ populations use analyze_ngs_reads.'
      ),
    chrom: z
      .string()
      .min(1)
      .describe(
        'Exact VCF chromosome name matching the selected reference. No automatic contig aliases.'
      ),
  })
  .strict();
export const importSequenceVariantSchema = z
  .object({
    documentId: z.string().min(1),
    operationId: z.string().min(1),
    chrom: z.string().min(1),
    sample: z.string().min(1).optional(),
    name: z.string().min(1).max(200),
  })
  .strict();
export const inspectVariantCallSchema = z
  .object({
    analysisId: z
      .string()
      .min(1)
      .describe('Exact saved analysisId. Copy the returned call inspection.arguments unchanged.'),
    callId: z.string().min(1),
    proteinProduct: z
      .enum(['reference', 'allele'])
      .optional()
      .describe(
        'Reference structural context by default; allele opens its separately translated single-allele product for prediction.'
      ),
  })
  .strict();
const failed = (error: unknown) =>
  toolFailure({
    code: 'VARIANT_ANALYSIS_FAILED',
    error: error instanceof Error ? error.message : String(error),
    retriable: false,
    stateChanged: 'unknown',
    partialEffects: [],
  });

async function variantAnalysisFailure(error: unknown, folders: WorkspaceFolder[]) {
  if (!(error instanceof VariantAnalysisNotFoundError)) return failed(error);
  const recoveryActions: Array<{ tool: string; arguments: Record<string, string> }> = [];
  const seen = new Set<string>();
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    for (const tab of panel.tabs) {
      if (tab.type !== 'sequence') continue;


      try {
        await loadSequenceDocumentBiologyFile(tab.entityId, folders);
      } catch {
        continue;
      }
      const state = tab.viewState;
      const ids = new Set([
        state?.variantAnalysisId,
        ...(Array.isArray(state?.variantAnalysisIds) ? state.variantAnalysisIds : []),
      ]);
      for (const id of ids) {
        if (typeof id !== 'string' || seen.has(id)) continue;
        try {
          const analysis = await loadVariantAnalysis(id);
          if (analysis.documentId !== tab.entityId) continue;
          recoveryActions.push({ tool: 'get_variant_analysis', arguments: { analysisId: id } });
          seen.add(id);
        } catch {

        }
      }
      const operation = state?.ngsReadOperation as
        | { operationId?: unknown; name?: unknown }
        | undefined;
      if (typeof operation?.operationId === 'string' && typeof operation.name === 'string')
        recoveryActions.push({
          tool: 'get_ngs_analysis',
          arguments: {
            documentId: tab.entityId,
            operationId: operation.operationId,
            name: operation.name,
          },
        });
    }
  }
  return toolFailure({
    code: 'VARIANT_ANALYSIS_NOT_FOUND',
    error: error.message,
    retriable: false,
    stateChanged: false,
    partialEffects: [],
    details: { recoveryActions },
  });
}

export function createStartSequenceVariantTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Start durable preparation of a workspace VCF/BCF against an imported small reference sequence. This is called-variant evidence, not clone consensus. Returns a job identity promptly; use import_variant_calls to observe readiness, choose a sample, verify reference bases and open the review.',
    inputSchema: startSequenceVariantSchema,
    execute: async ({ documentId, path, chrom }) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
        const resolved = resolveMultiRootPath(getUserFolders(folders), path);
        const [source, root] = await Promise.all([
          platform().fs.stat(resolved.absolutePath),
          platform().fs.stat(resolved.folder.path),
        ]);
        if (!source.isFile || !isPathInsideBoundary(source.canonicalPath, root.canonicalPath))
          throw new Error('The call file must be inside its open project.');
        return toolSuccess({
          documentId: loaded.documentId,
          chrom,
          input: {
            variantPath: source.canonicalPath,
            references: [{ name: chrom, length: loaded.biology.sequence.sequence.length }],
          },
        });
      } catch (error) {
        return failed(error);
      }
    },
  });
}
export function createImportSequenceVariantTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Observe a VCF preparation job, then import one sample as durable variant evidence beside its source sequence. Returns available samples when a choice is required. Verifies every REF allele against current DNA; preserves filters, counts and missing values. Never creates a fictitious clone alignment. Call inspect_variant_call with a returned callId to see protein context.',
    inputSchema: importSequenceVariantSchema,
    execute: async ({ documentId, operationId, chrom, sample, name }) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
        const operation = await managedOperations.getOperation(operationId);
        if (operation.kind !== 'variant-source-preparation')
          throw new Error('This job did not prepare variant calls.');
        if (operation.state !== 'succeeded')
          return toolSuccess({
            operationId,
            status: operation.state,
            error: operation.error,
            message: 'No completed variant evidence is available yet.',
          });
        const source = await waitForVariantSourceResult(operationId);
        const sourceFile = await platform().fs.stat(source.sourcePath);
        const roots = await Promise.all(
          getUserFolders(folders).map((folder) => platform().fs.stat(folder.path))
        );
        if (
          !sourceFile.isFile ||
          !roots.some((root) => isPathInsideBoundary(sourceFile.canonicalPath, root.canonicalPath))
        )
          throw new Error('The prepared call file must remain inside an open project.');
        const selected = sample ?? (source.samples.length === 1 ? source.samples[0] : undefined);
        if (!selected)
          return toolSuccess({ operationId, status: 'choose-sample', samples: source.samples });
        const opened = await openTabInCanvas(
          { type: 'sequence', entityId: documentId, label: loaded.name ?? 'Variant review' },
          folders
        );
        if (opened.error) throw new Error(opened.error);
        const result = await importSequenceVariantAnalysis({
          documentId,
          sequence: loaded.biology.sequence,
          source,
          chrom,
          sample: selected,
          name,
        });
        return toolSuccess({
          analysisId: result.analysisId,
          status: 'imported',
          countBasis: result.data.countBasis,
          sample: result.data.sample,
          referenceSha256: result.data.referenceSha256,
          sourceIdentity: result.data.sourceIdentity,
          callCount: result.data.calls.length,
          calls: describeVariantCalls(
            result.data,
            loaded.biology.sequence,
            result.data.calls.slice(0, 1000),
            result.analysisId
          ),
          callsTruncated: result.data.calls.length > 1000,
          nextOffset: result.data.calls.length > 1000 ? 1000 : null,
          continuationTool: 'get_variant_analysis',
        });
      } catch (error) {
        return failed(error);
      }
    },
  });
}
export function createInspectVariantCallTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Open one saved VCF or raw-read allele in the linked protein inspection beside its call list. Copy the selected call’s inspection.arguments exactly from get_ngs_analysis, import_variant_calls or get_variant_analysis. Checks the current reference revision and uses exact codon mapping. Waits up to 20 seconds for native readiness; repeat if still loading. Read mol_get_state before applying measurements. A missing analysis returns read-only recoveryActions; execute the relevant action and use the exact returned identity. Symbolic or unmappable alleles return their limitation.',
    inputSchema: inspectVariantCallSchema,
    execute: async ({ analysisId, callId, proteinProduct }, { abortSignal }) => {
      try {
        const analysis = await loadVariantAnalysis(analysisId);
        const loaded = await loadSequenceDocumentBiologyFile(analysis.documentId, folders);
        const opened = await openTabInCanvas(
          { type: 'sequence', entityId: loaded.documentId, label: loaded.name ?? 'Variant review' },
          folders
        );
        if (opened.error) throw new Error(opened.error);
        activateVariantAnalysis(analysis.documentId, analysisId);
        const deadline = Date.now() + 10_000;
        while (!getWorkspaceResidueSelectionsStore(loaded.documentId) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        const reason = inspectVariantAnalysisCall(analysis, loaded.biology.sequence, callId);
        if (reason) throw new Error(reason);
        if (proteinProduct === 'allele')
          selectInspectionProteinProduct(analysis.documentId, 'allele');
        const protein = await waitForInspectionProteinProduct(analysis.documentId, abortSignal);
        return toolSuccess({
          ...protein,
          analysisId,
          callId,
          status: protein.structureStatus,
        });
      } catch (error) {
        return variantAnalysisFailure(error, folders);
      }
    },
  });
}

export const getVariantAnalysisSchema = z
  .object({
    analysisId: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(500).default(25).describe(
      'Requested upper bound. Native responses contain at most 25 calls; follow nextOffset until null to read every matching call without external result files.'
    ),
    start: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional inclusive DNA position, one based.'),
    end: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional inclusive DNA position, one based.'),
  })
  .strict();
export const GET_VARIANT_ANALYSIS_DESCRIPTION =
  'Read saved VCF or raw-read evidence with explicit pagination and optional DNA range. Retains actual counts, filters, sample and source identity; reports whether its reference is stale. Each call includes proteinContext from the same current coding annotations and codon mapping used by mutation clicks: mapped names the protein, one-based residues and single-allele consequences and supplies inspection.arguments to copy exactly; unavailable gives the exact limitation. Coding mapping does not establish available structure coordinates. Use returned inspection arguments rather than constructing identifiers. The requested limit is an upper bound: each native response contains at most 25 calls. Use nextOffset until null to inspect all matching calls without reading external result files. Missing analyses return read-only recoveryActions.';
export function createGetVariantAnalysisTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: GET_VARIANT_ANALYSIS_DESCRIPTION,
    inputSchema: getVariantAnalysisSchema,
    execute: async ({ analysisId, offset, limit, start, end }) => {
      try {
        if (start !== undefined && end !== undefined && start > end)
          throw new Error('The end position must not precede the start.');
        const analysis = await loadVariantAnalysis(analysisId);
        const loaded = await loadSequenceDocumentBiologyFile(analysis.documentId, folders);
        const current =
          useSequenceStore.getState().getSequence(analysis.documentId) ?? loaded.biology.sequence;
        const calls = analysis.calls.filter(
          (call) =>
            (start === undefined || call.position >= start) &&
            (end === undefined || call.position <= end)
        );
        const pageSize = Math.min(limit, 25);
        return toolSuccess({
          analysisId,
          documentId: analysis.documentId,
          name: analysis.name,
          sample: analysis.sample,
          sourceIdentity: analysis.sourceIdentity,
          referenceSha256: analysis.referenceSha256,
          countBasis: analysis.countBasis,
          stale: sha256Hex(current.sequence.toUpperCase()) !== analysis.referenceSha256,
          totalCalls: analysis.calls.length,
          matchingCalls: calls.length,
          offset,
          limit: pageSize,
          requestedLimit: limit,
          nextOffset: offset + pageSize < calls.length ? offset + pageSize : null,
          calls: describeVariantCalls(
            analysis,
            current,
            calls.slice(offset, offset + pageSize),
            analysisId
          ),
        });
      } catch (error) {
        return variantAnalysisFailure(error, folders);
      }
    },
  });
}
export const colorVariantProteinSchema = variantProteinMeasurementOptionsSchema
  .extend({
    analysisId: z.string().min(1),
    baselineAnalysisId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional before/control sample. Only identical DNA alleles with both counts can produce a ratio; absent alleles stay unknown.'
      ),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.baselineAnalysisId && input.pseudocount === 0)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pseudocount'],
        message: 'A baseline log2 fraction ratio requires a positive pseudocount.',
      });
  });
export const COLOR_VARIANT_PROTEIN_DESCRIPTION =
  'Color the currently loaded mutation-linked protein directly from saved VCF or raw-read allele counts. For a saved variant analysis this computes the complete selected population without fetching every page or manually rebuilding a measurement. First inspect_variant_call and wait for mol_get_state. Computes maximum single-allele fraction per residue without adding overlapping reads; optional baseline computes log2 smoothed per-site fraction ratio, showing the signed maximum absolute change. Preserves counts, source identities, filter choices and excluded records. Missing evidence remains unknown. Uses the same operation as Color loaded protein in the UI; save with mol_save_view. This measures substitution allele evidence, not phased clones or mutation effects. When a requested scale endpoint is an allele fraction, copy the returned allele_fraction exactly rather than recomputing it from counts.';
export function createColorVariantProteinTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: COLOR_VARIANT_PROTEIN_DESCRIPTION,
    inputSchema: colorVariantProteinSchema,
    execute: async (input) => {
      try {
        const analysis = await loadVariantAnalysis(input.analysisId);
        const loaded = await loadSequenceDocumentBiologyFile(analysis.documentId, folders);
        const sequence =
          useSequenceStore.getState().getSequence(analysis.documentId) ?? loaded.biology.sequence;
        const result = await applyVariantProteinMeasurement({ ...input, sequence });
        return toolSuccess({
          measurementId: result.measurement.id,
          name: result.measurement.name,
          rendered: true,
          source: result.measurement.source,
          scale: result.measurement.scale,
          aggregation: result.measurement.variantEvidence!.aggregation,
          mappedResidues: result.mappedResidues,
          unmappedResidues: result.unmappedResidues,
          values: result.measurement.values,
          excludedCallCount: result.measurement.variantEvidence!.excluded.length,
          unknownResidueCount: result.measurement.values.filter((row) => row.value === null).length,
        });
      } catch (error) {
        return variantAnalysisFailure(error, folders);
      }
    },
  });
}
