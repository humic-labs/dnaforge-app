import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import rendererToolManifest from '../../../../../packages/core/agent-tools/renderer-tool-manifest.json';
import { LIMS_REGISTRY_SORTS } from '../../shared/lims';
import { molShowInteractionContextSchema } from './structure-tools/contracts';
import {
  ALLOWED_RENDERER_TOOLS,
  getAllowedRendererTool,
  resolveRendererToolAuthorization,
  type RendererToolExposure,
} from './renderer-tools';

const sharedExposure = { kind: 'shared' } satisfies RendererToolExposure;
const mcpOnlyExposure = {
  kind: 'mcp-only',
  reason: 'Requires an MCP-owned transport.',
} satisfies RendererToolExposure;
// @ts-expect-error An MCP-only descriptor must explain why Hosted cannot expose it.
const invalidMcpOnlyExposure: RendererToolExposure = { kind: 'mcp-only' };
void [sharedExposure, mcpOnlyExposure, invalidMcpOnlyExposure];

const manifestToolNames = rendererToolManifest.tools.map((tool) => tool.name);

describe('closed renderer authorization contracts', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'refuses inherited object property %s as an unknown tool',
    (name) => {
      expect(getAllowedRendererTool(name)).toBeNull();
      expect(resolveRendererToolAuthorization(name, {})).toBeNull();
    }
  );

  it('refuses a conditional capability absent from its published descriptor', () => {
    const tool = getAllowedRendererTool('sequence_document');
    if (!tool) throw new Error('Expected registered sequence tool');
    const policy = vi.spyOn(tool, 'resolveInputAuthorization').mockReturnValue({
      additionalRequiredCapabilities: ['manage-agent-access'],
    });
    try {
      expect(() =>
        resolveRendererToolAuthorization('sequence_document', {
          documentId: 'sequence-test',
          operation: { kind: 'inspect' },
        })
      ).toThrow(/undeclared capability/);
    } finally {
      policy.mockRestore();
    }
  });

  it('refuses a conditional workspace requirement absent from its published descriptor', () => {
    const tool = getAllowedRendererTool('app_views');
    if (!tool) throw new Error('Expected registered app view tool');
    const policy = vi.spyOn(tool, 'resolveInputAuthorization').mockReturnValue({
      requiresWorkspace: true,
    });
    try {
      expect(() =>
        resolveRendererToolAuthorization('app_views', {
          operation: { kind: 'inspect' },
        })
      ).toThrow(/undeclared workspace requirement/);
    } finally {
      policy.mockRestore();
    }
  });
});

describe('sequencing evidence format guidance', () => {
  it('distinguishes raw FASTQ from called variants in the shared tool contracts', () => {
    const reads = ALLOWED_RENDERER_TOOLS.analyze_ngs_reads;
    const calls = ALLOWED_RENDERER_TOOLS.start_variant_calls;
    expect(reads.description).toContain('start_variant_calls');
    expect(reads.inputSchema.shape.path.description).toContain('FASTQ');
    expect(reads.inputSchema.shape.path.description).toContain('VCF');
    expect(calls.description).toContain('import_variant_calls');
    expect(calls.inputSchema.shape.path.description).toContain('VCF');
    expect(calls.inputSchema.shape.path.description).toContain('BCF');
  });
});

describe('portable skill access', () => {
  it('lets the canonical reader resolve enabled skills and open tabs without a project gate', () => {
    expect(
      resolveRendererToolAuthorization('read_file', { path: 'skill://all/example/SKILL.md' })
    ).toEqual({ requiredCapabilities: ['read-workspace'], requiresWorkspace: false });
    expect(ALLOWED_RENDERER_TOOLS.read_file.description).toContain(
      'Sequence documents are excluded'
    );
    expect(ALLOWED_RENDERER_TOOLS.read_file.description).toContain('skill://');
  });
});

