import { SEQ_LIST_ANNOTATIONS_DESCRIPTION } from '../sequence-tools';
import {
  createSequenceDocumentTool,
  sequenceDocumentSchema,
  sequenceDocumentOutputSchema,
} from '../../ai/public/tools/sequence-document';
import {
  createAlignmentSessionTool,
  alignmentSessionSchema,
  alignmentSessionOutputSchema,
} from '../../ai/public/tools/alignment-session';
import {
  getSequenceGeneticCodeOutputSchema,
  setSequenceGeneticCodeOutputSchema,
  importSequenceOutputSchema,
  findFeaturesOutputSchema,
  getSequenceOutputSchema,
  getSequencePackageHistoryOutputSchema,
  readSequencePackageHistoryItemOutputSchema,
  readSequencePackageEvidenceRunOutputSchema,
  previewSequencePackageRestoreOutputSchema,
  applySequencePackageRestoreOutputSchema,
  previewSequenceUserAttachmentMutationOutputSchema,
  applySequenceUserAttachmentMutationOutputSchema,
  getSequenceChangesOutputSchema,
  analyzeNgsReadsOutputSchema,
  getNgsAnalysisOutputSchema,
  startVariantCallsOutputSchema,
  importVariantCallsOutputSchema,
  getVariantAnalysisOutputSchema,
  inspectVariantCallOutputSchema,
  analyzeCloneOutputSchema,
  getCloneAnalysisOutputSchema,
  inspectSequenceVariantOutputSchema,
  selectionTranslateOutputSchema,
  runMsaOutputSchema,
  selectionReverseComplementOutputSchema,
  selectionRestrictionSitesOutputSchema,
  selectionGcProfileOutputSchema,
  selectionFindOrfsOutputSchema,
} from '../../ai/public/tools/sequence-output-schemas';
import {
  ANALYZE_NGS_READS_DESCRIPTION,
  GET_NGS_ANALYSIS_DESCRIPTION,
  analyzeNgsReadsSchema,
  getNgsAnalysisSchema,
  createAnalyzeNgsReadsTool,
  createGetNgsAnalysisTool,
} from '../../ai/public/tools/ngs-read-analysis';
import {
  GET_VARIANT_ANALYSIS_DESCRIPTION,
  createGetVariantAnalysisTool,
  getVariantAnalysisSchema,
  createStartSequenceVariantTool,
  createImportSequenceVariantTool,
  createInspectVariantCallTool,
  startSequenceVariantSchema,
  importSequenceVariantSchema,
  inspectVariantCallSchema,
} from '../../ai/public/tools/sequence-variant-analysis';
import {
  analyzeCloneSchema,
  createAnalyzeCloneTool,
  createGetCloneAnalysisTool,
  getCloneAnalysisSchema,
  createInspectSequenceVariantTool,
  inspectSequenceVariantSchema,
} from '../../ai/public/tools/clone-protein-workflow';
import {
  createGetSequenceGeneticCodeTool,
  createSetSequenceGeneticCodeTool,
  getSequenceGeneticCodeSchema,
  setSequenceGeneticCodeSchema,
} from '../../ai/public/tools/sequence-genetic-code';
import { createFindFeaturesTool, findFeaturesSchema } from '../../ai/public/tools/find-features';
import { createGetSequenceTool, getSequenceSchema } from '../../ai/public/tools/get-sequence';
import {
  applySequencePackageRestoreSchema,
  createApplySequencePackageRestoreTool,
  createGetSequencePackageHistoryTool,
  createPreviewSequencePackageRestoreTool,
  createReadSequencePackageHistoryItemTool,
  createReadSequencePackageEvidenceRunTool,
  getSequencePackageHistorySchema,
  previewSequencePackageRestoreSchema,
  readSequencePackageHistoryItemSchema,
  readSequencePackageEvidenceRunSchema,
} from '../../ai/public/tools/sequence-package-history';
import {
  applySequenceUserAttachmentMutationSchema,
  createApplySequenceUserAttachmentMutationTool,
  createPreviewSequenceUserAttachmentMutationTool,
  previewSequenceUserAttachmentMutationSchema,
} from '../../ai/public/tools/sequence-user-attachment-mutation';
import {
  createGetSequenceChangesTool,
  getSequenceChangesSchema,
} from '../../ai/public/tools/get-sequence-changes';
import {
  createImportSequenceTool,
  importSequenceSchema,
} from '../../ai/public/tools/import-sequence';
import {
  createSelectionTranslateTool,
  selectionTranslateSchema,
} from '../../ai/public/tools/selection-translate';
import {
  createRunMsaTool,
  projectRunMsaAuditResult,
  runMsaSchema,
} from '../../ai/public/tools/run-msa';
import {
  createSelectionReverseComplementTool,
  selectionReverseComplementSchema,
} from '../../ai/public/tools/selection-reverse-complement';
import {
  createSelectionRestrictionSitesTool,
  selectionRestrictionSitesSchema,
} from '../../ai/public/tools/selection-restriction-sites';
import {
  createSelectionGcProfileTool,
  selectionGcProfileSchema,
} from '../../ai/public/tools/selection-gc-profile';
import {
  createSelectionFindOrfsTool,
  selectionFindOrfsSchema,
} from '../../ai/public/tools/selection-find-orfs';
import { seqListAnnotationsSchema, seqListAnnotationsOutputSchema } from '../sequence-tools';
import { resultSdkRendererTool, customRendererTool, defineRendererToolCatalog } from './types';
import {
  READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
  UI_IDEMPOTENT_MCP_ANNOTATIONS,
  projectSequenceHistoryReadAudit,
  resolveImportSequenceAuthorization,
  handleSequenceListAnnotations,
} from './helpers';

