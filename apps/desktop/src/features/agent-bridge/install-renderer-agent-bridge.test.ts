import type { RendererAgentBridgePayload } from './install-renderer-agent-bridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallRendererTool,
  mockCreateConsoleRendererAuditSink,
  mockCreateHttpRendererAuditSink,
  mockGetCurrentRendererWorkspaceId,
  mockUseWorkspaceStore,
} = vi.hoisted(() => ({
  mockCallRendererTool: vi.fn(),
  mockCreateConsoleRendererAuditSink: vi.fn(() => ({ write: vi.fn() })),
  mockCreateHttpRendererAuditSink: vi.fn(() => ({ write: vi.fn() })),
  mockGetCurrentRendererWorkspaceId: vi.fn(() => 'workspace-1'),
  mockUseWorkspaceStore: { getState: vi.fn(() => ({ folders: [] })) },
}));

vi.mock('./renderer-bridge', () => ({
  callRendererTool: mockCallRendererTool,
  createConsoleRendererAuditSink: mockCreateConsoleRendererAuditSink,
  createHttpRendererAuditSink: mockCreateHttpRendererAuditSink,
  getCurrentRendererWorkspaceId: mockGetCurrentRendererWorkspaceId,
}));

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: mockUseWorkspaceStore,
}));

import * as rendererAgentBridgeModule from './install-renderer-agent-bridge';

const TEST_RUNTIME_SIDECAR_URL = 'http://renderer-agent-sidecar.test.invalid';