describe('structure source authorization', () => {
  it('uses workspace authority for coordinate files and network authority only for remote sources', () => {
    expect(
      resolveRendererToolAuthorization('mol_open_tab', {
        structure: { kind: 'file', path: '1URN.cif' },
      })
    ).toEqual({ requiredCapabilities: ['modify-tabs', 'read-workspace'], requiresWorkspace: true });
    for (const structure of [
      { kind: 'pdb', pdbId: '1URN' },
      { kind: 'uniprot', accession: 'P0AD86' },
      { kind: 'url', url: 'https://files.rcsb.org/download/1URN.cif' },
    ])
      expect(resolveRendererToolAuthorization('mol_open_tab', { structure })).toEqual({
        requiredCapabilities: ['modify-tabs', 'external-fetch:structure'],
        requiresWorkspace: false,
      });
    expect(
      resolveRendererToolAuthorization('mol_open_tab', {
        structure: { kind: 'data', format: 'cif', data: 'data_inline' },
      })
    ).toEqual({ requiredCapabilities: ['modify-tabs'], requiresWorkspace: false });
  });
});
const validRendererArgs: Record<string, unknown> = {
  inspect_fasta_kind: { path: 'Project/proteins/legacy.faa' },
  classify_fasta: {
    path: 'Project/proteins/legacy.faa',
    kind: 'protein',
    expectedRevision: 'a'.repeat(64),
  },
  submit_scientific_changes: { expectedHead: null },
  create_pcr_product: {
    name: 'Predicted product',
    templateDocumentId: 'template',
    forwardPrimerId: 'forward',
    reversePrimerId: 'reverse',
  },
  search_primer_matches: { primerIds: ['forward'], targetDocumentIds: ['template'] },
  create_sequence_product: {
    name: 'Planned product',
    parts: [{ kind: 'literal', label: 'Specified sequence', sequence: 'ACGT' }],
  },
  create_strain: { name: 'Planned strain', fields: { genotypeCanonical: 'MATa' } },
  list_scientific_objects: {},
  workspace_projects: { operation: { kind: 'list' } },
  administration: { operation: { kind: 'inspect-settings' } },
  import_review: {
    project: 'Project',
    operation: { kind: 'prepare', source: { fileName: 'primers.csv', text: 'name,sequence' } },
  },
  project_history: { project: 'Project', operation: { kind: 'inspect' } },
  search_workspace: { query: 'Sequence' },
  registry_records: { operation: { kind: 'schemas' } },
  work_tasks: { project: 'Project', operation: { kind: 'query' } },
  alignment_session: { documentId: 'sequence-test', operation: { kind: 'inspect' } },
  notebook_document: { operation: { kind: 'list' } },
  app_views: { operation: { kind: 'inspect' } },
  sequence_document: { documentId: 'sequence-test', operation: { kind: 'inspect' } },
  workspace_files: { operation: { kind: 'inspect', path: 'source.gb' } },
  file_document: { tabId: 'file-tab-1', operation: { kind: 'inspect' } },
  list_files: {},
  get_entity_link: { entityId: 'entity-test', projectId: 'project-test' },
  create_notebook_reference: { entityType: 'sequence', entityId: 'sequence-test' },
  create_notebook: {
    title: 'RAD51 plan',
    intentId: 'plan-test',
    blocks: [{ type: 'paragraph', content: [{ text: 'Native notebook plan.' }] }],
  },
  update_notebook: {
    notebookId: 'notebook-test',
    expectedRevision: 'revision-test',
    blocks: [{ type: 'paragraph', content: [{ text: 'Native notebook update.' }] }],
  },
  get_notebook: { notebookId: 'notebook-test' },
  remove_primer_binding: {
    primerId: 'primer-test',
    expectedArtifactRevision: 1,
    bindingId: 'binding-test',
  },
  delete_primer: { primerId: 'primer-test', expectedArtifactRevision: 1 },
  update_assembly_primer: {
    designId: 'design-test',
    primerId: 'primer-test',
    expectedDesignVersion: 0,
    pbsSequence: 'ACGT',
  },
  save_design_primers: {
    designId: 'design-test',
    expectedDesignVersion: 0,
    choices: [{ primerId: 'primer-test', oligoId: 'oligo-test' }],
  },
  read_file: { path: 'plasmids/source.gb' },
  get_remote_hosts: {},
  manage_remote_host: { action: 'save', target: 'lab-hpc', displayName: 'Lab cluster' },
  search_skills: { query: 'primer ordering', provider: 'codex-sdk' },
  inspect_annotation_output: {
    outputPath: 'runs/result.json',
    format: 'json',
    targetDocumentId: 'sequence-document-1',
  },
  apply_annotation_output: {
    outputPath: 'runs/result.json',
    format: 'json',
    targetDocumentId: 'sequence-document-1',
    expectedOutputSha256: `sha256:${'a'.repeat(64)}`,
    expectedTargetDocumentRevision: `annotation-document-v1:sha256:${'b'.repeat(64)}`,
    selectedCandidateIds: [`annotation-output:${'a'.repeat(64)}:0`],
  },
  'operations.annotation.inspect': {
    operationId: 'operation-1',
    targetDocumentId: 'sequence-document-1',
  },
  'operations.annotation.apply': {
    operationId: 'operation-1',
    targetDocumentId: 'sequence-document-1',
    expectedOperationVersion: 1,
    expectedResultSha256: `sha256:${'a'.repeat(64)}`,
    expectedTargetDocumentRevision: `annotation-document-v1:sha256:${'b'.repeat(64)}`,
    selectedCandidateIds: ['operation-1:0'],
  },
  'operations.genome-indexing.start': { path: 'references/grch38.fa' },
  'operations.track-registration.start': {
    path: 'tracks/terminators.gff3',
    accession: 'NC_000913.3',
    lengthBp: 4_641_652,
    name: 'my-terminators',
    kinds: ['terminator'],
    label: 'My terminators',
    evidence: 'computed',
    licenseAttribution: 'Computed in this lab',
  },
  'operations.alignment-index-preparation.start': { path: 'reads/sample.bam' },
  'operations.variant-source-preparation.start': {
    assemblyId: 'grch38',
    path: 'variants/sample.vcf',
  },
  'operations.alignment-coverage-preparation.start': {
    assemblyId: 'grch38',
    trackId: 'track-1',
  },
  read_pdf: { path: 'papers/source.pdf', pageStart: 1, pageEnd: 2, maxCharacters: 50_000 },
  create_protocol_from_pdf: {
    pdfPath: 'papers/source.pdf',
    outputPath: 'Protocols/Source',
    title: 'Source protocol',
    overview: 'Extracted protocol.',
    steps: [
      {
        title: 'Lyse cells',
        instructions: 'Lyse the cells.',
        sourceStatus: 'source',
        evidenceBlockIds: ['p1-b1'],
      },
    ],
  },
  capture_paper_source: {
    originalUrl: 'https://example.org/paper',
    canonicalUrl: 'https://example.org/paper',
    mediaType: 'text/html',
    capturedText: 'Methods',
    capturedAt: '2026-08-19T03:00:00.000Z',
    expectedSha256: `sha256:${'a'.repeat(64)}`,
    title: 'Paper',
  },
  capture_paper_url: {
    url: 'https://example.org/paper',
    pdfOutputPath: 'Sources/paper.pdf',
  },
  record_paper_reference_trace: {
    source: { kind: 'pdf', path: 'Sources/paper.pdf', title: 'Paper' },
    traces: [
      {
        relationship: 'cites',
        target: { scheme: 'pmid', value: '24157548' },
        evidenceBlockIds: ['p1-b1'],
      },
    ],
  },
  get_paper_reference_graph: {
    pdfPath: 'Sources/paper.pdf',
    depth: 1,
    maxNodes: 100,
  },
  create_protocol_candidate: {
    outputPath: 'Protocols/Source',
    title: 'Source protocol',
    candidateOrdinal: 1,
    source: {
      sourceId: 'text:source',
      kind: 'captured_text',
      title: 'Paper',
      mediaType: 'text/html',
      sha256: `sha256:${'a'.repeat(64)}`,
      capturedAt: '2026-08-19T03:00:00.000Z',
      originalUrl: 'https://example.org/paper',
      canonicalUrl: 'https://example.org/paper',
      text: 'Methods',
    },
    steps: [
      {
        title: 'Step',
        instructions: 'Methods',
        evidenceBlockIds: ['text-b1'],
      },
    ],
  },
  get_protocol_candidates: {},
  select_protocol_candidate: {
    path: 'Protocols/Source/.forge/protocol.json',
    expectedCandidateId: 'paper-candidate-source-v1',
    expectedRevision: 1,
  },
  preview_finalize_paper_protocol: {
    path: 'Protocols/Source/.forge/protocol.json',
    expectedRevision: 1,
  },
  finalize_paper_protocol: {
    path: 'Protocols/Source/.forge/protocol.json',
    expectedRevision: 1,
    previewFingerprint: `sha256:${'c'.repeat(64)}`,
    idempotencyKey: 'accept-source-v1',
  },
  reopen_paper_protocol: {
    path: 'Protocols/Source/.forge/protocol.json',
    acceptedVersionId: 'accepted-source-v1',
    idempotencyKey: 'reopen-source-v1',
  },
  get_file_changes: {},
  list_historical_assembly_components: { constructId: 'construct-one' },
  inspect_historical_assembly_stage_target: {
    constructId: 'construct-one',
    baseAcceptedAssemblyVersionId: 'accepted-current',
  },
  preview_historical_assembly_component_stage: {
    constructId: 'construct-one',
    baseAcceptedAssemblyVersionId: 'accepted-current',
    expectedDesignVersion: 4,
    expectedDraftDigest: `sha256:${'b'.repeat(64)}`,
    selections: [
      {
        source: {
          kind: 'region',
          regionId: 'left',
          acceptedAssemblyVersionId: 'accepted-old',
          canonicalDraftChecksum: `sha256:${'c'.repeat(64)}`,
          componentId: '["region","left"]',
          componentDigest: `sha256:${'a'.repeat(64)}`,
        },
        target: { kind: 'region', regionId: 'left' },
      },
    ],
  },
  stage_historical_assembly_components: {
    constructId: 'construct-one',
    baseAcceptedAssemblyVersionId: 'accepted-current',
    expectedDesignVersion: 4,
    expectedDraftDigest: `sha256:${'b'.repeat(64)}`,
    selections: [
      {
        source: {
          kind: 'region',
          regionId: 'left',
          acceptedAssemblyVersionId: 'accepted-old',
          canonicalDraftChecksum: `sha256:${'c'.repeat(64)}`,
          componentId: '["region","left"]',
          componentDigest: `sha256:${'a'.repeat(64)}`,
        },
        target: { kind: 'region', regionId: 'left' },
      },
    ],
    reopenIdempotencyKey: 'stage-once',
  },
  get_sequence_package_history: { documentId: 'package-one' },
  read_sequence_package_history_item: {
    documentId: 'package-one',
    revisionId: 'revision-one',
    itemId: 'field:label',
  },
  read_sequence_package_evidence_run: { documentId: 'package-one', runId: 'run-one' },
  preview_sequence_package_restore: {
    documentId: 'package-one',
    selections: [{ itemId: 'field:label', revisionId: 'revision-one' }],
  },
  apply_sequence_package_restore: {
    documentId: 'package-one',
    selections: [{ itemId: 'field:label', revisionId: 'revision-one' }],
    previewFingerprint: `sha256:${'a'.repeat(64)}`,
    operationId: 'restore-one',
  },
  preview_sequence_user_attachment_mutation: {
    documentId: 'package-one',
    kind: 'attach',
    sourcePath: 'project/trace.bin',
  },
  apply_sequence_user_attachment_mutation: {
    documentId: 'package-one',
    kind: 'attach',
    attachmentId: 'trace',
    sourcePath: 'project/trace.bin',
    operationId: 'user-attachment:00000000-0000-4000-8000-000000000001',
    memberId: '00000000-0000-4000-8000-000000000002',
    createdAt: '2026-09-30T00:00:00Z',
    fileName: 'trace.bin',
    sourceSha256: `sha256:${'a'.repeat(64)}`,
    sourceSizeBytes: 5,
    currentHeadId: 'revision-one',
    expectedMarkerSha256: `sha256:${'b'.repeat(64)}`,
    expectedProductSha256: `sha256:${'c'.repeat(64)}`,
    previewFingerprint: `sha256:${'d'.repeat(64)}`,
  },
  open_tab: { type: 'page', entityId: 'page-1', label: 'Page 1' },
  open_terminal: { mode: 'tab' },
  open_protocol_review: {
    pdfPath: 'papers/source.pdf',
    protocolPath: 'Protocols/Source/.forge/protocol.json',
  },
  revise_protocol_step: {
    path: 'protocols/source.dnaforge-protocol.json',
    stepId: 'step-1',
    contentText: 'Revised instructions.',
  },
  close_tab: {},
  configure_primer_tm: { model: 'q5-0' },
  get_primer_tm_config: {},
  get_external_agent_access: {},
  report_app_feedback: {
    observationId: '1ec40674-bf18-4d5b-a837-73505421bc8a',
    kind: 'feedback',
    summary: 'Tool feedback',
    description: 'Make errors actionable.',
  },
  configure_external_agent_access: {
    urlAccessEnabled: true,
    port: 29183,
    allowedHosts: ['laptop.tailnet.ts.net'],
  },
  design_primers: {
    documentId: 'sequence-document-1',
    target: { start: 100, end: 400 },
    application: 'pcr',
  },
  list_oligo_modifications: { vendor: 'idt', placement: 'internal' },
  create_primer: {
    name: 'Agent primer',
    artifactPath: 'primers/agent-primer.primer.json',
    oligo: { vendor: 'idt', notation: '/5Phos/ACGTACGTACGT/3SpC3/' },
  },
  save_designed_primer: {
    designId: `sha256:${'a'.repeat(64)}`,
    candidateId: `sha256:${'a'.repeat(64)}:pair-0:forward`,
    name: 'source_F',
    artifactPath: 'primers/source_F.primer.json',
  },
  update_primer: {
    primerId: 'primer-1',
    expectedArtifactRevision: 1,
    name: 'Renamed primer',
  },
  add_primer_binding: {
    primerId: 'primer-1',
    targetDocumentId: 'sequence-document-1',
    start: 100,
    end: 120,
    strand: 1,
    expectedArtifactRevision: 1,
  },
  update_primer_binding: {
    primerId: 'primer-1',
    bindingId: 'binding-1',
    targetDocumentId: 'sequence-document-1',
    start: 101,
    end: 121,
    strand: 1,
    expectedArtifactRevision: 2,
  },
  get_primer: { primerId: 'primer-1' },
  create_reference: {
    entityType: 'sequence',
    displayLabel: 'pUC19',
    documentId: 'sequence-document-1',
  },
  create_design: { name: 'Test design' },
  add_design_region: { designId: 'design-1', documentId: 'sequence-document-1' },
  draft_design_assembly: { designId: 'design-1' },
  import_sequence: { source: { kind: 'local_file', path: 'plasmids/source.gb' } },
  import_entities: {
    sourcePath: 'orders/proteins.csv',
    entityType: 'protein',
    destinationPath: 'proteins',
  },
  create_protein: {
    name: 'Agent protein',
    sequence: 'MPEPTIDEX*',
    destinationPath: 'proteins',
  },
  find_features: { documentId: 'sequence-document-1' },
  plan_design_regions: { documentId: 'sequence-document-1' },
  get_workspace: {},
  observe_app_state: {},
  get_design: { designId: 'design-1' },
  get_construct_lineage: { constructId: 'construct-1' },
  get_accepted_assembly: {
    constructId: 'construct-1',
    acceptedAssemblyVersionId: 'accepted-1',
  },
  preview_finalize_design_assembly: { designId: 'design-1', expectedDesignVersion: 1 },
  finalize_design_assembly: {
    designId: 'design-1',
    expectedDesignVersion: 1,
    previewFingerprint: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: 'finalize-1',
  },
  reopen_accepted_assembly: {
    constructId: 'construct-1',
    acceptedAssemblyVersionId: 'accepted-1',
    idempotencyKey: 'reopen-1',
  },
  set_junction_spacer: { designId: 'design-1', junctionIndex: 0, sequence: 'AAA' },
  set_golden_gate_schema: {
    designId: 'design-1',
    expectedDesignVersion: 1,
    schema: {
      id: 'custom-schema',
      name: 'Custom schema',
      revision: 1,
      origin: { type: 'custom' },
      enzyme: 'BsaI',
      slots: [
        {
          id: 'slot-1',
          label: 'Promoter',
          outgoingOverhang: 'AATG',
          preferredRoles: [{ label: 'Promoter' }],
        },
      ],
    },
  },
  get_moclo_factory: { designId: 'design-1' },
  list_moclo_schemas: { designId: 'design-1' },
  get_moclo_kit: { project: '/project-a' },
  save_moclo_kit: { project: '/project-a', kitId: 'custom-kit', expectedKitRevision: 1 },
  save_moclo_schema: {
    designId: 'design-1',
    expectedDesignVersion: 1,
    kitId: 'custom-kit',
    expectedKitRevision: 1,
    templateId: 'custom-schema',
    name: 'Custom schema',
    description: 'Reusable layout',
  },
  set_moclo_factory_stage: {
    designId: 'design-1',
    expectedDesignVersion: 1,
    kitId: 'ytk',
    recipeId: 'ytk-multigene-device',
    stageId: 'expression-cassette',
  },
  apply_moclo_schema: {
    designId: 'design-1',
    expectedDesignVersion: 1,
    kitId: 'ytk',
    recipeId: 'ytk-multigene-device',
    stageId: 'expression-cassette',
  },
  search_moclo_parts: { designId: 'design-1', slotId: 'type-3', query: 'GFP' },
  virtual_digest: { documentId: 'sequence-document-1', enzymes: ['BsaI'] },
  place_digest_fragment: {
    designId: 'design-1',
    documentId: 'sequence-document-1',
    enzymes: ['BsaI'],
    digestSnapshotId: 'snap-1',
    fragmentCandidateId: 'snap-1:0-10:10',
    idempotencyKey: 'placement-intent-1',
    mode: 'fill_empty',
    targetRegionId: 'region-1',
    expectedSlotFingerprint: 'fp-1',
  },
  set_primer_pbs_length: {
    designId: 'design-1',
    fragmentIndex: 0,
    direction: 'forward',
    length: 25,
  },
  set_primer_overhang_length: {
    designId: 'design-1',
    fragmentIndex: 0,
    direction: 'forward',
    length: 20,
  },
  set_golden_gate_offset: { designId: 'design-1', junctionIndex: 0, offset: 2 },
  set_pcr_polymerase: { designId: 'design-1', polymerase: 'q5' },
  remove_design_region: {
    designId: 'design-1',
    regionId: 'region-1',
    expectedSlotFingerprint: 'fp-1',
  },
  reorder_design_regions: {
    designId: 'design-1',
    order: ['region-2', 'region-1'],
  },
  plan_overhang_optimization: {
    designId: 'design-1',
  },
  apply_overhang_optimization: {
    designId: 'design-1',
    planId: 'ggopt2:BsaI-HFv2:plan-1',
    rank: 1,
  },
  get_sequence: { documentId: 'sequence-document-1' },
  get_sequence_genetic_code: { documentId: 'sequence-document-1' },
  set_sequence_genetic_code: { documentId: 'sequence-document-1', geneticCode: 3 },
  inspect_indexed_current_view: {},
  track_views: { operation: 'references' },
  sequence_data_layers: { operation: 'list', project: 'Project' },
  configure_indexed_track: {
    trackId: 'signal-1',
    settings: { color: '#e11d48', heightPx: 120 },
  },
  compose_indexed_track_view: {
    name: 'Figure 4N',
    tracks: [{ kind: 'bigwig-url', url: 'https://results.example.org/run/signal.bigWig' }],
  },
  inspect_reference_interval: {
    sourcePath: 'genomes/tiny.fa',
    chrom: 'chrI',
    start0: 0,
    end0: 9,
    strand: '+',
    operation: 'read',
  },
  set_indexed_current_view: { chrom: 'chrI', start0: 0, end0: 100 },
  add_indexed_bigwig_url: { url: 'https://results.example.org/run/signal.bigWig' },
  import_genome_sources: {
    sources: [
      {
        source: { kind: 'http', url: 'https://results.example.org/run/signal.bigWig' },
        formatId: 'bigwig',
      },
    ],
  },
  get_sequence_changes: { documentId: 'sequence-document-1' },
  lims_query_entities: { kind: 'plasmid', nameLike: 'pUC19', limit: 25 },
  lims_query_registry_summaries: {
    search: 'pUC19',
    representationKind: 'file_sequence',
    sort: 'name_asc',
    limit: 25,
  },
  lims_get_registry_preview: { entityId: 'demo-dna509-plasmid-puc19' },
  lims_get_entity: { entityId: 'demo-dna509-plasmid-puc19' },
  lims_resolve_open_target: { entityId: 'demo-dna509-plasmid-puc19' },
  lims_open_entity: { entityId: 'demo-dna509-plasmid-puc19' },
  mol_open_drawer: { documentId: 'sequence-document-1', annotationIndex: 0 },
  mol_open_tab: { structure: { kind: 'pdb', pdbId: '1RBL' } },
  mol_structures: { operation: 'list' },
  mol_activate_view: { structureViewId: 'view-1' },
  mol_data: { operation: 'inspect', structureViewId: 'view-1' },
  analyze_ngs_reads: { documentId: 'document-1', path: 'reads.fastq', name: 'Reads', preset: 'sr' },
  get_ngs_analysis: { documentId: 'document-1', operationId: 'job-1', name: 'Reads' },
  start_variant_calls: { documentId: 'document-1', path: 'calls.vcf', chrom: 'ref' },
  import_variant_calls: {
    documentId: 'document-1',
    operationId: 'job-1',
    name: 'Calls',
    chrom: 'ref',
  },
  get_variant_analysis: { analysisId: 'analysis-1' },
  color_variant_protein: { analysisId: 'analysis-1', name: 'Abundance' },
  manage_protein_structures: { action: 'compare', documentId: 'document-1' },
  inspect_variant_call: { analysisId: 'analysis-1', callId: 'call-1' },
  analyze_clone: { documentId: 'document-1', queryPaths: ['clone.fa'], name: 'Clone' },
  get_clone_analysis: { documentId: 'document-1', sessionId: 'session-1' },
  inspect_sequence_variant: {
    documentId: 'document-1',
    sessionId: 'session-1',
    trackId: 'track-1',
    mutationId: 'variant-1',
  },
  mol_apply_measurement: {
    structureViewId: 'view-1',
    measurement: {
      id: 'm',
      name: 'Measurement',
      proteinSequenceSha256: 'a'.repeat(64),
      source: { label: 'Counts', analysisId: 'analysis-1', revision: '1' },
      units: 'fraction',
      values: [{ residue: 1, value: 0.5 }],
      scale: {
        transform: 'linear',
        domain: [0, 1],
        colors: ['#000000', '#ffffff'],
        missingColor: '#aaaaaa',
      },
    },
  },
  mol_select_story_step: { structureViewId: 'view-1', index: 0 },
  mol_list_structures: {},
  mol_get_state: {},
  mol_get_scene: { structureViewId: 'view-1' },
  mol_apply_scene: { structureViewId: 'view-1', scene: '{}' },
  mol_align_structures: {
    structureViewId: 'view-1',
    referenceStructureRef: 'reference',
    mobileStructureRef: 'mobile',
    referenceRegion: { auth_asym_id: 'A' },
    mobileRegion: { auth_asym_id: 'B' },
  },
  mol_show_interaction_context: { structureViewId: 'view-1', selection: 'resn ATP' },
  mol_save_view: {
    structureViewId: 'view-1',
    title: 'Saved pocket',
    caption: 'Geometric contacts',
    evidence: [],
  },
  mol_save_to_notebook: {
    referenceId: '11111111-1111-4111-8111-111111111111',
    newNotebookTitle: 'Saved molecular result',
  },
  protein_get_context: { source: 'protein-mcp', operation: 'structure', pdbId: '1IEP' },
  mol_select_residues: { viewerId: 'viewer-1', selection: 'chain A and resi 1' },
  mol_set_representation: { viewerId: 'viewer-1', representation: 'cartoon' },
  mol_set_color: { viewerId: 'viewer-1', colorMode: 'chain' },
  mol_set_side_chains: {
    viewerId: 'viewer-1',
    target: 'visible_backbones',
    visible: true,
  },
  mol_focus: { viewerId: 'viewer-1', selection: 'chain A and resi 1' },
  mol_capture_screenshot: { viewerId: 'viewer-1' },
  seq_list_annotations: { documentId: 'sequence-document-1' },
  'workspace.gitStatus': {},
  'external.fetch': { provider: 'uniprot', external_id: 'P00880' },
  'external.xref': { provider: 'uniprot', external_id: 'P00880' },

  'compute.listProviders': {},
  'compute.listTools': { provider: 'tamarind', search: 'fold' },
  'compute.getSchema': { provider: 'tamarind', tool_id: 'alphafold' },
  'compute.validate': { provider: 'tamarind', tool_id: 'alphafold', settings: { sequence: 'MKT' } },
  'compute.estimate': { provider: 'tamarind', tool_id: 'alphafold', settings: { sequence: 'MKT' } },
  'compute.submit': {
    provider: 'tamarind',
    tool_id: 'alphafold',
    settings: { sequence: 'MKT' },
    label: 'job-1',
    estimated_cost: { amount: 0.4, unit: 'weighted_hours' },
  },
  'compute.status': { provider: 'tamarind', remote_id: 'job-1', tool_id: 'alphafold' },
  'compute.importResult': { provider: 'tamarind', remote_id: 'job-1', tool_id: 'alphafold' },
  'compute.cancel': { provider: 'tamarind', remote_id: 'job-1', tool_id: 'alphafold' },
  'assembly.listEditableFields': { designId: 'design-1' },
  'assembly.setEditableField': {
    designId: 'design-1',
    fieldId: 'junction:0:overlapLength',
    value: 24,
    expectedDesignVersion: 1,
  },

  selection_translate: { refId: 'ref-1' },
  backtranslate: { sequence: 'MSK', host: 'E_COLI_K12' },
  run_msa: { proteinIds: ['p1', 'p2'] },
  selection_reverse_complement: { refId: 'ref-1' },
  selection_restriction_sites: { refId: 'ref-1', enzymes: ['EcoRI'] },
  selection_gc_profile: { refId: 'ref-1' },
  selection_find_orfs: { refId: 'ref-1' },
  get_selection_bases: { refId: 'ref-1', start: 1, end: 10 },
  highlight_range: { documentId: 'sequence-document-1', start: 1, end: 10 },
  highlight_residues: {
    structureRef: 'viewer-1',
    chain: 'A',
    regions: [{ start: 1, end: 1 }],
  },
  list_saved_residue_selections: {},
  get_saved_residue_selection: { selectionId: 'selection-1' },
  save_active_residue_selection: { name: 'Catalytic pocket' },
  apply_saved_residue_selection: { selectionId: 'selection-1' },
};

