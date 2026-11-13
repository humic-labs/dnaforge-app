import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { initPlatform, platform } from '../../platform';
import { useDesignStore } from '../design/store';
import { useCanvasStore } from '../canvas/store';
import { useStructure3dStore } from '../page/embeds/structure3d/store';
import { getStructureKey } from '../page/embeds/structure3d/molstar/cache';
import { resetCanvasStore } from '../ai/tools/test-helpers';
import {
  callRendererTool,
  createHttpRendererAuditSink,
  rendererToolCallError,
  type RendererAuditRecord,
  type RendererAuditSink,
  type RendererToolCallResponse,
} from './renderer-bridge';
import {
  ALLOWED_RENDERER_TOOLS,
  type RendererToolDefinition,
  type RendererToolName,
} from './renderer-tools';
import { setFileTree } from '../../test/platform-mocks';
import ytkKitDefinition from '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/ytk.json';

const TEST_SIDECAR_BASE_URL = 'http://agent-bridge-sidecar.test.invalid';
const TEST_AUDIT_API_URL = 'http://agent-audit-sidecar.test.invalid';

const folder: WorkspaceFolder = {
  path: '/tmp/waypoint-workspace',
  name: 'waypoint-workspace',
  addedAt: 1,
};

function request(tool_name: string, args: unknown = {}) {
  return {
    tool_name,
    args,
    agent_identity: 'agent-1',
    action_id: `action-${tool_name}`,
  };
}

function makeAuditSink() {
  const records: RendererAuditRecord[] = [];
  const sink: RendererAuditSink = {
    write: vi.fn(async (record) => {
      records.push(record);
      return `audit-${records.length}`;
    }),
  };
  return { sink, records };
}

function capabilitiesFor(toolName: RendererToolName): string[] {
  return [...ALLOWED_RENDERER_TOOLS[toolName].required_capabilities];
}

type RendererToolHandler = Extract<
  RendererToolDefinition['execution'],
  { kind: 'custom' }
>['handler'];

function mockRendererToolHandler(toolName: RendererToolName, implementation: RendererToolHandler) {
  const definition = ALLOWED_RENDERER_TOOLS[toolName];
  const originalExecution = definition.execution;
  const handler = vi.fn(implementation);
  (definition as { execution: RendererToolDefinition['execution'] }).execution = {
    kind: 'custom',
    resultContract: 'explicit-v1',
    handler,
  };
  return {
    handler,
    restore() {
      (definition as { execution: RendererToolDefinition['execution'] }).execution =
        originalExecution;
    },
  };
}

const openTabReceipt = { ok: true, tabId: 'tab-audit-fixture' } as const;
const bigWigReceipt = {
  ok: true,
  status: 'added',
  tabId: 'tab-genome',
  assemblyId: 'assembly-one',
  trackId: 'track-signal',
  label: 'signal.bigWig',
  url: 'https://results.example.org/run/signal.bigWig',
  laneCount: 1,
} as const;
const importedSequenceReceipt = {
  ok: true,
  imported: true,
  source: { kind: 'local_file' },
  documentId: 'sequence-document-imported',
  resourceUri: 'waypoint://sequence/sequence-document-imported',
  documents: [
    {
      documentId: 'sequence-document-imported',
      resourceUri: 'waypoint://sequence/sequence-document-imported',
      name: 'Imported sequence',
    },
  ],
  name: 'Imported sequence',
  format: 'genbank',
  circular: false,
  length: 4,
  featureCount: 0,
  opened: true,
  tabId: 'tab-imported-sequence',
} as const;
const primerNoResultReceipt = {
  ok: true,
  designed: false,
  code: 'PRIMER3_NO_RESULT',
  message: 'No valid primer pairs',
  warnings: ['target too constrained'],
  parameters: {},
} as const;

function savedResidueSelectionReceipt(toolName: string, structureRef = 'structure:1ABC') {
  const identity = {
    ok: true,
    stateChanged: true,
    selectionId: 'selection-1',
    revisionId: 'revision-1',
    structureRef,
  };
  return toolName === 'apply_saved_residue_selection'
    ? { ...identity, visible: true }
    : {
        ...identity,
        artifactPath: 'Selections/catalytic-pocket.selection.json',
        exactSelection: [{ chain: 'A', compId: 'GLY', ranges: [[57, 57]] }],
      };
}

function workspaceReceipt(folders: WorkspaceFolder[]) {
  return {
    ok: true,
    projects: folders.filter((folder) => !folder.pinned).map(({ name, path }) => ({ name, path })),
    referenceFolders: folders
      .filter((folder) => folder.pinned)
      .map(({ name, path }) => ({ name, path })),
    workspaceId: null,
    workspaceFile: null,
    focusedPanelId: 'main',
    panels: [],
    folders: folders.map(({ name, path, pinned }) => ({
      name,
      path,
      ...(pinned ? { pinned: true } : {}),
    })),
  };
}

function expectError(response: RendererToolCallResponse) {
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error('Expected renderer bridge error');
  return response;
}

function expectSuccess(response: RendererToolCallResponse) {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error('Expected renderer bridge success');
  return response;
}