describe('installRendererAgentBridge cancellation', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.clearAllMocks();
  });

  it('passes an AbortSignal into renderer tool calls and aborts it when main cancels the request', async () => {
    let onCallCallback: ((payload: unknown) => void) | null = null;
    let onCancelCallback: ((payload: unknown) => void) | null = null;
    const respond = vi.fn();

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      agentTools: {
        onCall(callback: (payload: unknown) => void) {
          onCallCallback = callback;
          return vi.fn();
        },
        onCancel(callback: (payload: unknown) => void) {
          onCancelCallback = callback;
          return vi.fn();
        },
        respond,
      },
      config: {
        getApiUrl: vi.fn(async () => TEST_RUNTIME_SIDECAR_URL),
      },
      runtime: {
        getProfile: vi.fn(() => ({ scenarioMutationAllowed: true })),
      },
    };

    mockCallRendererTool.mockImplementation(async (_request, context) => {
      const abortSignal = (context as { abortSignal?: AbortSignal }).abortSignal;
      expect(abortSignal).toBeInstanceOf(AbortSignal);
      await new Promise<void>((resolve) => abortSignal?.addEventListener('abort', () => resolve()));
      return {
        ok: false,
        error: {
          code: 'CANCELED',
          domain: 'core',
          message: 'Renderer tool call canceled.',
          retriable: true,
        },
      };
    });

    rendererAgentBridgeModule.installRendererAgentBridge();

    expect(onCallCallback).toBeTypeOf('function');
    expect(onCancelCallback).toBeTypeOf('function');

    onCallCallback?.({
      requestId: 'renderer-request-1',
      request: {
        tool_name: 'get_workspace',
        args: {},
        agent_identity: 'agent-1',
        action_id: 'action-1',
      },
      sessionToken: 'session',
      expectedSessionToken: 'session',
      agentCapabilities: ['read-workspace'],
    });

    await vi.waitFor(() => {
      expect(mockCallRendererTool).toHaveBeenCalledTimes(1);
    });

    onCancelCallback?.({ requestId: 'renderer-request-1', turnId: 'turn-1' });

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(
        'renderer-request-1',
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'CANCELED' }),
        })
      );
    });
  });

  it('does not export workspace-rebind authority from the production bridge module', async () => {
    expect(rendererAgentBridgeModule).not.toHaveProperty(
      'rebindRendererAgentBridgeForTrustedWorkspaceReplacement'
    );
  });

  it('uses the local audit sink only for a trusted main-owned Hosted call', async () => {
    let onCallCallback: ((payload: unknown) => void) | null = null;
    const respond = vi.fn();
    const getApiUrl = vi.fn(async () => TEST_RUNTIME_SIDECAR_URL);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      agentTools: {
        onCall(callback: (payload: unknown) => void) {
          onCallCallback = callback;
          return vi.fn();
        },
        onCancel: vi.fn(() => vi.fn()),
        respond,
      },
      config: { getApiUrl },
    };
    mockCallRendererTool.mockResolvedValue({ ok: true, result: {}, audit_id: 'audit-local' });

    rendererAgentBridgeModule.installRendererAgentBridge();
    onCallCallback?.({
      requestId: 'hosted-request-1',
      auditMode: 'local',
      request: {
        tool_name: 'get_workspace',
        args: {},
        agent_identity: 'local-in-app-chat',
        action_id: 'action-1',
      },
      sessionToken: 'session',
      expectedSessionToken: 'session',
      agentCapabilities: ['read-workspace'],
    });

    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(mockCreateConsoleRendererAuditSink).toHaveBeenCalledTimes(1);
    expect(mockCreateHttpRendererAuditSink).not.toHaveBeenCalled();
    expect(getApiUrl).not.toHaveBeenCalled();
  });

  it('passes the private sidecar trusted context outside the public request', async () => {
    let onCallCallback: ((payload: unknown) => void) | null = null;
    const respond = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      agentTools: {
        onCall(callback: (payload: unknown) => void) {
          onCallCallback = callback;
          return vi.fn();
        },
        onCancel: vi.fn(() => vi.fn()),
        respond,
      },
      config: { getApiUrl: vi.fn(async () => TEST_RUNTIME_SIDECAR_URL) },
    };
    mockCallRendererTool.mockResolvedValue({ ok: true, result: {}, audit_id: 'audit-1' });
    const trustedContext = { schema: 'dnaforge.managed-annotation-authority.v1' };

    rendererAgentBridgeModule.installRendererAgentBridge();
    onCallCallback?.({
      requestId: 'managed-request-1',
      request: {
        tool_name: 'operations.annotation.inspect',
        args: { operationId: 'operation-1', targetDocumentId: 'sequence-1' },
        agent_identity: 'agent-1',
        action_id: 'action-1',
      },
      sessionToken: 'session',
      expectedSessionToken: 'session',
      agentCapabilities: ['operations.read', 'read-workspace', 'read-sequences'],
      trustedContext,
    });

    await vi.waitFor(() => expect(mockCallRendererTool).toHaveBeenCalledOnce());
    expect(mockCallRendererTool.mock.calls[0]?.[0]).not.toHaveProperty('trustedContext');
    expect(mockCallRendererTool.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ trustedContext })
    );
  });

  it('keeps implicit agents independent of presentation and honors an app-owned persisted binding', async () => {
    let onCallCallback: ((payload: unknown) => void) | null = null;
    const respond = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      agentTools: {
        onCall(callback: (payload: unknown) => void) {
          onCallCallback = callback;
          return vi.fn();
        },
        onCancel: vi.fn(() => vi.fn()),
        respond,
      },
      config: { getApiUrl: vi.fn(async () => TEST_RUNTIME_SIDECAR_URL) },
    };
    mockCallRendererTool.mockResolvedValue({ ok: true, result: {}, audit_id: 'audit-1' });
    mockGetCurrentRendererWorkspaceId.mockReturnValue('folders:["/a"]');

    rendererAgentBridgeModule.installRendererAgentBridge();
    onCallCallback?.({
      requestId: 'session-a-1',
      request: {
        tool_name: 'get_workspace',
        args: {},
        agent_identity: 'agent-1',
        action_id: 'action-1',
      },
      sessionToken: 'session-a',
      expectedSessionToken: 'session-a',
      agentCapabilities: ['read-workspace'],
    });
    await vi.waitFor(() => expect(mockCallRendererTool).toHaveBeenCalledTimes(1));
    expect(mockCallRendererTool.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        boundWorkspaceId: undefined,
        currentWorkspaceId: 'folders:["/a"]',
      })
    );

    mockGetCurrentRendererWorkspaceId.mockReturnValue('folders:["/a","/b"]');
    onCallCallback?.({
      requestId: 'session-a-2',
      request: {
        tool_name: 'get_workspace',
        args: {},
        agent_identity: 'agent-2',
        action_id: 'action-2',
      },
      sessionToken: 'session-a',
      expectedSessionToken: 'session-a',
      agentCapabilities: ['read-workspace'],
    });
    await vi.waitFor(() => expect(mockCallRendererTool).toHaveBeenCalledTimes(2));
    expect(mockCallRendererTool.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        boundWorkspaceId: undefined,
        currentWorkspaceId: 'folders:["/a","/b"]',
      })
    );

    onCallCallback?.({
      requestId: 'session-b-1',
      request: {
        tool_name: 'get_workspace',
        args: {},
        agent_identity: 'agent-1',
        action_id: 'action-3',
      },
      sessionToken: 'session-b',
      expectedSessionToken: 'session-b',
      agentCapabilities: ['read-workspace'],
      boundWorkspaceId: 'folders:["/persisted"]',
    });
    await vi.waitFor(() => expect(mockCallRendererTool).toHaveBeenCalledTimes(3));
    expect(mockCallRendererTool.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        boundWorkspaceId: 'folders:["/persisted"]',
        currentWorkspaceId: 'folders:["/a","/b"]',
      })
    );
  });
});