describe('renderer tool allowlist gate', () => {
  it('exposes interaction context through the shared audited result-tool factory', () => {
    const definition = getAllowedRendererTool('mol_show_interaction_context');
    expect(definition).toMatchObject({
      required_capabilities: ['modify-tabs'],
      audit_required: true,
      effects: ['ui-bound'],
      exposure: { kind: 'shared' },
      execution: { kind: 'sdk', resultContract: 'explicit-v1' },
    });
    expect(definition?.inputSchema).toBe(molShowInteractionContextSchema);
  });

  it('matches the full shared renderer manifest', () => {
    expect(Object.keys(ALLOWED_RENDERER_TOOLS).sort()).toEqual([...manifestToolNames].sort());
    expect(getAllowedRendererTool('list_files')).not.toBeNull();
    expect(getAllowedRendererTool('read_file')).not.toBeNull();
    expect(getAllowedRendererTool('not_a_real_tool')).toBeNull();
  });

  it('requires one typed execution strategy, capabilities, audit, schemas, and effects', () => {
    for (const [toolName, definition] of Object.entries(ALLOWED_RENDERER_TOOLS)) {
      expect(definition.name, toolName).toBe(toolName);
      expect(['sdk', 'custom'], toolName).toContain(definition.execution.kind);
      if (definition.execution.kind === 'sdk') {
        expect(definition.execution.createTool, toolName).toEqual(expect.any(Function));
      } else {
        expect(definition.execution.handler, toolName).toEqual(expect.any(Function));
      }
      expect(definition.required_capabilities.length, toolName).toBeGreaterThan(0);
      expect(definition.audit_required, toolName).toBe(true);
      expect(
        rendererToolManifest.tools.find((tool) => tool.name === toolName)?.audit_required,
        `${toolName}: generated catalog preserves audit requirements`
      ).toBe(true);
      expect(definition.inputSchema.safeParse, toolName).toEqual(expect.any(Function));
      expect(definition.effects.length, toolName).toBeGreaterThan(0);

      if (definition.inputSchema instanceof z.ZodObject) {
        const shape = definition.inputSchema.shape;
        const schemaHasFields = Object.keys(shape).length > 0;
        const emptyInputReason =
          'emptyInputReason' in definition ? definition.emptyInputReason : undefined;
        expect(schemaHasFields || emptyInputReason, toolName).toBeTruthy();
      }
    }
  });

  it('collapses transparent wrappers into the generic SDK adapter', () => {
    const customNames = Object.values(ALLOWED_RENDERER_TOOLS)
      .filter((definition) => definition.execution.kind === 'custom')
      .map((definition) => definition.name)
      .sort();

    expect(customNames).toEqual(
      [
        'assembly.listEditableFields',
        'assembly.setEditableField',
        'external.fetch',
        'mol_capture_screenshot',
        'mol_open_drawer',
        'mol_open_tab',
        'seq_list_annotations',
      ].sort()
    );
  });

  it('keeps the full renderer behavior explicitly shared across Hosted and MCP', () => {
    expect(
      Object.values(ALLOWED_RENDERER_TOOLS).filter(
        (definition) => definition.exposure.kind !== 'shared'
      )
    ).toEqual([]);
  });

  it('keeps one valid input example per manifest tool and none for removed tools', () => {
    expect(Object.keys(validRendererArgs).sort()).toEqual([...manifestToolNames].sort());
  });

  it('rejects manifest-invalid unknown input keys for every allowlisted renderer tool', () => {
    for (const toolName of manifestToolNames) {
      const definition = getAllowedRendererTool(toolName);
      const validArgs = validRendererArgs[toolName];

      expect(validArgs, toolName).toBeDefined();
      expect(definition?.inputSchema.safeParse(validArgs).success, toolName).toBe(true);
      expect(() => resolveRendererToolAuthorization(toolName, validArgs), toolName).not.toThrow();
      expect(
        definition?.inputSchema.safeParse({
          ...(validArgs as Record<string, unknown>),
          unexpected: true,
        }).success,
        toolName
      ).toBe(false);
    }
  });

  it('rejects manifest-invalid unknown keys inside nested renderer tool objects', () => {
    expect(
      getAllowedRendererTool('mol_open_tab')?.inputSchema.safeParse({
        structure: { kind: 'pdb', pdbId: '1RBL', unexpected: true },
      }).success
    ).toBe(false);
    expect(
      getAllowedRendererTool('import_sequence')?.inputSchema.safeParse({
        source: { kind: 'local_file', path: 'plasmids/source.gb', unexpected: true },
      }).success
    ).toBe(false);
    expect(
      getAllowedRendererTool('seq_list_annotations')?.inputSchema.safeParse({
        documentId: 'sequence-document-1',
        filter: { unexpected: true },
      }).success
    ).toBe(false);
    expect(
      getAllowedRendererTool('seq_list_annotations')?.inputSchema.safeParse({
        documentId: 'sequence-document-1',
        filter: { range: { start: 1, end: 10, unexpected: true } },
      }).success
    ).toBe(false);
  });

  it('keeps the LIMS registry query tool aligned with the shared registry contract', () => {
    const manifestTool = rendererToolManifest.tools.find(
      (tool) => tool.name === 'lims_query_registry_summaries'
    );
    const properties = (manifestTool?.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    const sortProperty = properties?.sort as { enum?: string[] } | undefined;
    const representationKindProperty = properties?.representationKind as
      | { enum?: string[] }
      | undefined;

    expect(sortProperty?.enum).toEqual([...LIMS_REGISTRY_SORTS]);
    expect(representationKindProperty?.enum).toContain('genome_assembly');
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining([
        'nameLike',
        'sequenceLike',
        'registryIdLike',
        'registrationStatuses',
        'kinds',
        'speciesTaxids',
        'updatedOn',
        'updatedAfter',
        'updatedBefore',
      ])
    );

    expect(
      getAllowedRendererTool('lims_query_registry_summaries')?.inputSchema.safeParse({
        representationKind: 'genome_assembly',
        sort: 'registry_id_desc',
        nameLike: 'MG1655',
        sequenceLike: 'NC_',
        registryIdLike: 'g000001',
        registrationStatuses: ['registered'],
        kinds: ['genome'],
        speciesTaxids: ['562'],
        updatedAfter: 1,
        updatedBefore: 2,
        updatedOn: 1,
      }).success
    ).toBe(true);
  });

  it('rejects import_sequence before handler execution unless exactly one source form is present', () => {
    const schema = getAllowedRendererTool('import_sequence')?.inputSchema;

    expect(schema?.safeParse({}).success).toBe(false);
    expect(
      schema?.safeParse({
        source: { kind: 'local_file', path: 'plasmids/source.gb' },
        sourcePath: 'plasmids/source.gb',
      }).success
    ).toBe(false);
    expect(
      schema?.safeParse({
        source: { kind: 'local_file', path: 'plasmids/source.gb' },
      }).success
    ).toBe(true);
    expect(
      schema?.safeParse({
        sourcePath: 'plasmids/source.gb',
      }).success
    ).toBe(true);
  });

  it('requires primer-edit authority only for oligo imports, not protein imports', () => {
    const resolveAuthorization =
      getAllowedRendererTool('import_entities')?.resolveInputAuthorization;

    expect(resolveAuthorization?.({ entityType: 'protein' })).toEqual({});
    expect(resolveAuthorization?.({ entityType: 'dna_oligo' })).toEqual({
      additionalRequiredCapabilities: ['edit-primers'],
    });
    expect(resolveAuthorization?.({ entityType: 'rna_oligo' })).toEqual({
      additionalRequiredCapabilities: ['edit-primers'],
    });
  });
});