describe('renderer bridge audit behavior', () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await initPlatform();
    resetCanvasStore();
    useStructure3dStore.setState({
      expandedStructures: {},
      interactionState: {},
      selectionAnchor: {},
      selectionRangeBase: {},
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as any).electronAPI;
    vi.unstubAllEnvs();
  });

  it('serializes a rejected untyped outcome with its stable code and diagnosis', async () => {
    const { sink } = makeAuditSink();
    const { restore } = mockRendererToolHandler('get_workspace', async () => ({ found: false }));
    try {
      const response = await callRendererTool(request('get_workspace'), {
        folders: [],
        currentWorkspaceId: null,
        agentCapabilities: ['read-workspace'],
        auditSink: sink,
      });
      expect(JSON.parse(JSON.stringify(expectError(response))).error).toMatchObject({
        code: 'INVALID_TOOL_RESULT',
        domain: 'core',
        retriable: false,
        message: 'Tool returned an invalid operation result; its effects are unknown.',
        details: { stateChanged: 'unknown', stateMayHaveChanged: true },
      });
    } finally {
      restore();
    }
  });

  it('rejects a malformed success receipt before recording successful completion', async () => {
    const { sink, records } = makeAuditSink();
    const { restore } = mockRendererToolHandler('report_app_feedback', async () => ({
      ok: true,
      reportId: 'not-a-uuid',
      status: 'submitted',
      duplicate: false,
    }));
    try {
      const response = await callRendererTool(
        request('report_app_feedback', {
          observationId: '1ec40674-bf18-4d5b-a837-73505421bc8a',
          kind: 'feedback',
          summary: 'Synthetic feedback',
          description: 'Review fixture.',
        }),
        {
          folders: [],
          currentWorkspaceId: null,
          agentCapabilities: ['submit-feedback'],
          auditSink: sink,
        }
      );
      expect(expectError(response).error).toMatchObject({
        code: 'INVALID_TOOL_OUTPUT',
        retriable: false,
        details: { stateMayHaveChanged: true },
      });
      expect(records.at(-1)?.outcome.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('validates and returns wire JSON, omitting undefined native parameters', async () => {
    const { sink } = makeAuditSink();
    const { restore } = mockRendererToolHandler('compute.getSchema', async () => ({
      ok: true,
      provider: 'tamarind',
      tool_id: 'example',
      schema: {
        type: 'object',
        default: { optional: undefined, at: new Date('2026-10-15T00:00:00Z') },
      },
    }));
    try {
      const response = await callRendererTool(
        request('compute.getSchema', { provider: 'tamarind', tool_id: 'example' }),
        {
          folders: [],
          currentWorkspaceId: null,
          agentCapabilities: ['external-compute:discover'],
          auditSink: sink,
        }
      );
      expect(expectSuccess(response).result).toMatchObject({
        schema: { default: { at: '2026-10-15T00:00:00.000Z' } },
      });
      expect(JSON.stringify(response)).not.toContain('optional');
    } finally {
      restore();
    }
  });

  it('rejects unserializable results with unknown effects and no automatic retry', async () => {
    const { sink, records } = makeAuditSink();
    const { restore } = mockRendererToolHandler('compute.getSchema', async () => ({
      ok: true,
      provider: 'tamarind',
      tool_id: 'example',
      schema: { default: BigInt(1) },
    }));
    try {
      const response = await callRendererTool(
        request('compute.getSchema', { provider: 'tamarind', tool_id: 'example' }),
        {
          folders: [],
          currentWorkspaceId: null,
          agentCapabilities: ['external-compute:discover'],
          auditSink: sink,
        }
      );
      expect(expectError(response).error).toMatchObject({
        code: 'INVALID_TOOL_OUTPUT',
        retriable: false,
        details: { stateMayHaveChanged: true },
      });
      expect(records.at(-1)?.outcome.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('uses a tool-owned audit projection without changing the returned result', async () => {
    const { sink, records } = makeAuditSink();
    const prepared = {
      ok: true,
      subject_id: 'msa:action-run_msa',
      input: {
        sequences: [
          { id: 'p1', name: 'Protein 1', sequence: 'MSKGEEL' },
          { id: 'p2', name: 'Protein 2', sequence: 'MSKGEEA' },
        ],
        algorithm: 'auto',
        threads: 4,
        timeout_seconds: 600,
      },
    };
    const { restore } = mockRendererToolHandler('run_msa', async () => prepared);

    try {
      const response = await callRendererTool(request('run_msa', { proteinIds: ['p1', 'p2'] }), {
        folders: [folder],
        boundWorkspaceId: folder.path,
        currentWorkspaceId: folder.path,
        agentCapabilities: capabilitiesFor('run_msa'),
        auditSink: sink,
      });

      expect(expectSuccess(response).result).toEqual(prepared);
      expect(records.at(-1)?.outcome).toEqual({
        ok: true,
        result: {
          subject_id: 'msa:action-run_msa',
          input: {
            sequence_count: 2,
            sequences: [
              { id: 'p1', sequence_length: 7 },
              { id: 'p2', sequence_length: 7 },
            ],
            algorithm: 'auto',
            threads: 4,
            timeout_seconds: 600,
          },
        },
      });
    } finally {
      restore();
    }
  });

  it('does not audit requests rejected before the renderer boundary', async () => {
    const { sink, records } = makeAuditSink();

    const badSession = await callRendererTool(request('get_workspace'), {
      expectedSessionToken: 'expected',
      providedSessionToken: 'wrong',
      auditSink: sink,
    });
    const unknownTool = await callRendererTool(request('not_a_real_tool'), { auditSink: sink });

    expect(expectError(badSession).error.code).toBe('BAD_SESSION');
    expect(expectError(unknownTool).error.code).toBe('UNKNOWN_TOOL');
    expect(records).toEqual([]);
  });

  it('audits insufficient capability rejections', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request('get_workspace'), {
      agentCapabilities: ['read-sequences'],
      auditSink: sink,
    });

    const errorResponse = expectError(response);
    expect(errorResponse.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(errorResponse.audit_id).toBe('audit-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action_id: 'action-get_workspace',
      tool_name: 'get_workspace',
      actor_kind: 'renderer',
      status: 'rejected',
      capability_check: {
        required: ['read-workspace'],
        satisfied: false,
        reason: 'insufficient_scope',
      },
    });
  });

  it.each([
    {
      provided: ['modify-tabs'],
      missing: 'external-fetch:annotation',
    },
    {
      provided: ['external-fetch:annotation'],
      missing: 'modify-tabs',
    },
  ])(
    'rejects add_indexed_bigwig_url before dispatch when $missing is missing',
    async ({ provided }) => {
      const { handler, restore } = mockRendererToolHandler(
        'add_indexed_bigwig_url',
        async () => bigWigReceipt
      );
      try {
        const { sink, records } = makeAuditSink();
        const response = await callRendererTool(
          request('add_indexed_bigwig_url', {
            url: 'https://results.example.org/run/signal.bigWig',
          }),
          {
            agentCapabilities: provided,
            auditSink: sink,
          }
        );

        expect(response).toEqual({
          ok: false,
          error: {
            code: 'INSUFFICIENT_SCOPE',
            domain: 'core',
            message:
              'Agent identity does not have the capabilities required for this renderer tool.',
            retriable: false,
            details: {
              required: ['modify-tabs', 'external-fetch:annotation'],
              provided,
            },
          },
          audit_id: 'audit-1',
        });
        expect(handler).not.toHaveBeenCalled();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          tool_name: 'add_indexed_bigwig_url',
          actor_scope: provided,
          status: 'rejected',
          capability_check: {
            required: ['modify-tabs', 'external-fetch:annotation'],
            effective_required: ['modify-tabs', 'external-fetch:annotation'],
            satisfied: false,
            reason: 'insufficient_scope',
          },
        });
      } finally {
        restore();
      }
    }
  );

  it('dispatches add_indexed_bigwig_url only when both static capabilities are granted', async () => {
    const { handler, restore } = mockRendererToolHandler(
      'add_indexed_bigwig_url',
      async () => bigWigReceipt
    );
    try {
      const { sink, records } = makeAuditSink();
      const response = await callRendererTool(
        request('add_indexed_bigwig_url', {
          url: 'https://results.example.org/run/signal.bigWig',
        }),
        {
          agentCapabilities: ['modify-tabs', 'external-fetch:annotation'],
          auditSink: sink,
        }
      );

      expect(response).toMatchObject({
        ok: true,
        result: { ok: true, status: 'added' },
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(records.map((record) => record.status)).toEqual(['accepted', 'completed']);
      expect(records.map((record) => record.capability_check)).toEqual([
        {
          required: ['modify-tabs', 'external-fetch:annotation'],
          effective_required: ['modify-tabs', 'external-fetch:annotation'],
          satisfied: true,
          reason: 'granted',
        },
        {
          required: ['modify-tabs', 'external-fetch:annotation'],
          effective_required: ['modify-tabs', 'external-fetch:annotation'],
          satisfied: true,
          reason: 'granted',
        },
      ]);
    } finally {
      restore();
    }
  });

  it('completes a Golden Gate schema mutation through the canonical renderer bridge', async () => {
    useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
    const designStore = useDesignStore.getState();
    const designId = designStore.createDesign('Bridge schema target', 'circular', 'goldengate');
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(
      request('set_golden_gate_schema', {
        designId,
        expectedDesignVersion: 0,
        schema: {
          id: 'bridge-schema',
          name: 'Bridge schema',
          revision: 1,
          origin: { type: 'custom' },
          enzyme: 'BsaI',
          slots: [
            {
              id: 'promoter',
              label: 'Promoter',
              outgoingOverhang: 'AATG',
              preferredRoles: [{ label: 'Promoter' }],
            },
          ],
        },
      }),
      {
        agentCapabilities: capabilitiesFor('set_golden_gate_schema'),
        auditSink: sink,
      }
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        status: 'applied',
        designId,
        designVersion: 1,
        mutation: { effect: 'set_golden_gate_schema', changed: true },
      },
    });
    expect(records.map((record) => record.status)).toEqual(['accepted', 'completed']);
    expect(useDesignStore.getState().designs[designId].goldenGateSchema?.id).toBe('bridge-schema');
  });

  it('reads and selects a real MoClo factory stage through the canonical renderer bridge', async () => {
    useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
    const designId = useDesignStore
      .getState()
      .createDesign('Bridge MoClo target', 'circular', 'goldengate');
    setFileTree(`${folder.path}/.forge/moclo-kits`, [
      {
        name: 'ytk.json',
        isDirectory: false,
        content: JSON.stringify(ytkKitDefinition),
      },
    ]);
    const { sink, records } = makeAuditSink();

    const readResponse = await callRendererTool(request('get_moclo_factory', { designId }), {
      folders: [folder],
      agentCapabilities: capabilitiesFor('get_moclo_factory'),
      auditSink: sink,
    });
    expect(readResponse).toMatchObject({
      ok: true,
      result: {
        status: 'ready',
        designId,
        designVersion: 0,
        kits: [
          {
            id: 'ytk',
            revision: 1,
            memberCount: 96,
            recipes: [
              {
                id: 'ytk-multigene-device',
                stages: [
                  { id: 'cassette-vector' },
                  { id: 'expression-cassette', inputsFromStages: ['cassette-vector'] },
                  {
                    id: 'multigene-device',
                    inputsFromStages: ['expression-cassette'],
                  },
                ],
              },
            ],
          },
          { id: 'moclo-cidar', memberCount: 0 },
        ],
      },
    });

    const setResponse = await callRendererTool(
      request('set_moclo_factory_stage', {
        designId,
        expectedDesignVersion: 0,
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        runId: 'bridge-ytk-run',
      }),
      {
        folders: [folder],
        agentCapabilities: capabilitiesFor('set_moclo_factory_stage'),
        auditSink: sink,
      }
    );
    expect(setResponse).toMatchObject({
      ok: true,
      result: {
        status: 'applied',
        designId,
        designVersion: 1,
        mutation: { effect: 'set_moclo_factory_stage', changed: true },
      },
    });
    expect(useDesignStore.getState().designs[designId]).toMatchObject({
      mocloFactory: {
        runId: 'bridge-ytk-run',
        kitId: 'ytk',
        kitRevision: 1,
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
        stageInputs: [{ slotId: 'cassette-vector-output', sourceStageId: 'cassette-vector' }],
      },
      goldenGateSchema: {
        id: 'ytk:ytk-multigene-device:expression-cassette',
        enzyme: 'BsaI',
      },
    });
    expect(records.map((record) => record.status)).toEqual(['completed', 'accepted', 'completed']);
  });

  it('lists and applies a reusable MoClo schema without creating factory-run state', async () => {
    useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
    const designId = useDesignStore
      .getState()
      .createDesign('Bridge MoClo schema target', 'circular', 'goldengate');
    setFileTree(`${folder.path}/.forge/moclo-kits`, [
      {
        name: 'ytk.json',
        isDirectory: false,
        content: JSON.stringify(ytkKitDefinition),
      },
    ]);
    const { sink, records } = makeAuditSink();

    const listResponse = await callRendererTool(request('list_moclo_schemas', { designId }), {
      folders: [folder],
      agentCapabilities: capabilitiesFor('list_moclo_schemas'),
      auditSink: sink,
    });
    expect(listResponse).toMatchObject({
      ok: true,
      result: {
        status: 'ready',
        designId,
        schemas: expect.arrayContaining([
          expect.objectContaining({
            kitId: 'ytk',
            recipeId: 'ytk-multigene-device',
            stageId: 'expression-cassette',
            slotCount: 4,
          }),
        ]),
      },
    });

    const applyResponse = await callRendererTool(
      request('apply_moclo_schema', {
        designId,
        expectedDesignVersion: 0,
        kitId: 'ytk',
        recipeId: 'ytk-multigene-device',
        stageId: 'expression-cassette',
      }),
      {
        folders: [folder],
        agentCapabilities: capabilitiesFor('apply_moclo_schema'),
        auditSink: sink,
      }
    );
    expect(applyResponse).toMatchObject({
      ok: true,
      result: {
        status: 'applied',
        designId,
        designVersion: 1,
        slotCount: 4,
        mutation: { effect: 'set_golden_gate_schema', changed: true },
      },
    });
    expect(useDesignStore.getState().designs[designId]).toMatchObject({
      goldenGateSchema: { id: 'ytk:ytk-multigene-device:expression-cassette' },
      regions: [{}, {}, {}, {}],
    });
    expect(useDesignStore.getState().designs[designId].mocloFactory).toBeUndefined();
    expect(records.map((record) => record.status)).toEqual(['completed', 'accepted', 'completed']);
  });

  it('exposes kit inspection without a design and refuses read-only kit writes at the shared bridge', async () => {
    const { sink } = makeAuditSink();
    const before = structuredClone(useDesignStore.getState().designs);
    const context = { folders: [folder], agentCapabilities: ['read-workspace'], auditSink: sink };
    const inspected = expectSuccess(
      await callRendererTool(request('get_moclo_kit', { project: folder.path }), context)
    );
    expect(inspected.result).toMatchObject({
      status: 'ready',
      kits: expect.arrayContaining([expect.objectContaining({ id: 'moclo-cidar' })]),
    });
    const denied = expectError(
      await callRendererTool(
        request('save_moclo_kit', { project: folder.path, kitId: 'test', expectedKitRevision: 0 }),
        context
      )
    );
    expect(denied.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(useDesignStore.getState().designs).toEqual(before);
  });

  it('requires external annotation authority for NCBI and public-URL sequence imports', async () => {
    const { handler, restore } = mockRendererToolHandler(
      'import_sequence',
      async () => importedSequenceReceipt
    );
    try {
      const { sink, records } = makeAuditSink();
      for (const source of [
        { kind: 'ncbi', accession: 'NC_000913.3' },
        { kind: 'url', url: 'https://example.com/sequence.gb' },
      ]) {
        const errorResponse = expectError(
          await callRendererTool(request('import_sequence', { source }), {
            folders: [folder],
            agentCapabilities: capabilitiesFor('import_sequence'),
            auditSink: sink,
          })
        );
        expect(errorResponse.error.code).toBe('INSUFFICIENT_SCOPE');
      }
      expect(handler).not.toHaveBeenCalled();
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record.capability_check).toMatchObject({
          effective_required: [
            'create-entity',
            'read-sequences',
            'modify-tabs',
            'external-fetch:annotation',
          ],
          satisfied: false,
        });
      }
    } finally {
      restore();
    }
  });

  it('does not require external authority for local sequence imports', async () => {
    const { handler, restore } = mockRendererToolHandler(
      'import_sequence',
      async () => importedSequenceReceipt
    );
    try {
      const { sink, records } = makeAuditSink();
      const response = await callRendererTool(
        request('import_sequence', {
          source: { kind: 'local_file', path: 'plasmids/source.gb' },
        }),
        {
          folders: [folder],
          agentCapabilities: capabilitiesFor('import_sequence'),
          auditSink: sink,
        }
      );

      expectSuccess(response);
      expect(handler).toHaveBeenCalledOnce();
      expect(records.map((record) => record.status)).toEqual(['accepted', 'completed']);
      expect(records[0]?.capability_check.effective_required).toEqual(
        capabilitiesFor('import_sequence')
      );
    } finally {
      restore();
    }
  });

  it('requires external compute authority only for NEB primer calculations', async () => {
    const { handler, restore } = mockRendererToolHandler(
      'design_primers',
      async () => primerNoResultReceipt
    );
    try {
      const { sink, records } = makeAuditSink();
      const response = await callRendererTool(
        request('design_primers', {
          documentId: 'sequence-document-source',
          target: { start: 0, end: 100 },
          tmModel: 'q5-0',
        }),
        {
          folders: [folder],
          agentCapabilities: capabilitiesFor('design_primers'),
          auditSink: sink,
        }
      );

      expect(expectError(response).error.code).toBe('INSUFFICIENT_SCOPE');
      expect(handler).not.toHaveBeenCalled();
      expect(records[0]?.capability_check.effective_required).toEqual([
        'read-workspace',
        'read-sequences',
        'external-compute:tm',
      ]);
    } finally {
      restore();
    }
  });

  it('requires external compute authority when polymerase selects the NEB calculator', async () => {
    const { handler, restore } = mockRendererToolHandler(
      'design_primers',
      async () => primerNoResultReceipt
    );
    try {
      const { sink, records } = makeAuditSink();
      const response = await callRendererTool(
        request('design_primers', {
          documentId: 'sequence-document-source',
          target: { start: 0, end: 100 },
          polymerase: 'Q5',
        }),
        {
          folders: [folder],
          agentCapabilities: capabilitiesFor('design_primers'),
          auditSink: sink,
        }
      );

      expect(expectError(response).error.code).toBe('INSUFFICIENT_SCOPE');
      expect(handler).not.toHaveBeenCalled();
      expect(records[0]?.capability_check.effective_required).toEqual([
        'read-workspace',
        'read-sequences',
        'external-compute:tm',
      ]);
    } finally {
      restore();
    }
  });

  it('keeps local primer calculations inside the base primer-design scope', async () => {
    const { handler, restore } = mockRendererToolHandler(
      'design_primers',
      async () => primerNoResultReceipt
    );
    try {
      const { sink, records } = makeAuditSink();
      const response = await callRendererTool(
        request('design_primers', {
          documentId: 'sequence-document-source',
          target: { start: 0, end: 100 },
          polymerase: 'Q5',
          tmModel: 'local',
        }),
        {
          folders: [folder],
          agentCapabilities: capabilitiesFor('design_primers'),
          auditSink: sink,
        }
      );

      expectSuccess(response);
      expect(handler).toHaveBeenCalledOnce();
      expect(records[0]?.capability_check.effective_required).toEqual(
        capabilitiesFor('design_primers')
      );
    } finally {
      restore();
    }
  });

  it('requires read scope for live structure references without requiring a mounted workspace', async () => {
    const { sink, records } = makeAuditSink();
    const { handler, restore } = mockRendererToolHandler('create_reference', async () => ({
      ok: true,
      referenceId: 'reference-1',
    }));

    try {
      const deniedDirect = await callRendererTool(
        request('create_reference', {
          entityType: 'structure',
          displayLabel: 'ALA 57',
          selection: {
            kind: 'structure',
            structureRef: 'PDB:3OAA',
            residues: [{ chain: 'A', authSeqId: 57, labelCompId: 'ALA' }],
          },
        }),
        {
          agentCapabilities: ['create-entity'],
          auditSink: sink,
        }
      );

      expect(expectError(deniedDirect).error).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
        details: {
          required: ['create-entity', 'read-workspace'],
          provided: ['create-entity'],
        },
      });
      expect(handler).not.toHaveBeenCalled();

      const direct = await callRendererTool(
        request('create_reference', {
          entityType: 'structure',
          displayLabel: 'ALA 57',
          selection: {
            kind: 'structure',
            structureRef: 'PDB:3OAA',
            residues: [{ chain: 'A', authSeqId: 57, labelCompId: 'ALA' }],
          },
        }),
        {
          agentCapabilities: ['create-entity', 'read-workspace'],
          auditSink: sink,
        }
      );

      expectSuccess(direct);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(records.at(-1)?.capability_check).toMatchObject({
        required: ['create-entity'],
        effective_required: ['create-entity', 'read-workspace'],
        satisfied: true,
      });

      const saved = await callRendererTool(
        request('create_reference', {
          entityType: 'structure',
          displayLabel: 'Saved pocket',
          selection: {
            kind: 'saved_residue_selection',
            selectionId: 'selection-1',
          },
        }),
        {
          folders: [folder],
          currentWorkspaceId: folder.path,
          agentCapabilities: ['create-entity'],
          auditSink: sink,
        }
      );

      expect(expectError(saved).error).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
        details: {
          required: ['create-entity', 'read-workspace'],
          provided: ['create-entity'],
        },
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(records.at(-1)?.capability_check).toMatchObject({
        required: ['create-entity'],
        effective_required: ['create-entity', 'read-workspace'],
        satisfied: false,
      });
    } finally {
      restore();
    }
  });

  it('audits a returned domain failure as failed and preserves partial-effect details', async () => {
    const { sink, records } = makeAuditSink();
    const { restore } = mockRendererToolHandler('save_active_residue_selection', async () => ({
      ok: false,
      code: 'SAVE_FAILED',
      retriable: false,
      error: 'Selection artifact write failed after pinning coordinates',
      stateChanged: true,
      partialEffects: [
        {
          kind: 'structure-coordinate-artifact',
          path: 'Structures/3OAA.cif',
        },
      ],
      details: {
        requestedLength: 60_000,
        maxInlineBp: 50_000,
      },
    }));

    try {
      const response = await callRendererTool(
        request('save_active_residue_selection', {
          structureRef: 'structure:3OAA',
          name: 'Catalytic pocket',
        }),
        {
          folders: [folder],
          currentWorkspaceId: folder.path,
          agentCapabilities: capabilitiesFor('save_active_residue_selection'),
          auditSink: sink,
        }
      );

      expect(expectError(response).error).toMatchObject({
        code: 'SAVE_FAILED',
        retriable: false,
        details: {
          domainCode: 'SAVE_FAILED',
          stateChanged: true,
          requestedLength: 60_000,
          maxInlineBp: 50_000,
        },
      });
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ status: 'accepted' });
      expect(records[1]).toMatchObject({
        status: 'failed',
        error: {
          code: 'SAVE_FAILED',
          retriable: false,
          details: {
            domainCode: 'SAVE_FAILED',
            stateChanged: true,
            requestedLength: 60_000,
            maxInlineBp: 50_000,
            partialEffects: [
              {
                kind: 'structure-coordinate-artifact',
                path: 'Structures/3OAA.cif',
              },
            ],
          },
        },
      });
    } finally {
      restore();
    }
  });

  it('does not infer retryability merely because a returned domain failure changed no state', async () => {
    const { sink, records } = makeAuditSink();
    const { restore } = mockRendererToolHandler('save_active_residue_selection', async () => ({
      ok: false,
      code: 'NO_ACTIVE_SELECTION',
      retriable: false,
      error: 'No active residues are selected',
      stateChanged: false,
      partialEffects: [],
    }));

    try {
      expect(
        expectError(
          await callRendererTool(
            request('save_active_residue_selection', {
              structureRef: 'structure:3OAA',
              name: 'Catalytic pocket',
            }),
            {
              folders: [folder],
              currentWorkspaceId: folder.path,
              agentCapabilities: capabilitiesFor('save_active_residue_selection'),
              auditSink: sink,
            }
          )
        ).error
      ).toMatchObject({
        code: 'NO_ACTIVE_SELECTION',
        retriable: false,
        details: { domainCode: 'NO_ACTIVE_SELECTION', stateChanged: false },
      });
      expect(records.at(-1)).toMatchObject({
        status: 'failed',
        error: {
          code: 'NO_ACTIVE_SELECTION',
          retriable: false,
          details: { domainCode: 'NO_ACTIVE_SELECTION', stateChanged: false, partialEffects: [] },
        },
      });
    } finally {
      restore();
    }
  });

  it('never reports completion when the handler ran but terminal audit persistence failed', async () => {
    const { handler, restore } = mockRendererToolHandler('open_tab', async () => openTabReceipt);
    let writes = 0;
    const sink: RendererAuditSink = {
      write: vi.fn(async () => {
        writes += 1;
        if (writes === 1) return 'accepted-audit';
        throw new Error('terminal audit store offline');
      }),
    };

    try {
      const response = await callRendererTool(
        request('open_tab', {
          type: 'structure',
          entityId: 'structure:1RBL',
          label: '1RBL',
        }),
        { agentCapabilities: capabilitiesFor('open_tab'), auditSink: sink }
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(expectError(response)).toMatchObject({
        audit_id: 'accepted-audit',
        error: {
          code: 'AUDIT_UNAVAILABLE',
          details: { terminalStatus: 'completed', stateMayHaveChanged: true },
        },
      });
    } finally {
      restore();
    }
  });

  it('requires an open workspace for saved-selection references only', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(
      request('create_reference', {
        entityType: 'structure',
        displayLabel: 'Saved pocket',
        selection: {
          kind: 'saved_residue_selection',
          selectionId: 'selection-1',
        },
      }),
      {
        agentCapabilities: ['create-entity', 'read-workspace'],
        auditSink: sink,
      }
    );

    expect(expectError(response).error.code).toBe('NO_WORKSPACE');
    expect(records[0].capability_check).toMatchObject({
      required: ['create-entity'],
      effective_required: ['create-entity', 'read-workspace'],
    });
  });

  it.each([
    ['save_active_residue_selection', { structureRef: 'structure:1ABC', name: 'Catalytic pocket' }],
    [
      'apply_saved_residue_selection',
      { selectionId: 'selection-1', structureRef: 'structure:1ABC' },
    ],
  ] as const)(
    '%s requires external structure authority only for a remote coordinate fetch',
    async (toolName, args) => {
      const { sink, records } = makeAuditSink();
      const { handler, restore } = mockRendererToolHandler(toolName, async () =>
        savedResidueSelectionReceipt(toolName)
      );

      try {
        useStructure3dStore
          .getState()
          .registerStructure('structure:1ABC', { source: 'pdb', sourceId: '1ABC' }, '1ABC');
        useCanvasStore.getState().openTab('main', {
          type: 'structure',
          entityId: 'structure:1ABC',
          label: '1ABC',
        });

        const unpinned = await callRendererTool(request(toolName, args), {
          folders: [folder],
          currentWorkspaceId: folder.path,
          agentCapabilities: capabilitiesFor(toolName),
          auditSink: sink,
        });

        expect(expectError(unpinned).error).toMatchObject({
          code: 'INSUFFICIENT_SCOPE',
          details: {
            required: expect.arrayContaining(['external-fetch:structure']),
          },
        });
        expect(handler).not.toHaveBeenCalled();
        expect(records.at(-1)?.capability_check).toMatchObject({
          required: capabilitiesFor(toolName),
          effective_required: expect.arrayContaining(['external-fetch:structure']),
          satisfied: false,
        });

        useStructure3dStore.getState().updateStructureData('structure:1ABC', {
          source: 'file',
          sourceId:
            'ATOM      1  CA  GLY A  57      11.000  12.000  13.000  1.00 20.00           C\nEND\n',
        });

        const inline = await callRendererTool(request(toolName, args), {
          folders: [folder],
          currentWorkspaceId: folder.path,
          agentCapabilities: capabilitiesFor(toolName),
          auditSink: sink,
        });

        expectSuccess(inline);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(records.at(-1)?.capability_check).toMatchObject({
          required: capabilitiesFor(toolName),
          effective_required: capabilitiesFor(toolName),
          satisfied: true,
        });

        useStructure3dStore.getState().updateStructureData('structure:1ABC', {
          source: 'pdb',
          sourceId: '1ABC',
          structureArtifactRef: {
            entityId: 'structure-asset-1',
            revisionId: 'structure-revision-1',
            structureId: 'structure:1ABC',
            coordinateDigestSha256: 'coordinate-digest',
            artifactPath: 'Structures/1ABC.cif',
            format: 'mmcif',
          },
        });

        const pinned = await callRendererTool(request(toolName, args), {
          folders: [folder],
          currentWorkspaceId: folder.path,
          agentCapabilities: capabilitiesFor(toolName),
          auditSink: sink,
        });

        expectSuccess(pinned);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(records.at(-1)?.capability_check).toMatchObject({
          required: capabilitiesFor(toolName),
          effective_required: capabilitiesFor(toolName),
          satisfied: true,
        });
      } finally {
        restore();
      }
    }
  );

  it('recognizes a pinned coordinate artifact when the caller uses the Mol* viewer id', async () => {
    const { sink, records } = makeAuditSink();
    const { handler, restore } = mockRendererToolHandler(
      'save_active_residue_selection',
      async () => savedResidueSelectionReceipt('save_active_residue_selection', viewerId)
    );
    const viewerId = getStructureKey('1ABC');

    try {
      useStructure3dStore.getState().registerStructure(
        'catalog-structure-1',
        {
          source: 'pdb',
          sourceId: '1ABC',
          pdbId: '1ABC',
          structureArtifactRef: {
            entityId: 'structure-asset-1',
            revisionId: 'structure-revision-1',
            structureId: 'catalog-structure-1',
            coordinateDigestSha256: 'coordinate-digest',
            artifactPath: 'Structures/1ABC.cif',
            format: 'mmcif',
          },
        },
        '1ABC'
      );
      useCanvasStore.getState().openTab('main', {
        type: 'structure',
        entityId: 'catalog-structure-1',
        label: '1ABC',
      });

      const response = await callRendererTool(
        request('save_active_residue_selection', {
          structureRef: viewerId,
          name: 'Catalytic pocket',
        }),
        {
          folders: [folder],
          currentWorkspaceId: folder.path,
          agentCapabilities: capabilitiesFor('save_active_residue_selection'),
          auditSink: sink,
        }
      );

      expectSuccess(response);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(records.at(-1)?.capability_check.effective_required).toEqual(
        capabilitiesFor('save_active_residue_selection')
      );
    } finally {
      restore();
    }
  });

  it('audits workspace routing failures before handlers run', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request('get_workspace'), {
      agentCapabilities: capabilitiesFor('get_workspace'),
      boundWorkspaceId: 'workspace-A',
      currentWorkspaceId: 'workspace-B',
      auditSink: sink,
    });

    const errorResponse = expectError(response);
    expect(errorResponse.error.code).toBe('WRONG_WORKSPACE');
    expect(errorResponse.error.details?.stateMayHaveChanged).toBe(false);
    expect(errorResponse.audit_id).toBe('audit-1');
    expect(records[0].capability_check.reason).toBe('wrong_workspace');
  });

  it('keeps a folder-root grant on its intended project when other roots mount', async () => {
    const { sink } = makeAuditSink();
    const otherFolder: WorkspaceFolder = {
      path: '/tmp/another-workspace',
      name: 'another-workspace',
      addedAt: 2,
    };
    const { handler, restore } = mockRendererToolHandler('get_workspace', async (_args, context) =>
      workspaceReceipt(context.folders)
    );

    try {
      const response = await callRendererTool(request('get_workspace'), {
        agentCapabilities: capabilitiesFor('get_workspace'),
        boundWorkspaceId: `folder:${JSON.stringify(folder.path)}`,
        currentWorkspaceId: `folders:${JSON.stringify([otherFolder.path, folder.path].sort())}`,
        folders: [otherFolder, folder],
        auditSink: sink,
      });

      expect(expectSuccess(response).result).toEqual(workspaceReceipt([folder]));
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it('refuses a folder-root grant when its project is no longer uniquely mounted', async () => {
    const { sink } = makeAuditSink();
    const { handler, restore } = mockRendererToolHandler('get_workspace', async () =>
      workspaceReceipt([])
    );

    try {
      const response = await callRendererTool(request('get_workspace'), {
        agentCapabilities: capabilitiesFor('get_workspace'),
        boundWorkspaceId: `folder:${JSON.stringify(folder.path)}`,
        currentWorkspaceId: 'folders:["/tmp/another-workspace"]',
        folders: [{ path: '/tmp/another-workspace', name: 'another-workspace', addedAt: 2 }],
        auditSink: sink,
      });

      expect(expectError(response).error.code).toBe('WRONG_WORKSPACE');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('audits no-workspace failures for workspace-bound tools', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request('find_features', { path: 'a.gb' }), {
      agentCapabilities: capabilitiesFor('find_features'),
      currentWorkspaceId: null,
      folders: [],
      auditSink: sink,
    });

    const errorResponse = expectError(response);
    expect(errorResponse.error.code).toBe('NO_WORKSPACE');
    expect(errorResponse.audit_id).toBe('audit-1');
    expect(records[0].tool_name).toBe('find_features');
  });

  it('exposes registry summaries and previews to agents through the audited bridge', async () => {
    const { sink, records } = makeAuditSink();
    const entity = await platform().lims.registerEntity({
      kind: 'plasmid',
      name: `Agent registry pUC19 ${Date.now()}`,
      fields: {
        sequence: {
          mode: 'file',
          documentId: 'sequence-document-puc19',
          relPath: '/workspace/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:agent-registry-preview',
          sourceFormat: 'gb',
        },
      },
      registrationStatus: 'registered',
      actor: 'test',
    });

    const summariesResponse = await callRendererTool(
      request('lims_query_registry_summaries', {
        search: entity.name,
        representationKind: 'file_sequence',
        limit: 5,
      }),
      {
        agentCapabilities: capabilitiesFor('lims_query_registry_summaries'),
        auditSink: sink,
      }
    );
    const summariesSuccess = expectSuccess(summariesResponse);
    expect(summariesSuccess.result).toMatchObject({
      totalCount: 1,
      summaries: [
        expect.objectContaining({
          id: entity.id,
          name: entity.name,
          representation: expect.objectContaining({
            kind: 'file_sequence',
            canOpen: true,
            openTarget: expect.objectContaining({ entityId: entity.id }),
          }),
          sequenceSummary: expect.objectContaining({ topology: 'circular', length: 2686 }),
        }),
      ],
    });

    const previewResponse = await callRendererTool(
      request('lims_get_registry_preview', { entityId: entity.id }),
      {
        agentCapabilities: capabilitiesFor('lims_get_registry_preview'),
        auditSink: sink,
      }
    );
    const previewSuccess = expectSuccess(previewResponse);
    expect(previewSuccess.result).toMatchObject({
      entity: expect.objectContaining({ id: entity.id, name: entity.name }),
      summary: expect.objectContaining({
        id: entity.id,
        representation: expect.objectContaining({
          openTarget: expect.objectContaining({ entityId: entity.id }),
        }),
        sequenceSummary: expect.objectContaining({ topology: 'circular', length: 2686 }),
      }),
    });
    expect(records.map((record) => [record.tool_name, record.status])).toEqual([
      ['lims_query_registry_summaries', 'completed'],
      ['lims_get_registry_preview', 'completed'],
    ]);
  });

  it.each([
    ['open_tab', {}],
    ['create_design', {}],
    ['add_design_region', {}],
    ['draft_design_assembly', {}],
    ['import_sequence', { open: 'yes' }],
    ['create_reference', {}],
    ['get_design', {}],
    ['get_sequence', {}],
    ['find_features', {}],
    ['plan_design_regions', {}],
    ['get_sequence_changes', {}],
    ['lims_query_entities', { limit: 'many' }],
    ['lims_query_registry_summaries', { limit: 'many' }],
    ['lims_get_registry_preview', {}],
    ['lims_get_entity', {}],
    ['lims_resolve_open_target', {}],
    ['lims_open_entity', {}],
    ['workspace.gitStatus', { includeLog: 'yes' }],
  ] as const)('audits bad input for %s without executing the handler', async (toolName, args) => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request(toolName, args), {
      agentCapabilities: capabilitiesFor(toolName),
      boundWorkspaceId: 'workspace-A',
      currentWorkspaceId: 'workspace-A',
      folders: [folder],
      auditSink: sink,
    });

    const errorResponse = expectError(response);
    expect(errorResponse.error.code).toBe('BAD_INPUT');
    expect(errorResponse.audit_id).toBe('audit-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool_name: toolName,
      status: 'rejected',
      capability_check: {
        satisfied: true,
        reason: 'granted',
      },
    });
  });

  it.each(['get_workspace', 'observe_app_state', 'close_tab'] as const)(
    'audits successful empty-input tool %s',
    async (toolName) => {
      const { sink, records } = makeAuditSink();

      const response = await callRendererTool(request(toolName), {
        agentCapabilities: capabilitiesFor(toolName),
        auditSink: sink,
      });

      const successResponse = expectSuccess(response);
      const isSideEffecting = ALLOWED_RENDERER_TOOLS[toolName].effects.some(
        (effect) => effect !== 'read-only'
      );
      expect(successResponse.audit_id).toBe(isSideEffecting ? 'audit-2' : 'audit-1');
      expect(records).toHaveLength(isSideEffecting ? 2 : 1);
      if (isSideEffecting) {
        expect(records[0]).toMatchObject({
          tool_name: toolName,
          status: 'accepted',
          capability_check: {
            satisfied: true,
            reason: 'granted',
          },
        });
      }
      expect(records.at(-1)).toMatchObject({
        tool_name: toolName,
        status: 'completed',
        capability_check: {
          satisfied: true,
          reason: 'granted',
        },
      });
    }
  );

  it('fails closed before running side-effecting handlers when accepted audit persistence fails', async () => {
    const { handler, restore } = mockRendererToolHandler('open_tab', async () => openTabReceipt);
    const sink: RendererAuditSink = {
      write: vi.fn(async () => {
        throw new Error('audit store offline');
      }),
    };

    try {
      const response = await callRendererTool(
        request('open_tab', {
          type: 'structure',
          entityId: 'structure:1RBL',
          label: '1RBL',
        }),
        {
          agentCapabilities: capabilitiesFor('open_tab'),
          auditSink: sink,
        }
      );

      const errorResponse = expectError(response);
      expect(errorResponse.error.code).toBe('AUDIT_UNAVAILABLE');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('fails closed before running side-effecting handlers when no durable audit sink is provided', async () => {
    const { handler, restore } = mockRendererToolHandler('open_tab', async () => openTabReceipt);

    try {
      const response = await callRendererTool(
        request('open_tab', {
          type: 'structure',
          entityId: 'structure:1RBL',
          label: '1RBL',
        }),
        {
          agentCapabilities: capabilitiesFor('open_tab'),
        }
      );

      const errorResponse = expectError(response);
      expect(errorResponse.error.code).toBe('AUDIT_UNAVAILABLE');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('forwards the caller external-service capabilities to the sidecar', async () => {
    vi.stubEnv('VITE_API_URL', TEST_SIDECAR_BASE_URL);
    (globalThis as any).electronAPI = {};
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          external_resource_id: 'res-1',
          provider: 'uniprot',
          external_id: 'P00875',
          cache_hit: false,
          license: null,
          attribution: null,
          metadata: {},
          xref_count: 0,
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { sink } = makeAuditSink();

    const response = await callRendererTool(
      request('external.fetch', {
        provider: 'uniprot',
        external_id: 'P00875',
      }),
      {
        agentCapabilities: ['external-fetch:annotation', 'external-fetch:xref-resolution'],
        auditSink: sink,
      }
    );

    expectSuccess(response);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.granted_capabilities).toEqual([
      'external-fetch:annotation',
      'external-fetch:xref-resolution',
    ]);
  });

  it('preserves typed domain errors thrown by renderer tool handlers', async () => {
    const { sink, records } = makeAuditSink();
    const { restore } = mockRendererToolHandler('get_workspace', async () => {
      throw rendererToolCallError({
        code: 'VIEWER_NOT_FOUND',
        domain: 'structure-mcp',
        message: 'No viewer with id pdb:1TUP.',
        retriable: true,
        details: { viewerId: 'pdb:1TUP' },
      });
    });

    try {
      const response = await callRendererTool(request('get_workspace'), {
        agentCapabilities: capabilitiesFor('get_workspace'),
        auditSink: sink,
      });

      const errorResponse = expectError(response);
      expect(errorResponse.error).toMatchObject({
        code: 'VIEWER_NOT_FOUND',
        domain: 'structure-mcp',
        message: 'No viewer with id pdb:1TUP.',
        retriable: true,
        details: { viewerId: 'pdb:1TUP' },
      });
      expect(records[0].error?.code).toBe('VIEWER_NOT_FOUND');
    } finally {
      restore();
    }
  });

  const WRITE_TOOL = 'open_tab';
  const WRITE_TOOL_ARGS = {
    type: 'protein',
    entityId: 'protein-audit-fixture',
    label: 'Audit protein',
  } as const;
  const EXPECTED_STORE_KEYS = ['design', 'page', 'sequence', 'structureDrawer'] as const;

  function expectSnapshotShape(snapshot: unknown): asserts snapshot is {
    store_revisions: Record<string, number>;
    workspace_path: string | null;
    captured_at: string;
  } {
    expect(snapshot).toBeDefined();
    const s = snapshot as {
      store_revisions: Record<string, number>;
      workspace_path: unknown;
      captured_at: unknown;
    };
    expect(typeof s.store_revisions).toBe('object');
    for (const key of EXPECTED_STORE_KEYS) {
      expect(typeof s.store_revisions[key]).toBe('number');
    }
    expect(['string', 'object']).toContain(typeof s.workspace_path);
    expect(typeof s.captured_at).toBe('string');
    expect(Number.isNaN(new Date(s.captured_at).getTime())).toBe(false);
  }

  it('captures before_state on the accepted audit row for a write action and omits after_state', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
      agentCapabilities: capabilitiesFor(WRITE_TOOL),
      auditSink: sink,
    });

    expectSuccess(response);
    const accepted = records.find((r) => r.status === 'accepted');
    expect(accepted).toBeDefined();
    expectSnapshotShape(accepted!.before_state);
    expect(accepted!.after_state).toBeUndefined();
  });

  it('captures both before_state and after_state on the completed audit row for a write action', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
      agentCapabilities: capabilitiesFor(WRITE_TOOL),
      auditSink: sink,
    });

    expectSuccess(response);
    const completed = records.find((r) => r.status === 'completed');
    expect(completed).toBeDefined();
    expectSnapshotShape(completed!.before_state);
    expectSnapshotShape(completed!.after_state);
  });

  it('carry-forwards the same before_state from accepted to the terminal audit row', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
      agentCapabilities: capabilitiesFor(WRITE_TOOL),
      auditSink: sink,
    });

    expectSuccess(response);
    const accepted = records.find((r) => r.status === 'accepted');
    const completed = records.find((r) => r.status === 'completed');
    expect(accepted!.before_state).toEqual(completed!.before_state);
  });

  it('produces a useful HANDLER_ERROR message when the handler throws an empty-message Error', async () => {
    const { sink, records } = makeAuditSink();
    const { restore } = mockRendererToolHandler(WRITE_TOOL, async () => {
      class SilentRendererTestError extends Error {
        constructor() {
          super();
          this.name = 'SilentRendererTestError';
        }
      }
      throw new SilentRendererTestError();
    });

    try {
      const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
        agentCapabilities: capabilitiesFor(WRITE_TOOL),
        auditSink: sink,
      });
      const errorResponse = expectError(response);
      expect(errorResponse.error.code).toBe('HANDLER_ERROR');

      expect(errorResponse.error.message).not.toBe('');
      expect(errorResponse.error.message).toContain('SilentRendererTestError');
    } finally {
      restore();
    }

    const failed = records.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.error?.message).not.toBe('');
    expect(failed!.error?.message).toContain('SilentRendererTestError');

    const afterStateError = (failed!.after_state as unknown as { error?: { message?: string } })
      ?.error;
    expect(afterStateError?.message).not.toBe('');
    expect(afterStateError?.message).toContain('SilentRendererTestError');
  });

  it('captures both before_state and after_state on a CANCELED audit row when the handler aborts', async () => {
    const { sink, records } = makeAuditSink();
    const controller = new AbortController();
    const { restore } = mockRendererToolHandler(WRITE_TOOL, async () => {
      controller.abort();
      throw new Error('handler observed abort');
    });

    try {
      const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
        agentCapabilities: capabilitiesFor(WRITE_TOOL),
        auditSink: sink,
        abortSignal: controller.signal,
      });
      const errorResponse = expectError(response);
      expect(errorResponse.error.code).toBe('CANCELED');
    } finally {
      restore();
    }

    const failed = records.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();
    expectSnapshotShape(failed!.before_state);
    expectSnapshotShape(failed!.after_state);

    const afterStateError = (failed!.after_state as unknown as { error?: { code?: string } })
      ?.error;
    expect(afterStateError?.code).toBe('CANCELED');
  });

  it('captures both before_state and after_state on the failed audit row when the handler throws', async () => {
    const { sink, records } = makeAuditSink();
    const { restore } = mockRendererToolHandler(WRITE_TOOL, async () => {
      throw new Error('handler exploded');
    });

    try {
      const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
        agentCapabilities: capabilitiesFor(WRITE_TOOL),
        auditSink: sink,
      });
      expectError(response);
    } finally {
      restore();
    }

    const failed = records.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();
    expectSnapshotShape(failed!.before_state);
    expectSnapshotShape(failed!.after_state);

    const afterStateError = (failed!.after_state as unknown as { error?: { code?: string } })
      ?.error;
    expect(afterStateError?.code).toBe('HANDLER_ERROR');
  });

  it('captures only before_state on a rejected write action when input validation fails', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request(WRITE_TOOL, {}), {
      agentCapabilities: capabilitiesFor(WRITE_TOOL),
      auditSink: sink,
    });

    const errorResponse = expectError(response);
    expect(errorResponse.error.code).toBe('BAD_INPUT');
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('rejected');
    expectSnapshotShape(records[0].before_state);
    expect(records[0].after_state).toBeUndefined();
  });

  it('captures only before_state on a rejected write action when capabilities are insufficient', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
      agentCapabilities: [],
      auditSink: sink,
    });

    const errorResponse = expectError(response);
    expect(errorResponse.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('rejected');
    expectSnapshotShape(records[0].before_state);
    expect(records[0].after_state).toBeUndefined();
  });

  it('captures only before_state on a rejected write action when the workspace is wrong', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
      agentCapabilities: capabilitiesFor(WRITE_TOOL),
      boundWorkspaceId: 'workspace-A',
      currentWorkspaceId: 'workspace-B',
      auditSink: sink,
    });

    const errorResponse = expectError(response);
    expect(errorResponse.error.code).toBe('WRONG_WORKSPACE');
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('rejected');
    expectSnapshotShape(records[0].before_state);
    expect(records[0].after_state).toBeUndefined();
  });

  it('captures only before_state on a rejected write action when no workspace is open', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request('import_sequence', { open: 'yes' }), {
      agentCapabilities: capabilitiesFor('import_sequence'),
      currentWorkspaceId: null,
      folders: [],
      auditSink: sink,
    });

    const errorResponse = expectError(response);
    expect(errorResponse.error.code).toBe('NO_WORKSPACE');
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('rejected');
    expectSnapshotShape(records[0].before_state);
    expect(records[0].after_state).toBeUndefined();
  });

  it('attaches before_state to the audit record passed to the failing sink during fail-closed', async () => {
    const { handler, restore } = mockRendererToolHandler(WRITE_TOOL, async () => openTabReceipt);
    const writeMock = vi.fn(async () => {
      throw new Error('audit store offline');
    });
    const sink: RendererAuditSink = { write: writeMock };

    try {
      const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
        agentCapabilities: capabilitiesFor(WRITE_TOOL),
        auditSink: sink,
      });

      const errorResponse = expectError(response);
      expect(errorResponse.error.code).toBe('AUDIT_UNAVAILABLE');
      expect(handler).not.toHaveBeenCalled();
      expect(writeMock).toHaveBeenCalledTimes(1);
      const record = writeMock.mock.calls[0][0] as RendererAuditRecord;
      expect(record.status).toBe('accepted');
      expectSnapshotShape(record.before_state);
      expect(record.after_state).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('omits before_state and after_state on read-only tool audit rows', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request('get_workspace'), {
      agentCapabilities: capabilitiesFor('get_workspace'),
      auditSink: sink,
    });

    expectSuccess(response);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
    expect(records[0].before_state).toBeUndefined();
    expect(records[0].after_state).toBeUndefined();
  });

  it('threads the workspace_path through into the captured before_state', async () => {
    const { sink, records } = makeAuditSink();

    const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
      agentCapabilities: capabilitiesFor(WRITE_TOOL),
      currentWorkspaceId: 'workspace-Z',
      auditSink: sink,
    });

    expectSuccess(response);
    const accepted = records.find((r) => r.status === 'accepted');
    expect(accepted!.before_state!.workspace_path).toBe('workspace-Z');
    const completed = records.find((r) => r.status === 'completed');
    expect(completed!.after_state!.workspace_path).toBe('workspace-Z');
  });

  it('reports a +1 store-revision delta between before_state and after_state when the handler mutates a store', async () => {
    const { sink, records } = makeAuditSink();
    const { restore } = mockRendererToolHandler(WRITE_TOOL, async () => {
      useDesignStore.setState({});
      return openTabReceipt;
    });

    const designStateBefore = useDesignStore.getState();

    try {
      const response = await callRendererTool(request(WRITE_TOOL, WRITE_TOOL_ARGS), {
        agentCapabilities: capabilitiesFor(WRITE_TOOL),
        auditSink: sink,
      });
      expectSuccess(response);
    } finally {
      restore();
      useDesignStore.setState(designStateBefore, true);
    }

    const completed = records.find((r) => r.status === 'completed');
    expect(completed!.after_state!.store_revisions.design).toBe(
      completed!.before_state!.store_revisions.design + 1
    );

    expect(completed!.after_state!.store_revisions.sequence).toBe(
      completed!.before_state!.store_revisions.sequence
    );
    expect(completed!.after_state!.store_revisions.page).toBe(
      completed!.before_state!.store_revisions.page
    );
    expect(completed!.after_state!.store_revisions.structureDrawer).toBe(
      completed!.before_state!.store_revisions.structureDrawer
    );
  });

  it('can persist renderer audit records through the sidecar audit endpoint', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, audit_id: 'durable-audit-1' }),
        init,
      };
    }) as unknown as typeof fetch;
    const sink = createHttpRendererAuditSink({
      apiUrl: `${TEST_AUDIT_API_URL}/`,
      fetchImpl,
    });

    const auditId = await sink.write({
      action_id: 'action-1',
      tool_name: 'get_workspace',
      actor_kind: 'renderer',
      actor_identity: 'agent-1',
      actor_scope: ['read-workspace', 'external-fetch:structure'],
      side_effects: ['read_only'],
      capability_check: {
        required: ['read-workspace'],
        effective_required: ['read-workspace', 'external-fetch:structure'],
        satisfied: true,
        reason: 'granted',
      },
      status: 'completed',
    });

    expect(auditId).toBe('durable-audit-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      `${TEST_AUDIT_API_URL}/mcp/renderer-audit`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock
      .calls;
    const body = JSON.parse(String(calls[0][1].body));
    expect(body).toMatchObject({
      action_id: 'action-1',
      actor_kind: 'renderer',
      actor_scope: ['read-workspace', 'external-fetch:structure'],
      status: 'completed',
      capability_check: {
        required: ['read-workspace'],
        effective_required: ['read-workspace', 'external-fetch:structure'],
      },
    });
  });
});
