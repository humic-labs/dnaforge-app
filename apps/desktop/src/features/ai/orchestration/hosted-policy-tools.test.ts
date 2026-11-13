import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSchema } from 'ai';
import { z } from 'zod';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { useCanvasStore } from '../../canvas/store';
import { useDesignStore } from '../../design/public/store';
import {
  ALLOWED_RENDERER_TOOLS,
  rendererToolSdkInputSchema,
  type RendererToolDefinition,
} from '../../agent-bridge/renderer-tools';
import { mockUUID, resetCanvasStore } from '../tools/test-helpers';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  createHostedPolicyTools,
  dispatchLocally,
  dispatchViaSidecar,
  hostedToolRequiresUserApproval,
  normalizeHostedRendererToolInput,
  toCanonicalHostedToolName,
  toHostedProviderToolName,
  SIDECAR_ROUTED_TOOLS,
} from './hosted-policy-tools';
import { TEST_AGENT_CALLER } from '../../../test/fixtures/agent-caller';
import { createHostedToolApprovalAuthority } from '../hosted/tool-approval-authority';
import { HOSTED_NATIVE_TOOL_DEFINITIONS } from '@waypoint/hosted-ai-contract';
import { HostedNativeToolDispatchError } from './hosted-policy-tools';
import { resolveCurrentAgentCaller } from '../../../services/agent-caller';
import { createCreateReferenceTool } from '../tools/create-reference';

const { confirmDialog, ensureDesignArtifact, resolveRendererToolAuthorizationSpy } = vi.hoisted(
  () => ({
    confirmDialog: vi.fn(async () => true),
    ensureDesignArtifact: vi.fn(async () => '/lab/project/designs/test.dnaforge-design.json'),
    resolveRendererToolAuthorizationSpy: vi.fn(),
  })
);
vi.mock('../../../components/confirm-dialog-store', () => ({ confirmDialog }));
vi.mock('../../design/public/materialize-design-artifact', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../design/public/materialize-design-artifact')>();
  return { ...actual, ensureDesignArtifact };
});
vi.mock('../../../services/agent-caller', async () => {
  const { TEST_AGENT_CALLER } = await import('../../../test/fixtures/agent-caller');
  return { resolveCurrentAgentCaller: vi.fn(async () => TEST_AGENT_CALLER) };
});
vi.mock('../../agent-bridge/renderer-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-bridge/renderer-tools')>();
  resolveRendererToolAuthorizationSpy.mockImplementation(actual.resolveRendererToolAuthorization);
  return {
    ...actual,
    resolveRendererToolAuthorization: resolveRendererToolAuthorizationSpy,
  };
});

mockUUID();

it('publishes an explicit object type for every shared provider tool input', () => {
  const missing = Object.values(ALLOWED_RENDERER_TOOLS)
    .filter((definition) => definition.exposure.kind === 'shared')
    .flatMap((definition) => {
      const schema = asSchema(rendererToolSdkInputSchema(definition)).jsonSchema;
      return schema.type === 'object'
        ? []
        : [{ name: definition.name, rootKeys: Object.keys(schema), type: schema.type }];
    });
  expect(missing).toEqual([]);
});

it('keeps provider input alternatives below the root object', () => {
  const invalid = Object.values(ALLOWED_RENDERER_TOOLS)
    .filter((definition) => definition.exposure.kind === 'shared')
    .flatMap((definition) => {
      const schema = asSchema(rendererToolSdkInputSchema(definition)).jsonSchema;
      return ['anyOf', 'allOf', 'oneOf'].some((key) => key in schema) ? [definition.name] : [];
    });
  expect(invalid).toEqual([]);
});