describe('project presentation changes preserve caller authority', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mockGetCurrentRendererWorkspaceId.mockReturnValue('workspace-1');
  });

  it.each([
    { name: 'keeps implicit authority after an audited native project change', follow: true },
    { name: 'preserves an external caller binding', identity: 'external-agent', follow: false },
    { name: 'preserves an explicit grant binding', explicit: true, follow: false },
    { name: 'rejects a failed transition', failed: true, follow: false },
    { name: 'requires a completed audit', unaudited: true, follow: false },
    { name: 'rejects an unrelated tool result', tool: 'registry_records', follow: false },
    { name: 'rejects a different starting workspace', from: 'another-workspace', follow: false },
    {
      name: 'does not follow a concurrent workspace switch',
      current: 'workspace-3',
      follow: false,
    },
  ])('$name', async (example) => {
    let deliver!: (payload: RendererAgentBridgePayload) => void;
    const respond = vi.fn();
    vi.stubGlobal('electronAPI', {
      agentTools: {
        onCall: (callback: typeof deliver) => {
          deliver = callback;
          return vi.fn();
        },
        onCancel: () => vi.fn(),
        onReadResource: () => vi.fn(),
        respond,
        respondResource: vi.fn(),
      } satisfies Window['electronAPI']['agentTools'],
      config: { getApiUrl: async () => TEST_RUNTIME_SIDECAR_URL },
    });
    mockGetCurrentRendererWorkspaceId.mockReturnValue('workspace-1');
    mockCallRendererTool
      .mockImplementationOnce(async () => {
        mockGetCurrentRendererWorkspaceId.mockReturnValue(example.current ?? 'workspace-2');
        return example.failed
          ? { ok: false, error: { code: 'HANDLER_ERROR' } }
          : {
              ok: true,
              audit_id: example.unaudited ? undefined : 'completed-audit',
              result: {
                workspaceTransition: {
                  fromWorkspaceId: example.from ?? 'workspace-1',
                  toWorkspaceId: 'workspace-2',
                },
              },
            };
      })
      .mockResolvedValueOnce({ ok: true, result: {}, audit_id: 'next-audit' });
    const dispose = rendererAgentBridgeModule.installRendererAgentBridge();
    const payload = (id: string, tool: string): RendererAgentBridgePayload => ({
      requestId: id,
      sessionToken: 'session',
      expectedSessionToken: 'session',
      agentCapabilities: ['read-workspace', 'write-workspace', 'modify-tabs', 'create-entity'],
      ...(example.explicit ? { boundWorkspaceId: 'workspace-1' } : {}),
      request: {
        tool_name: tool,
        args: {},
        agent_identity: example.identity ?? 'local-in-app-chat',
        action_id: id,
      },
    });
    deliver(payload('create-project', example.tool ?? 'workspace_projects'));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    deliver(payload('next-call', 'get_workspace'));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(mockCallRendererTool.mock.calls.at(-1)?.[1]).toMatchObject({
      boundWorkspaceId: example.explicit ? 'workspace-1' : undefined,
    });
    dispose();
  });
});
