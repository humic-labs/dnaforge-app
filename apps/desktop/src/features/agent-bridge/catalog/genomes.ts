import {
  createReferenceOutputSchema,
  inspectIndexedCurrentViewOutputSchema,
  inspectReferenceIntervalOutputSchema,
  setIndexedCurrentViewOutputSchema,
  addIndexedBigWigUrlOutputSchema,
  importGenomeSourcesOutputSchema,
  configureIndexedTrackOutputSchema,
  composeIndexedTrackViewOutputSchema,
} from '../../ai/public/tools/genome-output-schemas';
import {
  CREATE_REFERENCE_TOOL_DESCRIPTION,
  createCreateReferenceTool,
  createReferenceSchema,
} from '../../ai/public/tools/create-reference';
import {
  createInspectIndexedCurrentViewTool,
  inspectIndexedCurrentViewSchema,
} from '../../ai/public/tools/inspect-indexed-current-view';
import {
  createInspectReferenceIntervalTool,
  inspectReferenceIntervalSchema,
} from '../../ai/public/tools/inspect-reference-interval';
import {
  createSetIndexedCurrentViewTool,
  setIndexedCurrentViewSchema,
} from '../../ai/public/tools/set-indexed-current-view';
import {
  addIndexedBigWigUrlSchema,
  createAddIndexedBigWigUrlTool,
} from '../../ai/public/tools/add-indexed-bigwig-url';
import {
  createImportGenomeSourcesTool,
  importGenomeSourcesSchema,
} from '../../ai/public/tools/import-genome-sources';
import {
  configureIndexedTrackSchema,
  createConfigureIndexedTrackTool,
} from '../../ai/public/tools/configure-indexed-track';
import {
  composeIndexedTrackViewSchema,
  createComposeIndexedTrackViewTool,
} from '../../ai/public/tools/compose-indexed-track-view';
import { resultSdkRendererTool, defineRendererToolCatalog } from './types';
import { createTrackViewsTool } from '../../ai/public/tools/track-views';
import {
  createSequenceDataLayersTool,
  sequenceDataLayersToolSchema,
  sequenceDataLayersOutputSchema,
} from '../../ai/public/tools/sequence-data-layers';
import {
  trackViewToolRequestSchema,
  trackViewCommandResultSchema,
} from '../../../shared/track-view-commands';
import {
  resolveCreateReferenceAuthorization,
  resolveImportGenomeSourcesAuthorization,
} from './helpers';