describe('native workflow operation authorization', () => {
  it.each([
    { kind: 'schema' },
    { kind: 'inspect' },
    { kind: 'table', command: { kind: 'inspect' } },
  ])(
    'keeps generic native notebook $kind reads available without workspace write authority',
    (command) => {
      expect(
        resolveRendererToolAuthorization('file_document', {
          operation: { kind: 'notebook', command },
        }).requiredCapabilities
      ).toEqual(['read-workspace']);
    }
  );
  it('keeps workspace write authority required for generic native notebook table edits', () => {
    expect(
      resolveRendererToolAuthorization('file_document', {
        operation: { kind: 'notebook', command: { kind: 'table', command: { kind: 'set-cell' } } },
      }).requiredCapabilities
    ).toContain('write-workspace');
  });
  const cases = [
    ['workspace_projects', 'list', 'rename', 'write-workspace'],
    ['workspace_files', 'list-trash', 'trash', 'write-workspace'],
    ['registry_records', 'inspect', 'update', 'write-workspace'],
    ['work_tasks', 'inspect', 'edit', 'write-workspace'],
    ['alignment_session', 'inspect', 'rename-session', 'write-workspace'],
    ['notebook_document', 'inspect', 'save', 'write-workspace'],
    ['sequence_document', 'inspect', 'save', 'write-workspace'],
    ['file_document', 'inspect', 'save', 'write-workspace'],
    ['app_views', 'inspect', 'activate', 'modify-tabs'],
    ['app_views', 'inspect-tracks', 'configure-tracks', 'modify-tabs'],
  ] as const;

  for (const [name, readKind, writeKind, capability] of cases) {
    it(`${name} keeps inspection available without granting its mutation`, () => {
      expect(
        resolveRendererToolAuthorization(name, { operation: { kind: readKind } })
          .requiredCapabilities
      ).not.toContain(capability);
      expect(
        resolveRendererToolAuthorization(name, { operation: { kind: writeKind } })
          .requiredCapabilities
      ).toContain(capability);
    });
  }

  it('requires workspace write authority for a table cell edit and not a table inspection', () => {
    expect(
      resolveRendererToolAuthorization('notebook_document', {
        operation: { kind: 'table', command: { kind: 'inspect' } },
      }).requiredCapabilities
    ).not.toContain('write-workspace');
    expect(
      resolveRendererToolAuthorization('notebook_document', {
        operation: { kind: 'table', command: { kind: 'set-cell' } },
      }).requiredCapabilities
    ).toContain('write-workspace');
  });
});