it('preserves file document union branches, defaults and runtime refusals in provider schemas', async () => {
  const definition = ALLOWED_RENDERER_TOOLS.file_document;
  const projected = asSchema(rendererToolSdkInputSchema(definition));
  const validateJson = new AjvJsonSchemaValidator().getValidator(projected.jsonSchema);
  const valid = [
    { target: { path: '/lab/project/notes.py' }, operation: { kind: 'inspect' } },
    {
      target: { documentId: 'file-document:exact' },
      expectedRevision: 'revision-one',
      operation: { kind: 'replace-string', oldText: 'agent draft', newText: 'agent durable' },
    },
    { project: '/lab/project', operation: { kind: 'list-dirty' } },
    { tabId: 'legacy-tab', expectedRevision: 'revision-one', operation: { kind: 'save' } },
  ];
  for (const input of valid) {
    expect(validateJson(input).valid).toBe(true);
    const result = await projected.validate!(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toEqual(definition.inputSchema.parse(input));
  }
  for (const input of [
    { operation: { kind: 'save' } },
    { target: { path: '/lab/project/notes.py' }, tabId: 'legacy-tab', operation: { kind: 'save' } },
    { target: { path: '/lab/project/notes.py' }, operation: { kind: 'not-an-operation' } },
    { target: { path: '/lab/project/notes.py' }, operation: { kind: 'inspect', offset: -1 } },
    {
      target: { path: '/lab/project/notes.py' },
      operation: { kind: 'replace-string', oldText: '', newText: 'replacement' },
    },
    { target: { path: '/lab/project/notes.py' }, operation: { kind: 'list-dirty' } },
    { project: '/lab/project', operation: { kind: 'save' } },
    {
      project: '/lab/project',
      expectedRevision: 'revision-one',
      operation: { kind: 'list-dirty' },
    },
    null,
    [],
  ]) {
    expect(definition.inputSchema.safeParse(input).success).toBe(false);
    expect((await projected.validate!(input)).success).toBe(false);
  }
});

it('does not narrow mixed object and primitive input unions', async () => {
  const schema = asSchema(
    rendererToolSdkInputSchema({
      ...ALLOWED_RENDERER_TOOLS.file_document,
      inputSchema: z.union([z.object({ query: z.string() }), z.literal('legacy')]),
    })
  );
  expect(schema.jsonSchema.type).toBeUndefined();
  expect((await schema.validate!('legacy')).success).toBe(true);
  expect((await schema.validate!({ query: 'value' })).success).toBe(true);
});

const folders = [{ path: '/lab/project', name: 'project', addedAt: 1 }];
const VALID_TICKET_EXPIRY = '2999-01-01T00:00:00.000Z';
const sharedRendererNames = Object.values(ALLOWED_RENDERER_TOOLS)
  .filter((definition) => definition.exposure.kind === 'shared')
  .map((definition) => definition.name);
describe('hosted agent policy tools', () => {
  it('advertises whole sequence references by stable document identity across tool transports', () => {
    const providerTool = createHostedPolicyTools(folders, {
      turnId: 'sequence-reference',
    }).create_reference;
    const description = providerTool.description;

    expect(description).toContain('whole sequence document');
    expect(description).toContain('entityType:"sequence"');
    expect(description).toContain('documentId');
    expect(description).toContain('resourceUri');
    expect(description).toContain('non-sequence workspace file or folder');
    expect(description).toBe(createCreateReferenceTool(folders).description);
  });

  it('derives managed-operation routing from the shared catalog', () => {
    expect([...SIDECAR_ROUTED_TOOLS].sort()).toEqual([
      'administration',
      'analyze_clone',
      'analyze_ngs_reads',
      'file_document',
      'import_review',
      'notebook_document',
      'operations.alignment-coverage-preparation.start',
      'operations.alignment-index-preparation.start',
      'operations.annotation.apply',
      'operations.annotation.inspect',
      'operations.genome-indexing.start',
      'operations.track-registration.start',
      'operations.variant-source-preparation.start',
      'project_history',
      'run_msa',
      'search_primer_matches',
      'search_workspace',
      'sequence_document',
      'start_variant_calls',
    ]);
    expect(
      ALLOWED_RENDERER_TOOLS['operations.alignment-coverage-preparation.start'].sidecarOrchestrated
    ).toBe(true);
    expect(
      ALLOWED_RENDERER_TOOLS['operations.alignment-index-preparation.start'].sidecarOrchestrated
    ).toBe(true);
    expect(ALLOWED_RENDERER_TOOLS['operations.annotation.inspect'].sidecarOrchestrated).toBe(true);
    expect(ALLOWED_RENDERER_TOOLS['operations.annotation.apply'].sidecarOrchestrated).toBe(true);
    expect(ALLOWED_RENDERER_TOOLS['operations.genome-indexing.start'].sidecarOrchestrated).toBe(
      true
    );
    expect(
      ALLOWED_RENDERER_TOOLS['operations.variant-source-preparation.start'].sidecarOrchestrated
    ).toBe(true);
    expect(ALLOWED_RENDERER_TOOLS.run_msa.sidecarOrchestrated).toBe(true);
    expect(ALLOWED_RENDERER_TOOLS.apply_annotation_output.sidecarOrchestrated).toBe(false);
  });
  it('normalizes gateway arguments with the same schema used for renderer execution', () => {
    const raw = {
      entityType: 'sequence',
      displayLabel: 'pUC19',
      documentId: 'sequence-document-puc19',
    };

    expect(normalizeHostedRendererToolInput('create_reference', raw)).toEqual({
      ...raw,
      deepLinkParams: {},
    });
    expect(() =>
      normalizeHostedRendererToolInput('create_reference', { ...raw, unexpected: true })
    ).toThrow(/schema validation/i);
    expect(normalizeHostedRendererToolInput('native_file_read', raw)).toBe(raw);
    expect(
      normalizeHostedRendererToolInput('external_xref', {
        provider: 'uniprot',
        external_id: 'P12345',
      })
    ).toEqual({ provider: 'uniprot', external_id: 'P12345' });
  });

  it('uses existing grants for ordinary mutations and preserves explicit finalization approval', () => {
    expect(hostedToolRequiresUserApproval('create_design')).toBe(false);
    expect(hostedToolRequiresUserApproval('revise_protocol_step')).toBe(false);
    expect(hostedToolRequiresUserApproval('remove_design_region')).toBe(false);
    expect(hostedToolRequiresUserApproval('create_primer')).toBe(false);
    expect(hostedToolRequiresUserApproval('classify_fasta')).toBe(false);
    expect(hostedToolRequiresUserApproval('finalize_paper_protocol')).toBe(true);
    expect(hostedToolRequiresUserApproval('finalize_design_assembly')).toBe(true);
    expect(hostedToolRequiresUserApproval('list_files')).toBe(false);
    expect(hostedToolRequiresUserApproval('not_a_tool')).toBe(true);
  });

  it('exposes every renderer tool through a collision-free provider-safe name', () => {
    const hosted = createHostedPolicyTools(folders, { turnId: 'turn-complete-catalog' });
    const expectedNames = sharedRendererNames.map(toHostedProviderToolName);

    expect(Object.keys(hosted).sort()).toEqual(expectedNames.sort());
    expect(Object.keys(hosted).every((name) => /^[a-zA-Z0-9_-]{1,128}$/.test(name))).toBe(true);
    expect(hosted.remove_design_region).toBeDefined();
    expect(hosted.assembly_set_editable_field).toBeDefined();
    expect(hosted.external_fetch).toBeDefined();
    expect(hosted.external_xref).toBeDefined();
    expect(hosted['external.fetch']).toBeUndefined();
    expect(hosted.run_msa).toBeDefined();
    expect(hosted.mol_open_drawer).toBeDefined();
    expect(toCanonicalHostedToolName('assembly_set_editable_field')).toBe(
      'assembly.setEditableField'
    );
    expect(toCanonicalHostedToolName('external_fetch')).toBe('external.fetch');
  });

  it('retains canonical names for the Hosted gateway ticket protocol', () => {
    const hosted = createHostedPolicyTools(folders, {
      turnId: 'turn-canonical-catalog',
      toolNameFormat: 'canonical',
    });

    expect(Object.keys(hosted).sort()).toEqual(sharedRendererNames.slice().sort());
    expect(hosted['assembly.setEditableField']).toBeDefined();
    expect(hosted['external.fetch']).toBeDefined();
  });

  it('adds the exact shared native catalog only when the Hosted main executor is present', () => {
    const nativeToolExecutor = vi.fn();
    const direct = createHostedPolicyTools(folders, { turnId: 'turn-direct-catalog' });
    const hosted = createHostedPolicyTools(folders, {
      turnId: 'turn-hosted-native-catalog',
      nativeToolExecutor,
    });

    expect(Object.keys(direct).sort()).toEqual(
      sharedRendererNames.map(toHostedProviderToolName).sort()
    );
    expect(Object.keys(hosted).sort()).toEqual(
      [
        ...sharedRendererNames.map(toHostedProviderToolName),
        ...HOSTED_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name),
      ].sort()
    );
    for (const definition of HOSTED_NATIVE_TOOL_DEFINITIONS) {
      expect(hosted[definition.name]).toMatchObject({ description: definition.description });
    }
  });

  it('executes and immediately records a signed native read through Electron main', async () => {
    const recordObservation = vi.fn(async () => ({
      providerCallId: 'native-read-call',
      toolName: 'Read',
    }));
    const nativeToolExecutor = vi.fn(async () => ({
      output: { path: '/lab/project/readme.txt', content: 'hello' },
      effectReceiptRef: 'native:read-receipt',
    }));
    const authority = createHostedToolApprovalAuthority({ recordObservation });
    authority.register({
      toolCallId: 'native-read-call',
      toolName: 'Read',
      input: { file_path: 'readme.txt' },
      ticket: 'signed.native.read',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });
    const tools = createHostedPolicyTools(folders, {
      turnId: 'turn-native-read',
      serverApprovalAuthority: authority,
      nativeToolExecutor,
    });

    const output = await tools.Read.execute!(
      { file_path: 'readme.txt' },
      { toolCallId: 'native-read-call', messages: [] }
    );
    await expect(
      tools.Read.toModelOutput!({
        toolCallId: 'native-read-call',
        input: { file_path: 'readme.txt' },
        output,
      })
    ).resolves.toEqual({
      type: 'json',
      value: { path: '/lab/project/readme.txt', content: 'hello' },
    });
    expect(nativeToolExecutor).toHaveBeenCalledWith(
      'Read',
      { file_path: 'readme.txt' },
      expect.objectContaining({ toolCallId: 'native-read-call' })
    );
    expect(recordObservation).toHaveBeenCalledWith(expect.anything(), {
      ok: true,
      result: { path: '/lab/project/readme.txt', content: 'hello' },
    });
  });

  it('cancels a claimed native mutation and records denial when the user keeps their files', async () => {
    const claimMutation = vi.fn(async () => ({
      claimId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'claimed' as const,
      toolName: 'Write',
      alreadyApplied: false,
    }));
    const cancelMutation = vi.fn(async () => ({ status: 'canceled' as const }));
    const completeMutation = vi.fn();
    const recordObservation = vi.fn(async () => ({
      providerCallId: 'native-write-call',
      toolName: 'Write',
    }));
    const nativeToolExecutor = vi.fn(async () => {
      throw new HostedNativeToolDispatchError(
        'user_declined',
        'You declined this operation. No local change was made.'
      );
    });
    const authority = createHostedToolApprovalAuthority({
      claimMutation,
      cancelMutation,
      completeMutation,
      recordObservation,
    });
    const input = { file_path: '/lab/project/existing.txt', content: 'replacement' };
    authority.register({
      toolCallId: 'native-write-call',
      toolName: 'Write',
      input,
      ticket: 'signed.native.write',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });
    const tools = createHostedPolicyTools(folders, {
      turnId: 'turn-native-write',
      serverApprovalAuthority: authority,
      nativeToolExecutor,
    });

    const output = await tools.Write.execute!(input, {
      toolCallId: 'native-write-call',
      messages: [],
    });
    expect(output).toMatchObject({
      __dnaforgeHostedExecutionDenied: true,
      code: 'USER_DECLINED',
    });
    await expect(
      tools.Write.toModelOutput!({ toolCallId: 'native-write-call', input, output })
    ).resolves.toEqual({
      type: 'execution-denied',
      reason: 'You declined this operation. No local change was made.',
    });
    expect(claimMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^shared-native-policy:/),
      'tool-claim:native-write-call'
    );
    expect(cancelMutation).toHaveBeenCalledWith(
      expect.anything(),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'tool-claim:native-write-call',
      'user_declined_before_effect'
    );
    expect(completeMutation).not.toHaveBeenCalled();
    expect(recordObservation).toHaveBeenCalledWith(expect.anything(), {
      ok: false,
      error: {
        code: 'USER_DECLINED',
        message: 'You declined this operation. No local change was made.',
      },
    });
  });

  it('cancels a claimed native mutation and records Stop without calling it a decline', async () => {
    const claimMutation = vi.fn(async () => ({
      claimId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'claimed' as const,
      toolName: 'Write',
      alreadyApplied: false,
    }));
    const cancelMutation = vi.fn(async () => ({ status: 'canceled' as const }));
    const recordObservation = vi.fn(async () => ({
      providerCallId: 'native-write-stopped',
      toolName: 'Write',
    }));
    const nativeToolExecutor = vi.fn(async () => {
      throw new HostedNativeToolDispatchError('stopped', 'Stopped before this tool ran.');
    });
    const authority = createHostedToolApprovalAuthority({
      claimMutation,
      cancelMutation,
      recordObservation,
    });
    const input = { file_path: '/lab/project/existing.txt', content: 'replacement' };
    authority.register({
      toolCallId: 'native-write-stopped',
      toolName: 'Write',
      input,
      ticket: 'signed.native.write.stopped',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });
    const tools = createHostedPolicyTools(folders, {
      turnId: 'turn-native-write-stopped',
      serverApprovalAuthority: authority,
      nativeToolExecutor,
    });

    const output = await tools.Write.execute!(input, {
      toolCallId: 'native-write-stopped',
      messages: [],
    });

    expect(output).toEqual({
      __dnaforgeHostedExecutionFailure: true,
      code: 'STOPPED',
      message: 'Stopped before this tool ran.',
    });
    await expect(
      tools.Write.toModelOutput!({ toolCallId: 'native-write-stopped', input, output })
    ).resolves.toEqual({ type: 'error-text', value: 'Stopped before this tool ran.' });
    expect(cancelMutation).toHaveBeenCalledWith(
      expect.anything(),
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'tool-claim:native-write-stopped',
      'stopped_before_effect'
    );
    expect(recordObservation).toHaveBeenCalledWith(expect.anything(), {
      ok: false,
      error: { code: 'STOPPED', message: 'Stopped before this tool ran.' },
    });
  });

  it('records a known pre-effect native mutation failure instead of stranding its ticket', async () => {
    const claimMutation = vi.fn(async () => ({
      claimId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      status: 'claimed' as const,
      toolName: 'Write',
      alreadyApplied: false,
    }));
    const cancelMutation = vi.fn(async () => ({ status: 'canceled' as const }));
    const recordObservation = vi.fn(async () => ({
      providerCallId: 'native-write-invalid',
      toolName: 'Write',
    }));
    const input = { file_path: '/lab/project/existing.txt', content: 'replacement' };
    const authority = createHostedToolApprovalAuthority({
      claimMutation,
      cancelMutation,
      recordObservation,
    });
    authority.register({
      toolCallId: 'native-write-invalid',
      toolName: 'Write',
      input,
      ticket: 'signed.native.write.invalid',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });
    const tools = createHostedPolicyTools(folders, {
      turnId: 'turn-native-write-invalid',
      serverApprovalAuthority: authority,
      nativeToolExecutor: async () => {
        throw new HostedNativeToolDispatchError('invalid_request', 'Invalid local arguments.');
      },
    });

    const output = await tools.Write.execute!(input, {
      toolCallId: 'native-write-invalid',
      messages: [],
    });

    expect(output).toMatchObject({
      __dnaforgeHostedExecutionFailure: true,
      code: 'TOOL_FAILED',
      message: 'Invalid local arguments.',
    });
    expect(cancelMutation).toHaveBeenCalledWith(
      expect.anything(),
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'tool-claim:native-write-invalid',
      'pre_effect_failure'
    );
    expect(recordObservation).toHaveBeenCalledWith(expect.anything(), {
      ok: false,
      error: { code: 'TOOL_FAILED', message: 'Invalid local arguments.' },
    });
  });

  it('records a read-only native Stop as stopped instead of tool-failed', async () => {
    const recordObservation = vi.fn(async () => ({
      providerCallId: 'native-read-stopped',
      toolName: 'Read',
    }));
    const input = { file_path: '/lab/project/readme.txt' };
    const authority = createHostedToolApprovalAuthority({ recordObservation });
    authority.register({
      toolCallId: 'native-read-stopped',
      toolName: 'Read',
      input,
      ticket: 'signed.native.read.stopped',
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });
    const tools = createHostedPolicyTools(folders, {
      turnId: 'turn-native-read-stopped',
      serverApprovalAuthority: authority,
      nativeToolExecutor: async () => {
        throw new HostedNativeToolDispatchError('stopped', 'Stopped before this tool ran.');
      },
    });

    const output = await tools.Read.execute!(input, {
      toolCallId: 'native-read-stopped',
      messages: [],
    });

    expect(output).toEqual({
      __dnaforgeHostedExecutionFailure: true,
      code: 'STOPPED',
      message: 'Stopped before this tool ran.',
    });
    expect(recordObservation).toHaveBeenCalledWith(expect.anything(), {
      ok: false,
      error: { code: 'STOPPED', message: 'Stopped before this tool ran.' },
    });
  });

  beforeEach(() => {
    confirmDialog.mockReset().mockResolvedValue(true);
    vi.mocked(resolveCurrentAgentCaller).mockReset().mockResolvedValue(TEST_AGENT_CALLER);
    resolveRendererToolAuthorizationSpy.mockClear();
    resetCanvasStore();
    useWorkspaceStore.setState({
      folders: [],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    (globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
      config: { getApiUrl: vi.fn(async () => 'http://127.0.0.1:8123') },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI;
    vi.unstubAllGlobals();
  });

  describe('local dispatch — the default transport ', () => {
    it('runs a read-only local tool in-process with no network call', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      useWorkspaceStore.setState({ folders });
      const tools = createHostedPolicyTools(folders, { turnId: 'turn-hosted-1' });

      const result = await tools.get_workspace.execute!(
        {},
        { toolCallId: 'tool-call-1', messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toMatchObject({ folders: [{ name: 'project', path: '/lab/project' }] });
      expect(resolveRendererToolAuthorizationSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails unknown local tools through the canonical bridge instead of a wrapper policy', async () => {
      await expect(
        dispatchLocally('not_a_tool', {}, { toolCallId: 'unknown-local-tool' })
      ).rejects.toMatchObject({
        name: 'HostedToolExecutionError',
        code: 'UNKNOWN_TOOL',
      });
    });

    it('runs a mutating local tool through the shared capability/audit engine, without a network hop', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const auditSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const tools = createHostedPolicyTools(folders, { turnId: 'turn-hosted-2' });

      const result = await tools.open_tab.execute!(
        { type: 'design', entityId: 'design-1', label: 'My Design' },
        { toolCallId: 'tool-call-2', messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toMatchObject({ tabId: expect.any(String) });
      const allTabs = Object.values(useCanvasStore.getState().panels).flatMap(
        (panel) => panel.tabs
      );
      expect(allTabs).toHaveLength(1);
      expect(allTabs[0]).toMatchObject({ type: 'design', entityId: 'design-1' });
      expect(fetchMock).not.toHaveBeenCalled();

      expect(auditSpy).toHaveBeenCalledWith(
        '[agent-bridge] renderer audit',
        expect.objectContaining({ tool_name: 'open_tab', status: 'completed' })
      );
      auditSpy.mockRestore();
    });

    it('executes an ordinary Direct API mutation under its current grant without another prompt', async () => {
      confirmDialog.mockResolvedValueOnce(false);
      useWorkspaceStore.setState({ folders });
      const tools = createHostedPolicyTools(folders, { turnId: 'turn-direct-mutation' });
      const result = await tools.create_design.execute!(
        { name: 'Direct API design', assemblyMethod: 'gibson', open: true },
        { toolCallId: 'tool-direct-mutation', messages: [] }
      );

      expect(confirmDialog).not.toHaveBeenCalled();
      expect(vi.mocked(resolveCurrentAgentCaller)).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ designId: expect.any(String) });
      expect(
        Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)
      ).toHaveLength(1);
    });

    it('serializes concurrent explicit finalization prompts without canceling an earlier request', async () => {
      useWorkspaceStore.setState({ folders });
      vi.mocked(resolveCurrentAgentCaller).mockResolvedValue({
        ...TEST_AGENT_CALLER,
        effectiveCapabilities: [...TEST_AGENT_CALLER.effectiveCapabilities, 'finalize-protocol'],
      });
      const pendingApprovals: Array<(confirmed: boolean) => void> = [];
      confirmDialog.mockImplementation(
        () => new Promise<boolean>((resolve) => pendingApprovals.push(resolve))
      );
      const tools = createHostedPolicyTools(folders, { turnId: 'turn-concurrent-finalizations' });
      const args = {
        path: 'protocols/Protocol/.forge/protocol.json',
        expectedRevision: 1,
        previewFingerprint: `sha256:${'a'.repeat(64)}`,
        idempotencyKey: 'finalization-intent',
      };
      const first = tools.finalize_paper_protocol.execute!(args, {
        toolCallId: 'first-finalization',
        messages: [],
      });
      const second = tools.finalize_paper_protocol.execute!(args, {
        toolCallId: 'second-finalization',
        messages: [],
      });
      await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
      expect(vi.mocked(resolveCurrentAgentCaller)).toHaveBeenCalledTimes(2);
      pendingApprovals[0]?.(false);
      await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(2));
      pendingApprovals[1]?.(false);
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ __dnaforgeHostedExecutionDenied: true }),
        expect.objectContaining({ __dnaforgeHostedExecutionDenied: true }),
      ]);
    });

    it('does not finalize when the user declines an explicitly authorized finalization', async () => {
      confirmDialog.mockResolvedValueOnce(false);
      vi.mocked(resolveCurrentAgentCaller).mockResolvedValue({
        ...TEST_AGENT_CALLER,
        effectiveCapabilities: [...TEST_AGENT_CALLER.effectiveCapabilities, 'finalize-protocol'],
      });
      useWorkspaceStore.setState({ folders });
      const factory = vi.spyOn(
        ALLOWED_RENDERER_TOOLS.finalize_paper_protocol.execution,
        'createTool'
      );
      try {
        const tools = createHostedPolicyTools(folders, { turnId: 'turn-finalization-denied' });
        const result = await tools.finalize_paper_protocol.execute!(
          {
            path: 'protocols/Protocol/.forge/protocol.json',
            expectedRevision: 1,
            previewFingerprint: `sha256:${'a'.repeat(64)}`,
            idempotencyKey: 'declined-finalization',
          },
          { toolCallId: 'declined-finalization', messages: [] }
        );
        expect(result).toMatchObject({ __dnaforgeHostedExecutionDenied: true });
        expect(confirmDialog).toHaveBeenCalledOnce();
        expect(vi.mocked(resolveCurrentAgentCaller)).toHaveBeenCalledOnce();
        expect(factory).not.toHaveBeenCalled();
      } finally {
        factory.mockRestore();
      }
    });

    it('rechecks the current grant after an explicit finalization approval wait', async () => {
      useWorkspaceStore.setState({ folders });
      vi.mocked(resolveCurrentAgentCaller)
        .mockResolvedValue({
          ...TEST_AGENT_CALLER,
          effectiveCapabilities: TEST_AGENT_CALLER.effectiveCapabilities.filter(
            (capability) => capability !== 'finalize-protocol'
          ),
        })
        .mockResolvedValueOnce({
          ...TEST_AGENT_CALLER,
          effectiveCapabilities: [...TEST_AGENT_CALLER.effectiveCapabilities, 'finalize-protocol'],
        });
      let decide: ((confirmed: boolean) => void) | undefined;
      confirmDialog.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            decide = resolve;
          })
      );
      const factory = vi.spyOn(
        ALLOWED_RENDERER_TOOLS.finalize_paper_protocol.execution,
        'createTool'
      );
      try {
        const tools = createHostedPolicyTools(folders, { turnId: 'turn-finalization-revoked' });
        const call = tools.finalize_paper_protocol.execute!(
          {
            path: 'protocols/Protocol/.forge/protocol.json',
            expectedRevision: 1,
            previewFingerprint: `sha256:${'a'.repeat(64)}`,
            idempotencyKey: 'revoked-finalization',
          },
          { toolCallId: 'revoked-finalization', messages: [] }
        );
        const rejected = expect(call).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
        await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
        expect(vi.mocked(resolveCurrentAgentCaller)).toHaveBeenCalledOnce();
        decide?.(true);
        await rejected;
        expect(vi.mocked(resolveCurrentAgentCaller)).toHaveBeenCalledTimes(2);
        expect(factory).not.toHaveBeenCalled();
      } finally {
        factory.mockRestore();
      }
    });

    it('reports an already-stopped Direct API tool as stopped instead of user-declined', async () => {
      const controller = new AbortController();
      controller.abort();
      const tools = createHostedPolicyTools(folders, { turnId: 'turn-direct-stopped' });

      const result = await tools.get_workspace.execute!(
        {},
        {
          toolCallId: 'tool-direct-stopped',
          messages: [],
          abortSignal: controller.signal,
        }
      );

      expect(result).toEqual({
        __dnaforgeHostedExecutionFailure: true,
        code: 'STOPPED',
        message: 'Stopped before this tool ran.',
      });
      await expect(
        tools.get_workspace.toModelOutput!({
          toolCallId: 'tool-direct-stopped',
          input: {},
          output: result,
        })
      ).resolves.toEqual({
        type: 'error-text',
        value: 'Stopped before this tool ran.',
      });
    });

    it('does not prompt for a read-only Hosted tool', async () => {
      useWorkspaceStore.setState({ folders });
      const tools = createHostedPolicyTools(folders, { turnId: 'turn-hosted-read' });

      await tools.get_workspace.execute!({}, { toolCallId: 'tool-read', messages: [] });

      expect(confirmDialog).not.toHaveBeenCalled();
    });

    it('fails closed instead of opening a Hosted-only prompt when gateway approval policy drifts', async () => {
      const recordObservation = vi.fn(async () => ({
        providerCallId: 'tool-server-approval',
        toolName: 'get_workspace',
      }));
      const authority = createHostedToolApprovalAuthority({ recordObservation });
      authority.register({
        toolCallId: 'tool-server-approval',
        toolName: 'get_workspace',
        input: {},
        ticket: 'signed.ticket',
        requiresUserApproval: true,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-server-approval',
        serverApprovalAuthority: authority,
      });

      const output = await tools.get_workspace.execute!(
        {},
        { toolCallId: 'tool-server-approval', messages: [] }
      );
      expect(output).toMatchObject({
        __dnaforgeHostedExecutionFailure: true,
        code: 'TOOL_FAILED',
        message: expect.stringMatching(/approval policy mismatch/i),
      });
      expect(confirmDialog).not.toHaveBeenCalled();
      expect(recordObservation).toHaveBeenCalledWith(expect.anything(), {
        ok: false,
        error: { code: 'TOOL_FAILED', message: expect.stringMatching(/approval policy mismatch/i) },
      });
    });

    it('consumes and records a signed read-only ticket when Stop already won', async () => {
      const controller = new AbortController();
      controller.abort();
      const recordObservation = vi.fn(async () => ({
        providerCallId: 'tool-stopped-before-execute',
        toolName: 'get_workspace',
      }));
      const authority = createHostedToolApprovalAuthority({ recordObservation });
      authority.register({
        toolCallId: 'tool-stopped-before-execute',
        toolName: 'get_workspace',
        input: {},
        ticket: 'signed.stopped',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-stopped-before-execute',
        serverApprovalAuthority: authority,
      });

      const result = await tools.get_workspace.execute!(
        {},
        {
          toolCallId: 'tool-stopped-before-execute',
          messages: [],
          abortSignal: controller.signal,
        }
      );

      expect(result).toEqual({
        __dnaforgeHostedExecutionFailure: true,
        code: 'STOPPED',
        message: 'Stopped before this tool ran.',
      });
      expect(recordObservation).toHaveBeenCalledWith(expect.anything(), {
        ok: false,
        error: {
          code: 'STOPPED',
          message: 'Stopped before this tool ran.',
        },
      });
      await expect(
        tools.get_workspace.toModelOutput!({
          toolCallId: 'tool-stopped-before-execute',
          input: {},
          output: result,
        })
      ).resolves.toEqual({ type: 'error-text', value: 'Stopped before this tool ran.' });
    });

    it('fails before dispatch when gateway approval authority is missing or mismatched', async () => {
      useWorkspaceStore.setState({ folders });
      const missingAuthority = createHostedToolApprovalAuthority();
      const missingTools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-missing-ticket',
        serverApprovalAuthority: missingAuthority,
      });

      await expect(
        missingTools.get_workspace.execute!({}, { toolCallId: 'missing-call', messages: [] })
      ).rejects.toThrow(/missing/i);

      const mismatchedAuthority = createHostedToolApprovalAuthority();
      mismatchedAuthority.register({
        toolCallId: 'mismatched-call',
        toolName: 'list_files',
        input: {},
        ticket: 'signed.ticket',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const mismatchedTools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-mismatched-ticket',
        serverApprovalAuthority: mismatchedAuthority,
      });
      await expect(
        mismatchedTools.get_workspace.execute!({}, { toolCallId: 'mismatched-call', messages: [] })
      ).rejects.toThrow(/does not match/i);

      expect(confirmDialog).not.toHaveBeenCalled();
    });

    it('consumes a gateway approval ticket only once', async () => {
      useWorkspaceStore.setState({ folders });
      const authority = createHostedToolApprovalAuthority();
      authority.register({
        toolCallId: 'one-shot-call',
        toolName: 'get_workspace',
        input: {},
        ticket: 'signed.ticket',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-one-shot',
        serverApprovalAuthority: authority,
      });

      await expect(
        tools.get_workspace.execute!({}, { toolCallId: 'one-shot-call', messages: [] })
      ).resolves.toMatchObject({ folders: [{ path: '/lab/project' }] });
      await expect(
        tools.get_workspace.execute!({}, { toolCallId: 'one-shot-call', messages: [] })
      ).rejects.toThrow(/missing/i);
    });

    it('awaits the durable observation receipt immediately after local execution', async () => {
      useWorkspaceStore.setState({ folders });
      let resolveReceipt!: (receipt: { providerCallId: string; toolName: string }) => void;
      const recordObservation = vi.fn(
        () =>
          new Promise<{ providerCallId: string; toolName: string }>((resolve) => {
            resolveReceipt = resolve;
          })
      );
      const authority = createHostedToolApprovalAuthority({ recordObservation });
      authority.register({
        toolCallId: 'receipt-call',
        toolName: 'get_workspace',
        input: {},
        ticket: 'signed.receipt',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-receipt',
        serverApprovalAuthority: authority,
      });

      let executionSettled = false;
      const execution = tools.get_workspace.execute!(
        {},
        { toolCallId: 'receipt-call', messages: [] }
      ).then((output) => {
        executionSettled = true;
        return output;
      });
      await vi.waitFor(() => expect(recordObservation).toHaveBeenCalledTimes(1));
      expect(executionSettled).toBe(false);
      resolveReceipt({ providerCallId: 'receipt-call', toolName: 'get_workspace' });
      const output = await execution;
      expect(recordObservation).toHaveBeenCalledWith(
        expect.objectContaining({ ticket: 'signed.receipt' }),
        { ok: true, result: output }
      );
      await expect(
        tools.get_workspace.toModelOutput!({
          toolCallId: 'receipt-call',
          input: {},
          output,
        })
      ).resolves.toMatchObject({ type: 'json' });
    });

    it('fails the model-output boundary when the immediate receipt cannot be recorded', async () => {
      useWorkspaceStore.setState({ folders });
      const recordObservation = vi.fn(async () => {
        throw new Error('receipt unavailable');
      });
      const authority = createHostedToolApprovalAuthority({ recordObservation });
      authority.register({
        toolCallId: 'receipt-failure-call',
        toolName: 'get_workspace',
        input: {},
        ticket: 'signed.receipt-failure',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-receipt-failure',
        serverApprovalAuthority: authority,
      });

      const output = await tools.get_workspace.execute!(
        {},
        { toolCallId: 'receipt-failure-call', messages: [] }
      );
      await expect(
        tools.get_workspace.toModelOutput!({
          toolCallId: 'receipt-failure-call',
          input: {},
          output,
        })
      ).rejects.toThrow(/receipt unavailable/i);
    });

    it('records a local tool failure instead of bypassing the observation hook', async () => {
      const recordObservation = vi.fn(async () => ({
        providerCallId: 'failed-call',
        toolName: 'get_workspace',
      }));
      const authority = createHostedToolApprovalAuthority({ recordObservation });
      authority.register({
        toolCallId: 'failed-call',
        toolName: 'get_workspace',
        input: { unexpected: true },
        ticket: 'signed.failure',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-failure-receipt',
        serverApprovalAuthority: authority,
      });

      const output = await tools.get_workspace.execute!(
        { unexpected: true },
        { toolCallId: 'failed-call', messages: [] }
      );
      await expect(
        tools.get_workspace.toModelOutput!({
          toolCallId: 'failed-call',
          input: { unexpected: true },
          output,
        })
      ).resolves.toMatchObject({ type: 'error-text' });
      expect(recordObservation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'TOOL_FAILED' }),
        })
      );
    });

    it('exposes every canonical mutation and completes the server claim before observation', async () => {
      useWorkspaceStore.setState({ folders });
      const claimMutation = vi.fn(async () => ({
        claimId: '00000000-0000-4000-8000-000000000099',
        status: 'claimed' as const,
        toolName: 'create_design',
        alreadyApplied: false,
      }));
      const completeMutation = vi.fn(async () => ({ status: 'completed' as const }));
      const recordObservation = vi.fn(async () => ({
        providerCallId: 'tool-write',
        toolName: 'create_design',
      }));
      const authority = createHostedToolApprovalAuthority({
        claimMutation,
        completeMutation,
        recordObservation,
      });
      const input = { name: 'Hosted Design', assemblyMethod: 'gibson', open: true };
      authority.register({
        toolCallId: 'tool-write',
        toolName: 'create_design',
        input,
        ticket: 'signed.write',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-local-policy',
        serverApprovalAuthority: authority,
      });

      expect(tools.create_design).toBeDefined();
      expect(tools.remove_design_region).toBeDefined();
      expect(tools.open_tab).toBeDefined();
      expect(tools.get_workspace).toBeDefined();
      const designRevisionBefore = useDesignStore.getState().revision;
      const output = await tools.create_design.execute!(input, {
        toolCallId: 'tool-write',
        messages: [],
      });
      expect(confirmDialog).not.toHaveBeenCalled();
      expect(claimMutation).toHaveBeenCalledTimes(1);
      expect(claimMutation).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'tool-write' }),
        expect.stringMatching(/^policy-auto-approved:/),
        'tool-claim:tool-write'
      );
      expect(completeMutation).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'tool-write' }),
        '00000000-0000-4000-8000-000000000099',
        'tool-claim:tool-write',
        expect.any(String)
      );
      expect(completeMutation.mock.invocationCallOrder[0]).toBeLessThan(
        recordObservation.mock.invocationCallOrder[0]!
      );
      expect(recordObservation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          ok: true,
          renderer_state_diff: [
            expect.objectContaining({
              store: 'design',
              before: designRevisionBefore,
              after: designRevisionBefore + 1,
            }),
          ],
        }),
        '00000000-0000-4000-8000-000000000099'
      );
      await expect(
        tools.create_design.toModelOutput!({
          toolCallId: 'tool-write',
          input,
          output,
        })
      ).resolves.toMatchObject({ type: 'json' });
    });

    it('cancels a server claim and performs no write when Stop wins during claim acquisition', async () => {
      const controller = new AbortController();
      let resolveClaim!: (value: {
        claimId: string;
        status: 'claimed';
        toolName: string;
        alreadyApplied: false;
      }) => void;
      const claimMutation = vi.fn(
        () =>
          new Promise<{
            claimId: string;
            status: 'claimed';
            toolName: string;
            alreadyApplied: false;
          }>((resolve) => {
            resolveClaim = resolve;
          })
      );
      const cancelMutation = vi.fn(async () => ({ status: 'canceled' as const }));
      const authority = createHostedToolApprovalAuthority({ claimMutation, cancelMutation });
      const input = { name: 'Must Not Exist', assemblyMethod: 'gibson', open: true };
      authority.register({
        toolCallId: 'tool-stop-after-claim',
        toolName: 'create_design',
        input,
        ticket: 'signed.write',
        requiresUserApproval: false,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-stop-after-claim',
        serverApprovalAuthority: authority,
      });
      const call = tools.create_design.execute!(input, {
        toolCallId: 'tool-stop-after-claim',
        messages: [],
        abortSignal: controller.signal,
      });

      await vi.waitFor(() => expect(claimMutation).toHaveBeenCalledTimes(1));
      controller.abort();
      resolveClaim({
        claimId: '00000000-0000-4000-8000-000000000099',
        status: 'claimed',
        toolName: 'create_design',
        alreadyApplied: false,
      });

      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(cancelMutation).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'tool-stop-after-claim' }),
        '00000000-0000-4000-8000-000000000099',
        'tool-claim:tool-stop-after-claim',
        'stopped_before_effect'
      );
      expect(
        Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)
      ).toHaveLength(0);
    });

    it('cancels a mutation claim and does not dispatch if the ticket expires while claim acquisition is pending', async () => {
      let now = Date.parse('2026-08-13T20:00:00.000Z');
      let resolveClaim!: (value: {
        claimId: string;
        status: 'claimed';
        toolName: string;
        alreadyApplied: false;
      }) => void;
      const claimMutation = vi.fn(
        () =>
          new Promise<{
            claimId: string;
            status: 'claimed';
            toolName: string;
            alreadyApplied: false;
          }>((resolve) => {
            resolveClaim = resolve;
          })
      );
      const cancelMutation = vi.fn(async () => ({ status: 'canceled' as const }));
      const authority = createHostedToolApprovalAuthority({
        now: () => now,
        claimMutation,
        cancelMutation,
      });
      const input = { name: 'Expired Design', assemblyMethod: 'gibson', open: true };
      authority.register({
        toolCallId: 'tool-expiry-race',
        toolName: 'create_design',
        input,
        ticket: 'signed.ticket',
        requiresUserApproval: false,
        expiresAt: '2026-08-13T20:00:01.000Z',
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-expiry-race',
        serverApprovalAuthority: authority,
      });

      const call = tools.create_design.execute!(input, {
        toolCallId: 'tool-expiry-race',
        messages: [],
      });
      await vi.waitFor(() => expect(claimMutation).toHaveBeenCalledTimes(1));
      now += 2_000;
      resolveClaim({
        claimId: '00000000-0000-4000-8000-000000000099',
        status: 'claimed',
        toolName: 'create_design',
        alreadyApplied: false,
      });

      await expect(call).resolves.toEqual(
        expect.objectContaining({
          __dnaforgeHostedExecutionFailure: true,
          code: 'TOOL_FAILED',
          message: expect.stringMatching(/expired/i),
        })
      );
      expect(cancelMutation).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'tool-expiry-race' }),
        '00000000-0000-4000-8000-000000000099',
        'tool-claim:tool-expiry-race',
        'pre_effect_failure'
      );
      expect(
        Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)
      ).toHaveLength(0);
    });

    it('rejects gateway-ticket argument drift before prompting or dispatching', async () => {
      const authority = createHostedToolApprovalAuthority();
      authority.register({
        toolCallId: 'argument-drift',
        toolName: 'get_workspace',
        input: { unexpected: 'ticketed' },
        ticket: 'signed.ticket',
        requiresUserApproval: true,
        expiresAt: VALID_TICKET_EXPIRY,
      });
      const tools = createHostedPolicyTools(folders, {
        turnId: 'turn-hosted-argument-drift',
        serverApprovalAuthority: authority,
      });

      await expect(
        tools.get_workspace.execute!({}, { toolCallId: 'argument-drift', messages: [] })
      ).rejects.toThrow(/arguments.*match/i);
      expect(confirmDialog).not.toHaveBeenCalled();
    });

    it('grants primer writes without granting general workspace writes', async () => {
      useWorkspaceStore.setState({ folders });

      const tools = createHostedPolicyTools(folders, { turnId: 'turn-hosted-write-scope' });
      const call = tools.save_designed_primer.execute!(
        {
          designId: `sha256:${'a'.repeat(64)}`,
          candidateId: 'missing-candidate',
          name: 'Primer F',
          artifactPath: 'primers/primer-f.primer.json',
        },
        { toolCallId: 'tool-write-scope', messages: [] }
      );

      await expect(call).rejects.toMatchObject({
        name: 'HostedToolExecutionError',
        code: 'PRIMER_DESIGN_EXPIRED',
        details: { changed: false, stateChanged: false, partialEffects: [] },
      });

      expect(TEST_AGENT_CALLER.effectiveCapabilities).toContain('edit-primers');
      expect(TEST_AGENT_CALLER.effectiveCapabilities).not.toContain('write-workspace');
    });

    it('throws a HostedToolExecutionError carrying an audit id when the shared policy engine rejects a local call', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const tools = createHostedPolicyTools(folders, { turnId: 'turn-hosted-3' });

      const call = tools.save_active_residue_selection.execute!(
        { structureRef: 'structure:1ABC', name: 'Pocket' },
        { toolCallId: 'tool-call-3', messages: [], abortSignal: new AbortController().signal }
      );

      await expect(call).rejects.toMatchObject({
        name: 'HostedToolExecutionError',
        code: 'NO_WORKSPACE',
        auditId: expect.any(String),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not synthesize finalize permission for the hosted in-app route', async () => {
      useWorkspaceStore.setState({ folders });
      const tools = createHostedPolicyTools(folders, { turnId: 'turn-hosted-finalize-denied' });
      const call = tools.finalize_design_assembly.execute!(
        {
          designId: 'design-1',
          expectedDesignVersion: 1,
          previewFingerprint: `sha256:${'a'.repeat(64)}`,
          idempotencyKey: 'must-not-self-grant',
        },
        { toolCallId: 'tool-finalize-denied', messages: [] }
      );
      await expect(call).rejects.toMatchObject({
        name: 'HostedToolExecutionError',
        code: 'INSUFFICIENT_SCOPE',
      });
      expect(confirmDialog).not.toHaveBeenCalled();
    });
  });

  describe('sidecar dispatch for catalog-marked tools', () => {
    it('posts to /mcp/call with least-privilege capabilities', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              status: 'completed',
              result: { ok: true, result: { ok: true, viewerId: 'viewer-1' }, audit_id: 'audit-1' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await dispatchViaSidecar(
        'mol_set_color',
        { viewerId: 'viewer-1', color: { mode: 'uniform', value: '#00ff00' } },
        { turnId: 'turn-hosted-4' },
        { toolCallId: 'tool-call-4', abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({ ok: true, viewerId: 'viewer-1' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:8123/mcp/call');
      const headers = new Headers(init?.headers);
      expect(headers.get('X-DNAForge-Session')).toBeNull();
      expect(headers.get('X-DNAForge-Agent-Identity')).toBe('local-in-app-chat');
      expect(headers.get('X-DNAForge-Turn-Id')).toBe('turn-hosted-4');
      expect(headers.get('Idempotency-Key')).toBe('hosted:turn-hosted-4:mol_set_color:tool-call-4');
      const providedScopes = JSON.parse(
        String(headers.get('X-DNAForge-Agent-Capabilities'))
      ) as string[];
      expect(providedScopes).toContain('read-workspace');
      expect(providedScopes).not.toEqual(
        ALLOWED_RENDERER_TOOLS.mol_set_color.required_capabilities
      );
      expect(resolveRendererToolAuthorizationSpy).not.toHaveBeenCalled();
    });

    it('namespaces idempotency keys per tool within the same turn', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              status: 'completed',
              result: { ok: true, result: { ok: true }, audit_id: 'audit-idempotency' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      );
      vi.stubGlobal('fetch', fetchMock);
      const context = {
        toolCallId: 'provider-scoped-1',
        abortSignal: new AbortController().signal,
      };

      await dispatchViaSidecar(
        'mol_set_color',
        { viewerId: 'viewer-1', color: { mode: 'uniform', value: '#00ff00' } },
        { turnId: 'turn-shared-id' },
        context
      );
      await dispatchViaSidecar(
        'mol_set_representation',
        { viewerId: 'viewer-1', representation: 'surface' },
        { turnId: 'turn-shared-id' },
        context
      );

      const keys = fetchMock.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get('Idempotency-Key')
      );
      expect(keys).toEqual([
        'hosted:turn-shared-id:mol_set_color:provider-scoped-1',
        'hosted:turn-shared-id:mol_set_representation:provider-scoped-1',
      ]);
    });

    it('throws a hosted tool error when the sidecar reports a domain failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                ok: false,
                status: 'failed',
                jobId: 'action-partial-1',
                error: {
                  code: 'SAVE_ARTIFACT_FAILED',
                  domain: 'core',
                  message: 'The selection artifact was created, but viewer projection failed.',
                  retriable: false,
                  details: {
                    stateChanged: true,
                    partialEffects: [{ kind: 'saved-selection-created', id: 'selection-1' }],
                    renderer_audit_id: 'renderer-audit-1',
                  },
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        )
      );

      const call = dispatchViaSidecar(
        'save_active_residue_selection',
        { structureRef: 'structure:1ABC', name: 'Pocket' },
        { turnId: 'turn-hosted-5' },
        { toolCallId: 'tool-call-5', abortSignal: new AbortController().signal }
      );

      await expect(call).rejects.toMatchObject({
        name: 'HostedToolExecutionError',
        code: 'SAVE_ARTIFACT_FAILED',
        retriable: false,
        actionId: 'action-partial-1',
        auditId: 'renderer-audit-1',
        details: {
          stateChanged: true,
          partialEffects: [{ kind: 'saved-selection-created', id: 'selection-1' }],
          renderer_audit_id: 'renderer-audit-1',
        },
      });
      await expect(call).rejects.toThrow(
        /SAVE_ARTIFACT_FAILED.*stateChanged.*true.*partialEffects.*saved-selection-created/s
      );
    });

    it('reports the actual successful HTTP status for a malformed failure envelope', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ ok: false, status: 'failed' }), {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            })
        )
      );

      const call = dispatchViaSidecar(
        'mol_set_color',
        { viewerId: 'viewer-1', color: { mode: 'uniform', value: '#00ff00' } },
        { turnId: 'turn-status' },
        { toolCallId: 'tool-status', abortSignal: new AbortController().signal }
      );

      await expect(call).rejects.toThrow('Shared agent dispatcher returned HTTP 201.');
    });
  });

  it('wraps every canonical renderer tool with policy — none is exposed as ambient .execute', () => {
    const hosted = createHostedPolicyTools(folders, {
      turnId: 'turn-hosted-6',
      toolNameFormat: 'canonical',
    });

    expect(Object.keys(hosted).sort()).toEqual(sharedRendererNames.slice().sort());
    for (const [rendererName, definition] of Object.entries(ALLOWED_RENDERER_TOOLS).filter(
      ([, candidate]) => candidate.exposure.kind === 'shared'
    )) {
      expect(hosted[rendererName]).toBeDefined();
      expect(asSchema(hosted[rendererName]!.inputSchema!).jsonSchema).toEqual(
        asSchema(rendererToolSdkInputSchema(definition)).jsonSchema
      );
      expect(hosted[rendererName]?.description).toBe(definition.description);
      if (definition.execution.kind === 'custom') {
        expect(hosted[rendererName]?.execute).not.toBe(definition.execution.handler);
      }
    }
  });
});