export const sequencesTools = defineRendererToolCatalog({
  sequence_document: {
    name: 'sequence_document',
    description:
      'Inspect, edit bases and annotations, undo, redo, discard or save an existing sequence through the shared human editor. Inspect first for its revision. Base ranges are zero-based half-open; annotation bounds are one-based inclusive. Edits remain drafts until save.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: ['write-workspace'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: sequenceDocumentSchema,
    resolveInputAuthorization: (args) => ({
      additionalRequiredCapabilities:
        (args as { operation?: { kind?: string } }).operation?.kind === 'inspect'
          ? []
          : ['write-workspace'],
    }),
    outputSchema: sequenceDocumentOutputSchema,
    execution: resultSdkRendererTool((context) => createSequenceDocumentTool(context.folders)),
  },
  alignment_session: {
    name: 'alignment_session',
    description:
      'Inspect, create and curate native alignment verification sessions and tracks, status overrides, checked mutations and visibility. Align queries with the existing managed session job owner. Every edit requires the inspected revision and saves native history.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: ['write-workspace', 'operations.start'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: alignmentSessionSchema,
    resolveInputAuthorization: (args) => {
      const kind = (args as { operation?: { kind?: string } }).operation?.kind;
      return {
        additionalRequiredCapabilities:
          kind === 'inspect'
            ? []
            : kind === 'align-queries'
              ? ['write-workspace', 'operations.start']
              : ['write-workspace'],
      };
    },
    outputSchema: alignmentSessionOutputSchema,
    execution: resultSdkRendererTool((context) => createAlignmentSessionTool(context.folders)),
  },
  get_sequence_genetic_code: {
    name: 'get_sequence_genetic_code',
    description:
      'Read which genetic code a sequence file is translated by, and where that came from. Call this before reasoning about any protein from a record you did not write: mitochondrial and several nuclear codes reassign codons, so the same bases mean different amino acids.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: getSequenceGeneticCodeSchema,
    outputSchema: getSequenceGeneticCodeOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createGetSequenceGeneticCodeTool(context.folders)
    ),
  },
  set_sequence_genetic_code: {
    name: 'set_sequence_genetic_code',
    description:
      'Record which genetic code a sequence file should be translated by, saving it into the file. Use only when the file does not declare one; a coding feature that declares its own /transl_table is always read by that code and this setting does not change it. Pass null to remove a previously recorded code.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences', 'write-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: setSequenceGeneticCodeSchema,
    outputSchema: setSequenceGeneticCodeOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createSetSequenceGeneticCodeTool(context.folders)
    ),
  },
  import_sequence: {
    name: 'import_sequence',
    description:
      'Import a local GenBank/FASTA file, public URL, or NCBI nucleotide accession through one native publication. A managed source already in the destination project is reused. Do not write into a watched project and reimport it: loose sources already there keep their original publication owner. copyWithinProject=true explicitly creates a distinct copy.',
    shape: 'app-action',
    required_capabilities: ['create-entity', 'read-sequences', 'modify-tabs'],
    conditional_required_capabilities: ['external-fetch:annotation'],
    audit_required: true,
    effects: ['mutating', 'ui-bound'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: importSequenceSchema,
    outputSchema: importSequenceOutputSchema,
    transportInputRequirement: {
      kind: 'exactly-one',
      fields: ['source', 'sourcePath'],
    },
    execution: resultSdkRendererTool((context) => createImportSequenceTool(context.folders)),
    resolveInputAuthorization: resolveImportSequenceAuthorization,
  },
  find_features: {
    name: 'find_features',
    description:
      "Search annotations/features in a biology file by any identifier the feature carries (locus tag, gene symbol, synonym, cross-reference, product, note). Paged: matchCount is the true total; pass the response's nextOffset back as offset to reach every match.",
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: findFeaturesSchema,
    outputSchema: findFeaturesOutputSchema,
    execution: resultSdkRendererTool((context) => createFindFeaturesTool(context.folders)),
  },
  get_sequence: {
    name: 'get_sequence',
    description:
      'Read canonical DNAForge sequence state by path or resource URI. A record too long to inline returns sequence: null with a preview — pass start/end (1-indexed, inclusive) to read any window of it.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: getSequenceSchema,
    outputSchema: getSequenceOutputSchema,
    execution: resultSdkRendererTool((context) => createGetSequenceTool(context.folders)),
  },
  get_sequence_package_history: {
    name: 'get_sequence_package_history',
    description:
      'Discover bounded saved revision and per-item histories for one managed sequence package by stable document ID.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    mcpAnnotations: READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
    exposure: { kind: 'shared' },
    inputSchema: getSequencePackageHistorySchema,
    outputSchema: getSequencePackageHistoryOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createGetSequencePackageHistoryTool(context.folders)
    ),
  },
  read_sequence_package_history_item: {
    name: 'read_sequence_package_history_item',
    description:
      'Inspect one exact saved item version, including a bounded base window for an integrity-checked historical product.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    mcpAnnotations: READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
    exposure: { kind: 'shared' },
    inputSchema: readSequencePackageHistoryItemSchema,
    outputSchema: readSequencePackageHistoryItemOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createReadSequencePackageHistoryItemTool(context.folders)
    ),
    projectAuditResult: projectSequenceHistoryReadAudit,
  },
  read_sequence_package_evidence_run: {
    name: 'read_sequence_package_evidence_run',
    description:
      'Read one integrity-checked sequencing run, its frozen inputs, producer, result and bounded latest review from the sequence package.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    mcpAnnotations: READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
    exposure: { kind: 'shared' },
    inputSchema: readSequencePackageEvidenceRunSchema,
    outputSchema: readSequencePackageEvidenceRunOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createReadSequencePackageEvidenceRunTool(context.folders)
    ),
  },
  preview_sequence_package_restore: {
    name: 'preview_sequence_package_restore',
    description:
      'Preview one exact per-item historical selection against the current package without writing. Returns source pins and blockers.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    mcpAnnotations: READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
    exposure: { kind: 'shared' },
    inputSchema: previewSequencePackageRestoreSchema,
    outputSchema: previewSequencePackageRestoreOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createPreviewSequencePackageRestoreTool(context.folders)
    ),
  },
  apply_sequence_package_restore: {
    name: 'apply_sequence_package_restore',
    description:
      'Apply exactly a reviewed selective Restore preview as one new managed sequence-package revision; does not open a tab.',
    shape: 'app-action',
    required_capabilities: ['read-workspace', 'read-sequences', 'write-workspace'],
    conditional_required_capabilities: ['edit-assembly'],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    mcpAnnotations: UI_IDEMPOTENT_MCP_ANNOTATIONS,
    exposure: { kind: 'shared' },
    inputSchema: applySequencePackageRestoreSchema,
    outputSchema: applySequencePackageRestoreOutputSchema,
    resolveInputAuthorization: (args) => ({
      additionalRequiredCapabilities:
        typeof args === 'object' &&
        args !== null &&
        'selections' in args &&
        Array.isArray(args.selections) &&
        args.selections.some(
          (selection) =>
            typeof selection === 'object' &&
            selection !== null &&
            'itemId' in selection &&
            selection.itemId === 'assembly'
        )
          ? ['edit-assembly']
          : [],
    }),
    execution: resultSdkRendererTool((context) =>
      createApplySequencePackageRestoreTool(context.folders)
    ),
  },
  preview_sequence_user_attachment_mutation: {
    name: 'preview_sequence_user_attachment_mutation',
    description:
      'Preview one package-owned user attachment add, replacement, or detachment with exact source-byte and current-version pins. Does not change the package.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    mcpAnnotations: READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
    exposure: { kind: 'shared' },
    inputSchema: previewSequenceUserAttachmentMutationSchema,
    outputSchema: previewSequenceUserAttachmentMutationOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createPreviewSequenceUserAttachmentMutationTool(context.folders)
    ),
  },
  apply_sequence_user_attachment_mutation: {
    name: 'apply_sequence_user_attachment_mutation',
    description:
      'Publish exactly one reviewed attach, replace, or detach as a new version of the same managed sequence package. Requires the complete Preview pins and exact source file.',
    shape: 'app-action',
    required_capabilities: ['read-workspace', 'read-sequences', 'write-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    mcpAnnotations: UI_IDEMPOTENT_MCP_ANNOTATIONS,
    exposure: { kind: 'shared' },
    inputSchema: applySequenceUserAttachmentMutationSchema,
    outputSchema: applySequenceUserAttachmentMutationOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createApplySequenceUserAttachmentMutationTool(context.folders)
    ),
  },
  get_sequence_changes: {
    name: 'get_sequence_changes',
    description: 'Read sequence-level git changes for a GenBank file.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: getSequenceChangesSchema,
    outputSchema: getSequenceChangesOutputSchema,
    execution: resultSdkRendererTool((context) => createGetSequenceChangesTool(context.folders)),
  },
  analyze_ngs_reads: {
    name: 'analyze_ngs_reads',
    description: ANALYZE_NGS_READS_DESCRIPTION,
    shape: 'app-action',
    required_capabilities: [
      'read-workspace',
      'read-sequences',
      'operations.start',
      'create-entity',
      'modify-tabs',
    ],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating', 'ui-bound'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: analyzeNgsReadsSchema,
    outputSchema: analyzeNgsReadsOutputSchema,
    execution: resultSdkRendererTool((context) => createAnalyzeNgsReadsTool(context.folders)),
  },
  get_ngs_analysis: {
    name: 'get_ngs_analysis',
    description: GET_NGS_ANALYSIS_DESCRIPTION,
    shape: 'app-action',
    required_capabilities: ['read-workspace', 'read-sequences', 'create-entity', 'modify-tabs'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating', 'ui-bound'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: getNgsAnalysisSchema,
    outputSchema: getNgsAnalysisOutputSchema,
    execution: resultSdkRendererTool((context) => createGetNgsAnalysisTool(context.folders)),
  },
  start_variant_calls: {
    name: 'start_variant_calls',
    description:
      'Import existing VCF/BCF called variants, including compressed VCF, against the exact chromosome of a small imported reference. Use this for files ending in .vcf, .vcf.gz or .bcf even when earlier parts of the filename mention reads or fastq. Returns job identity; follow with import_variant_calls, then inspect_variant_call and color_variant_protein.',
    shape: 'app-action',
    required_capabilities: ['read-workspace', 'read-sequences', 'operations.start'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: startSequenceVariantSchema,
    outputSchema: startVariantCallsOutputSchema,
    execution: resultSdkRendererTool((context) => createStartSequenceVariantTool(context.folders)),
  },
  import_variant_calls: {
    name: 'import_variant_calls',
    description:
      'Read a prepared VCF job, choose a sample, verify REF bases, preserve counts and filters, and open the saved call review. Returns call identities for inspect_variant_call.',
    shape: 'app-action',
    required_capabilities: ['read-workspace', 'read-sequences', 'modify-tabs', 'create-entity'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating', 'ui-bound'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: importSequenceVariantSchema,
    outputSchema: importVariantCallsOutputSchema,
    execution: resultSdkRendererTool((context) => createImportSequenceVariantTool(context.folders)),
  },
  get_variant_analysis: {
    name: 'get_variant_analysis',
    description: GET_VARIANT_ANALYSIS_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    workspaceGrounding: 'always',
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: getVariantAnalysisSchema,
    outputSchema: getVariantAnalysisOutputSchema,
    execution: resultSdkRendererTool((context) => createGetVariantAnalysisTool(context.folders)),
  },
  inspect_variant_call: {
    name: 'inspect_variant_call',
    description:
      'Inspect one saved VCF or raw-read allele in its reference protein while keeping the call list open. Copy the call’s complete inspection.arguments exactly from get_ngs_analysis, import_variant_calls or get_variant_analysis. Validate current reference, then observe mol_get_state for loaded geometry. A missing analysis returns read-only recoveryActions to reread the actual evidence; use the returned exact identity.',
    shape: 'viz-tab-action',
    required_capabilities: [
      'read-workspace',
      'read-sequences',
      'modify-tabs',
      'external-fetch:structure',
    ],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: inspectVariantCallSchema,
    outputSchema: inspectVariantCallOutputSchema,
    execution: resultSdkRendererTool((context) => createInspectVariantCallTool(context.folders)),
  },
  analyze_clone: {
    name: 'analyze_clone',
    description:
      'Start the same durable circular-aware assembled-clone/Sanger alignment as the user interface and open the Alignments review. Returns its job identity promptly. Use get_clone_analysis for completed mutation identities. Raw-read populations are not one assembled clone.',
    shape: 'app-action',
    required_capabilities: [
      'read-workspace',
      'read-sequences',
      'create-entity',
      'modify-tabs',
      'operations.start',
    ],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating', 'ui-bound'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: analyzeCloneSchema,
    outputSchema: analyzeCloneOutputSchema,
    execution: resultSdkRendererTool((context) => createAnalyzeCloneTool(context.folders)),
  },
  get_clone_analysis: {
    name: 'get_clone_analysis',
    description:
      'Read the durable clone-analysis status and actual completed mutations. Waits up to 20 seconds for results. If still active, call get_clone_analysis again with the same identities until terminal; pending computation is not a reason to abandon the workflow. Pending, failed and stale analysis is not mutation evidence. Use documentId and sessionId from analyze_clone. Completed mutations include exact inspect_sequence_variant actions that resolve the linked protein and load its structure; follow the requested mutation’s inspection action before checking mol_get_state.',
    shape: 'app-action',
    required_capabilities: ['read-workspace', 'read-sequences', 'create-entity'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: getCloneAnalysisSchema,
    outputSchema: getCloneAnalysisOutputSchema,
    execution: resultSdkRendererTool((context) => createGetCloneAnalysisTool(context.folders)),
  },
  inspect_sequence_variant: {
    name: 'inspect_sequence_variant',
    description:
      'Open a fresh saved clone mutation in a linked protein pane beside its reference and mutation list. Use mutation inspection actions from get_clone_analysis. Waits up to 20 seconds for native readiness. If still loading, repeat the same inspection; an empty viewer list does not mean no structure exists. Read mol_get_state before applying measurements.',
    shape: 'viz-tab-action',
    required_capabilities: [
      'read-workspace',
      'read-sequences',
      'modify-tabs',
      'external-fetch:structure',
    ],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: inspectSequenceVariantSchema,
    outputSchema: inspectSequenceVariantOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createInspectSequenceVariantTool(context.folders)
    ),
  },
  seq_list_annotations: {
    name: 'seq_list_annotations',
    description: SEQ_LIST_ANNOTATIONS_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    mcpAnnotations: READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: seqListAnnotationsSchema,
    outputSchema: seqListAnnotationsOutputSchema,
    execution: {
      ...customRendererTool(handleSequenceListAnnotations),
      resultContract: 'explicit-v1',
    },
  },
  selection_translate: {
    name: 'selection_translate',
    description:
      'Translate a selection region to protein. Provide EITHER an app selection (refId) OR raw bases (sequence). Returns the amino-acid sequence only (strand- and reading-frame-aware); you never read raw bases.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'when-ref-id',
    exposure: { kind: 'shared' },
    inputSchema: selectionTranslateSchema,
    outputSchema: selectionTranslateOutputSchema,
    execution: resultSdkRendererTool((context) => createSelectionTranslateTool(context.folders)),
  },
  run_msa: {
    name: 'run_msa',
    description:
      'Start a durable MAFFT multiple-sequence-alignment job for 2+ registered protein entities. Returns the managed operation immediately so it can be followed, stopped, or inspected from Jobs, the API, the CLI, or agent tools.',
    shape: 'app-action',
    required_capabilities: ['operations.start', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: runMsaSchema,
    outputSchema: runMsaOutputSchema,
    projectAuditResult: projectRunMsaAuditResult,
    execution: resultSdkRendererTool((context) =>
      createRunMsaTool(context.folders, { subjectId: `msa:${context.actionId}` })
    ),
  },
  selection_reverse_complement: {
    name: 'selection_reverse_complement',
    description:
      'Reverse-complement a selection region. Provide EITHER an app selection (refId) OR raw bases (sequence); bounded to 5000 bp (use a compute tool for larger regions).',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'when-ref-id',
    exposure: { kind: 'shared' },
    inputSchema: selectionReverseComplementSchema,
    outputSchema: selectionReverseComplementOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createSelectionReverseComplementTool(context.folders)
    ),
  },
  selection_restriction_sites: {
    name: 'selection_restriction_sites',
    description:
      'Find restriction-enzyme recognition sites across a selection. Provide EITHER an app selection (refId) OR raw bases (sequence); returns a site table for the named enzymes over the full range.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'when-ref-id',
    exposure: { kind: 'shared' },
    inputSchema: selectionRestrictionSitesSchema,
    outputSchema: selectionRestrictionSitesOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createSelectionRestrictionSitesTool(context.folders)
    ),
  },
  selection_gc_profile: {
    name: 'selection_gc_profile',
    description:
      'Compute a per-window GC-content profile across a selection. Provide EITHER an app selection (refId) OR raw bases (sequence); windows are non-overlapping.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'when-ref-id',
    exposure: { kind: 'shared' },
    inputSchema: selectionGcProfileSchema,
    outputSchema: selectionGcProfileOutputSchema,
    execution: resultSdkRendererTool((context) => createSelectionGcProfileTool(context.folders)),
  },
  selection_find_orfs: {
    name: 'selection_find_orfs',
    description:
      'Find open reading frames in a selection. Provide EITHER an app selection (refId) OR raw bases (sequence); returns an ORF table over all six frames across the full range.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'when-ref-id',
    exposure: { kind: 'shared' },
    inputSchema: selectionFindOrfsSchema,
    outputSchema: selectionFindOrfsOutputSchema,
    execution: resultSdkRendererTool((context) => createSelectionFindOrfsTool(context.folders)),
  },
});
