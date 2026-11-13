import {
  inspectAnnotationOutputOutputSchema,
  applyAnnotationOutputOutputSchema,
  operationsAnnotationInspectOutputSchema,
  operationsAnnotationApplyOutputSchema,
  operationsGenomeIndexingStartOutputSchema,
  operationsTrackRegistrationStartOutputSchema,
  operationsAlignmentCoveragePreparationStartOutputSchema,
  operationsAlignmentIndexPreparationStartOutputSchema,
  operationsVariantSourcePreparationStartOutputSchema,
} from '../../ai/public/tools/operation-output-schemas';
import {
  annotationOutputApplySchema,
  annotationOutputInspectSchema,
  createApplyAnnotationOutputTool,
  createInspectAnnotationOutputTool,
} from '../../ai/public/tools/annotation-output';
import {
  createApplyManagedAnnotationOperationTool,
  createInspectManagedAnnotationOperationTool,
  managedAnnotationApplySchema,
  managedAnnotationInspectSchema,
} from '../../ai/public/tools/managed-annotation-operation';
import {
  createPrepareManagedGenomeIndexTool,
  managedGenomeIndexStartSchema,
  projectManagedGenomeIndexPreparation,
} from '../../ai/public/tools/genome-index-operation';
import {
  createPrepareManagedTrackRegistrationTool,
  managedTrackRegistrationStartSchema,
  projectManagedTrackRegistrationPreparation,
} from '../../ai/public/tools/track-registration-operation';
import {
  createPrepareManagedAlignmentCoverageTool,
  managedAlignmentCoverageStartSchema,
  projectManagedAlignmentCoveragePreparation,
} from '../../ai/public/tools/alignment-coverage-operation';
import {
  createPrepareManagedAlignmentIndexTool,
  managedAlignmentIndexStartSchema,
  projectManagedAlignmentIndexPreparation,
} from '../../ai/public/tools/alignment-index-operation';
import {
  createPrepareManagedVariantSourceTool,
  managedVariantSourceStartSchema,
  projectManagedVariantSourcePreparation,
} from '../../ai/public/tools/variant-source-operation';
import { resultSdkRendererTool, defineRendererToolCatalog } from './types';