describe('hosted policy tools — proven no-effect cancellation ', () => {
  const input = { name: 'Hosted Design', assemblyMethod: 'gibson', open: true };
  const originalExecution = ALLOWED_RENDERER_TOOLS.create_design.execution;

  function stoppingHandler(details: Record<string, unknown>) {
    return async (_args: unknown, context: { abortSignal?: AbortSignal }) => {
      const controller = abortControllers.get(context.abortSignal!);
      controller?.abort();
      return {
        ok: false,
        code: 'CANCELED',
        canceled: true,
        retriable: true,
        error: 'Design creation was stopped before any workspace change.',
        ...details,
      };
    };
  }
  const abortControllers = new Map<AbortSignal, AbortController>();
  function controllerFor(): AbortController {
    const controller = new AbortController();
    abortControllers.set(controller.signal, controller);
    return controller;
  }

  function armedTools(toolCallId: string) {
    useWorkspaceStore.setState({ folders });
    const claimMutation = vi.fn(async () => ({
      claimId: '00000000-0000-4000-8000-000000002699',
      status: 'claimed' as const,
      toolName: 'create_design',
      alreadyApplied: false,
    }));
    const cancelMutation = vi.fn(async () => ({ status: 'canceled' as const }));
    const completeMutation = vi.fn(async () => ({ status: 'completed' as const }));
    const recordObservation = vi.fn(async () => ({
      providerCallId: toolCallId,
      toolName: 'create_design',
    }));
    const authority = createHostedToolApprovalAuthority({
      claimMutation,
      cancelMutation,
      completeMutation,
      recordObservation,
    });
    authority.register({
      toolCallId,
      toolName: 'create_design',
      input,
      ticket: `signed.${toolCallId}`,
      requiresUserApproval: false,
      expiresAt: VALID_TICKET_EXPIRY,
    });
    const tools = createHostedPolicyTools(folders, {
      turnId: `turn-${toolCallId}`,
      serverApprovalAuthority: authority,
    });
    return { tools, claimMutation, cancelMutation, completeMutation, recordObservation };
  }

  afterEach(() => {
    (
      ALLOWED_RENDERER_TOOLS.create_design as {
        execution: RendererToolDefinition['execution'];
      }
    ).execution = originalExecution;
    abortControllers.clear();
  });

  it('releases the claim as stopped-before-effect when the tool proves it changed nothing', async () => {
    (
      ALLOWED_RENDERER_TOOLS.create_design as {
        execution: RendererToolDefinition['execution'];
      }
    ).execution = {
      kind: 'custom',
      handler: stoppingHandler({ stateChanged: false, partialEffects: [] }),
    };
    const { tools, claimMutation, cancelMutation, completeMutation, recordObservation } =
      armedTools('tool-2699-no-effect');
    const controller = controllerFor();

    const output = await tools.create_design.execute!(input, {
      toolCallId: 'tool-2699-no-effect',
      messages: [],
      abortSignal: controller.signal,
    });

    expect(output).toEqual({
      __dnaforgeHostedExecutionFailure: true,
      code: 'STOPPED',
      message: 'Stopped before this tool ran.',
    });
    expect(claimMutation).toHaveBeenCalledTimes(1);
    expect(cancelMutation).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-4000-8000-000000002699',
      'tool-claim:tool-2699-no-effect',
      'stopped_before_effect'
    );
    expect(completeMutation).not.toHaveBeenCalled();
    expect(recordObservation).toHaveBeenCalledWith(expect.anything(), {
      ok: false,
      error: { code: 'STOPPED', message: 'Stopped before this tool ran.' },
    });
  });

  it('still leaves an uncertain cancellation to server recovery', async () => {
    (
      ALLOWED_RENDERER_TOOLS.create_design as {
        execution: RendererToolDefinition['execution'];
      }
    ).execution = {
      kind: 'custom',
      handler: stoppingHandler({ stateChanged: true, partialEffects: ['design row inserted'] }),
    };
    const { tools, cancelMutation, completeMutation } = armedTools('tool-2699-uncertain');
    const controller = controllerFor();

    await expect(
      tools.create_design.execute!(input, {
        toolCallId: 'tool-2699-uncertain',
        messages: [],
        abortSignal: controller.signal,
      })
    ).rejects.toThrow(/CANCELED/);
    expect(cancelMutation).not.toHaveBeenCalled();
    expect(completeMutation).not.toHaveBeenCalled();
  });
});