export const genomesTools = defineRendererToolCatalog({
  sequence_data_layers: {
    name: 'sequence_data_layers',
    description:
      'Inspect exact sequence revisions, map user CSV measurements by explicit coordinates or stable annotation IDs, and save reusable data layers. Reports unmatched and ambiguous rows. Dataset snapshots and mappings survive reopening and are independent of the viewer.',
    shape: 'app-action',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: ['create-entity', 'write-workspace'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: sequenceDataLayersToolSchema,
    outputSchema: sequenceDataLayersOutputSchema,
    execution: resultSdkRendererTool((context) => createSequenceDataLayersTool(context.folders)),
    resolveInputAuthorization: (input) => ({
      additionalRequiredCapabilities:
        (input as { operation?: string })?.operation === 'create'
          ? ['create-entity', 'write-workspace']
          : [],
    }),
  },
  track_views: {
    name: 'track_views',
    description:
      'List reference assemblies, inspect a saved native Track View, or create one from an explicit reference, project, BigWig/BigBed sources, settings and region. Creates a durable document without an open reference tab or UI interaction. Reuse the same requestId and inputs after an uncertain response. Open the returned documentId with app_views using operation kind open and viewId.',
    shape: 'app-action',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [
      'read-workspace',
      'create-entity',
      'write-workspace',
      'external-fetch:annotation',
    ],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: true,
    exposure: { kind: 'shared' },
    inputSchema: trackViewToolRequestSchema,
    outputSchema: trackViewCommandResultSchema,
    execution: resultSdkRendererTool((context) => createTrackViewsTool(context.folders)),
    resolveInputAuthorization: (input) => {
      const operation = (input as { operation?: string } | null)?.operation;
      if (operation === 'references') return {};
      return {
        requiresWorkspace: true,
        additionalRequiredCapabilities:
          operation === 'create'
            ? ['read-workspace', 'create-entity', 'write-workspace', 'external-fetch:annotation']
            : ['read-workspace'],
      };
    },
  },
  create_reference: {
    name: 'create_reference',
    description: CREATE_REFERENCE_TOOL_DESCRIPTION,
    shape: 'app-action',
    required_capabilities: ['create-entity'],
    conditional_required_capabilities: ['read-workspace', 'read-sequences'],
    audit_required: true,
    effects: ['mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: true,
    workspaceGrounding: 'when-existing-reference',
    exposure: { kind: 'shared' },
    inputSchema: createReferenceSchema,
    outputSchema: createReferenceOutputSchema,
    execution: resultSdkRendererTool((context) => createCreateReferenceTool(context.folders)),
    resolveInputAuthorization: resolveCreateReferenceAuthorization,
  },
  inspect_indexed_current_view: {
    name: 'inspect_indexed_current_view',
    description:
      'Read the currently open indexed genome view and the complete settings and source identity of every loaded track. start0 0 is real. Unknown coordinates are omitted rather than coerced to 0. Returns NO_INDEXED_VIEW when no indexed tab is open.',
    shape: 'data-service',
    required_capabilities: ['read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    emptyInputReason: 'Reads the currently open indexed genome tab. No arguments.',
    exposure: { kind: 'shared' },
    inputSchema: inspectIndexedCurrentViewSchema,
    outputSchema: inspectIndexedCurrentViewOutputSchema,
    execution: resultSdkRendererTool((_context) => createInspectIndexedCurrentViewTool()),
  },
  inspect_reference_interval: {
    name: 'inspect_reference_interval',
    description:
      'Read or compute over a bounded interval of an indexed reference FASTA. Pass an explicit workspace-grounded FASTA path, chromosome, and 0-based half-open coordinates. Does not use the currently open viewer. Operations: exact bases, reverse complement, six-frame translation, spliced/phase-aware CDS translation, IUPAC motif search, and a derived sequence payload with provenance. Large intervals are refused rather than inlined. Search results report whether the result cap hid more matches.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: inspectReferenceIntervalSchema,
    outputSchema: inspectReferenceIntervalOutputSchema,
    execution: resultSdkRendererTool((context) =>
      createInspectReferenceIntervalTool(context.folders)
    ),
  },
  set_indexed_current_view: {
    name: 'set_indexed_current_view',
    description:
      'Navigate the currently open indexed genome view to a 0-based half-open interval. start0 0 is real. Returns success only after the mounted viewer reports the requested live camera.',
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: setIndexedCurrentViewSchema,
    outputSchema: setIndexedCurrentViewOutputSchema,
    execution: resultSdkRendererTool((_context) => createSetIndexedCurrentViewTool()),
  },
  add_indexed_bigwig_url: {
    name: 'add_indexed_bigwig_url',
    description:
      'Admit a remote BigWig URL onto the currently open indexed genome view as a quantitative signal lane. The URL must be credential-free HTTP(S). Chromosome names and lengths in the file are checked against the open assembly. Returns success after the lane is attached, or status duplicate when that URL is already on the tab. Does not copy the file locally.',
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs', 'external-fetch:annotation'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: addIndexedBigWigUrlSchema,
    outputSchema: addIndexedBigWigUrlOutputSchema,
    execution: resultSdkRendererTool((_context) => createAddIndexedBigWigUrlTool()),
  },
  import_genome_sources: {
    name: 'import_genome_sources',
    description:
      'Add one or more genomic data sources to the open indexed genome view through the shared admission path: BAM/CRAM reads, VCF/BCF calls, BigWig signal, BigBed/BED/GFF intervals, from a local project file, an HTTP(S) URL, an S3 or GCS object, an htsget resource, or a UCSC or hub track. Credentialed sources name a saved credential reference, never a token. Each source returns its own outcome: added, duplicate, or failed with a reason. A local CRAM must name its reference FASTA.',
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs'],
    conditional_required_capabilities: ['external-fetch:annotation', 'read-workspace'],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: true,
    exposure: { kind: 'shared' },
    inputSchema: importGenomeSourcesSchema,
    outputSchema: importGenomeSourcesOutputSchema,
    execution: resultSdkRendererTool((context) => createImportGenomeSourcesTool(context.folders)),
    resolveInputAuthorization: resolveImportGenomeSourcesAuthorization,
  },
  configure_indexed_track: {
    name: 'configure_indexed_track',
    description:
      'Change one track in the open indexed genome view using the same validated settings as the track gutter, then return the complete resulting track state.',
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: configureIndexedTrackSchema,
    outputSchema: configureIndexedTrackOutputSchema,
    execution: resultSdkRendererTool((_context) => createConfigureIndexedTrackTool()),
  },
  compose_indexed_track_view: {
    name: 'compose_indexed_track_view',
    description:
      'Preflight and compose a separate unsaved Track View from the open indexed reference. Declare signal-first views with optional BAM/CRAM read evidence, or add independent BigWigs; existing tracks are preserved by default and changes are applied atomically.',
    shape: 'viz-tab-action',
    required_capabilities: ['modify-tabs', 'external-fetch:annotation'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['ui-bound'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    exposure: { kind: 'shared' },
    inputSchema: composeIndexedTrackViewSchema,
    outputSchema: composeIndexedTrackViewOutputSchema,
    execution: resultSdkRendererTool((_context) => createComposeIndexedTrackViewTool()),
  },
});