export const operationsTools = defineRendererToolCatalog({
  inspect_annotation_output: {
    name: 'inspect_annotation_output',
    description:
      'Inspect ordinary dnaforge-annotate JSON or GFF3 output from the mounted workspace against one explicit sequence document.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: annotationOutputInspectSchema,
    outputSchema: inspectAnnotationOutputOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createInspectAnnotationOutputTool(context.folders)
    ),
  },
  apply_annotation_output: {
    name: 'apply_annotation_output',
    description:
      'Apply explicitly selected candidates from inspected annotation output to one sequence document and save it through the native document path.',
    shape: 'app-action',
    required_capabilities: ['read-workspace', 'read-sequences', 'write-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: false,
    exposure: { kind: 'shared' },
    inputSchema: annotationOutputApplySchema,
    outputSchema: applyAnnotationOutputOutputSchema,
    execution: resultSdkRendererTool((context) => createApplyAnnotationOutputTool(context.folders)),
  },
  'operations.annotation.inspect': {
    name: 'operations.annotation.inspect',
    providerAlias: 'operations_annotation_inspect',
    description:
      'Inspect one authorized retained annotation result against an explicit current sequence document.',
    shape: 'data-service',
    required_capabilities: ['operations.read', 'read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: managedAnnotationInspectSchema,
    outputSchema: operationsAnnotationInspectOutputSchema,
    execution: resultSdkRendererTool(() => createInspectManagedAnnotationOperationTool()),
  },
  'operations.annotation.apply': {
    name: 'operations.annotation.apply',
    providerAlias: 'operations_annotation_apply',
    description:
      'Apply selected candidates from one authorized retained annotation result after revalidating operation, result, and target revisions.',
    shape: 'app-action',
    required_capabilities: [
      'operations.read',
      'read-workspace',
      'read-sequences',
      'write-workspace',
    ],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: managedAnnotationApplySchema,
    outputSchema: operationsAnnotationApplyOutputSchema,
    execution: resultSdkRendererTool(() => createApplyManagedAnnotationOperationTool()),
  },
  'operations.genome-indexing.start': {
    name: 'operations.genome-indexing.start',
    providerAlias: 'operations_genome_indexing_start',
    description:
      'Start a durable genome-indexing job for a source inside an open project. Returns the managed operation immediately so it can be followed or stopped from Jobs, the API, the CLI, or agent tools.',
    shape: 'app-action',
    required_capabilities: ['operations.start', 'read-workspace', 'write-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: managedGenomeIndexStartSchema,
    outputSchema: operationsGenomeIndexingStartOutputSchema,
    projectAuditResult: projectManagedGenomeIndexPreparation,
    execution: resultSdkRendererTool((context) =>
      createPrepareManagedGenomeIndexTool(context.folders)
    ),
  },
  'operations.track-registration.start': {
    name: 'operations.track-registration.start',
    providerAlias: 'operations_track_registration_start',
    description:
      'Register a GFF3 file inside an open project as a track in the per-machine track store, so it can be drawn on that assembly. Returns the managed operation immediately so it can be followed from Jobs, the API, the CLI, or agent tools.',
    shape: 'app-action',
    required_capabilities: ['operations.start', 'read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: managedTrackRegistrationStartSchema,
    outputSchema: operationsTrackRegistrationStartOutputSchema,
    projectAuditResult: projectManagedTrackRegistrationPreparation,
    execution: resultSdkRendererTool((context) =>
      createPrepareManagedTrackRegistrationTool(context.folders)
    ),
  },
  'operations.alignment-coverage-preparation.start': {
    name: 'operations.alignment-coverage-preparation.start',
    providerAlias: 'operations_alignment_coverage_preparation_start',
    description:
      'Start durable overview-coverage preparation for one mounted BAM or CRAM track. Returns the managed job immediately so it can be followed in Jobs, the API, the CLI, or agent tools.',
    shape: 'app-action',
    required_capabilities: ['operations.start', 'read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: managedAlignmentCoverageStartSchema,
    outputSchema: operationsAlignmentCoveragePreparationStartOutputSchema,
    projectAuditResult: projectManagedAlignmentCoveragePreparation,
    execution: resultSdkRendererTool(() => createPrepareManagedAlignmentCoverageTool()),
  },
  'operations.alignment-index-preparation.start': {
    name: 'operations.alignment-index-preparation.start',
    providerAlias: 'operations_alignment_index_preparation_start',
    description:
      'Start durable index preparation for a BAM or CRAM file inside an open project. Returns the managed job immediately so it can be followed in Jobs, the API, the CLI, or agent tools.',
    shape: 'app-action',
    required_capabilities: ['operations.start', 'read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: managedAlignmentIndexStartSchema,
    outputSchema: operationsAlignmentIndexPreparationStartOutputSchema,
    projectAuditResult: projectManagedAlignmentIndexPreparation,
    execution: resultSdkRendererTool((context) =>
      createPrepareManagedAlignmentIndexTool(context.folders)
    ),
  },
  'operations.variant-source-preparation.start': {
    name: 'operations.variant-source-preparation.start',
    providerAlias: 'operations_variant_source_preparation_start',
    description:
      'Start durable VCF or BCF preparation against a mounted indexed assembly. Returns the managed job immediately so it can be followed in Jobs, the API, the CLI, or agent tools.',
    shape: 'app-action',
    required_capabilities: ['operations.start', 'read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    sidecarOrchestrated: true,
    exposure: { kind: 'shared' },
    inputSchema: managedVariantSourceStartSchema,
    outputSchema: operationsVariantSourcePreparationStartOutputSchema,
    projectAuditResult: projectManagedVariantSourcePreparation,
    execution: resultSdkRendererTool((context) =>
      createPrepareManagedVariantSourceTool(context.folders)
    ),
  },
});
