import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  callRendererTool,
  createConsoleRendererAuditSink,
  createHttpRendererAuditSink,
  getCurrentRendererWorkspaceId,
  type RendererAuditSink,
  type RendererToolCallRequest,
  type RendererToolCallResponse,
} from './renderer-bridge';
import { readSelectionResource, type RendererResourceReadResponse } from './renderer-resource';

export interface RendererAgentBridgePayload {
  requestId: string;
  turnId?: string;
  auditMode?: 'local';
  cancelable?: boolean;
  request: RendererToolCallRequest;
  sessionToken: string;
  expectedSessionToken: string;
  agentCapabilities: string[];
  boundWorkspaceId?: string;
  trustedContext?: unknown;
}

interface RendererAgentBridgeCancelPayload {
  requestId: string;
  turnId?: string;
}

interface RendererAgentBridgeResourceReadPayload {
  requestId: string;
  referenceId: string;
  turnId?: string;
  sessionToken: string;
  expectedSessionToken: string;
  agentIdentity: string;
  agentCapabilities: string[];
  boundWorkspaceId?: string;
}

type AgentToolsApi = {
  onCall(callback: (payload: RendererAgentBridgePayload) => void): () => void;
  onCancel(callback: (payload: RendererAgentBridgeCancelPayload) => void): () => void;
  onReadResource?(callback: (payload: RendererAgentBridgeResourceReadPayload) => void): () => void;
  respond(requestId: string, response: RendererToolCallResponse): void;
  respondResource?(requestId: string, response: RendererResourceReadResponse): void;
};

type DesktopApi = {
  agentTools?: AgentToolsApi;
  config?: { getApiUrl(): Promise<string> };
};

function getDesktopApi(): DesktopApi | null {
  const maybeWindow = window as Window & { electronAPI?: DesktopApi };
  return maybeWindow.electronAPI ?? null;
}

export function installRendererAgentBridge(): () => void {
  const desktopApi = getDesktopApi();
  const agentTools = desktopApi?.agentTools ?? null;
  if (!agentTools) return () => {};

  const workspaceBindingByAgent = new Map<string, string | null>();
  const bindWorkspaceForAgent = (
    agentIdentity: string,
    currentWorkspaceId: string | null
  ): string | null => {
    if (!agentIdentity) return currentWorkspaceId;
    const existing = workspaceBindingByAgent.get(agentIdentity);
    if (existing !== undefined) return existing;
    workspaceBindingByAgent.set(agentIdentity, currentWorkspaceId);
    return currentWorkspaceId;
  };
  let apiUrlPromise: Promise<string> | null = null;
  const getApiUrl = () => {
    if (!desktopApi?.config) {
      return Promise.reject(new Error('Desktop API config bridge is unavailable.'));
    }
    apiUrlPromise ??= desktopApi.config.getApiUrl();
    return apiUrlPromise;
  };

  const controllersByRequestId = new Map<
    string,
    { controller: AbortController; cancelable: boolean }
  >();
  let disposed = false;

  const unsubscribeCall = agentTools.onCall((payload) => {
    void (async () => {
      const abortController = new AbortController();
      controllersByRequestId.set(payload.requestId, {
        controller: abortController,
        cancelable: payload.cancelable !== false,
      });
      try {
        const currentWorkspaceId = getCurrentRendererWorkspaceId();
        const boundWorkspaceId =
          payload.boundWorkspaceId ??
          bindWorkspaceForAgent(payload.request.agent_identity, currentWorkspaceId);

        const auditSink: RendererAuditSink =
          payload.auditMode === 'local'
            ? createConsoleRendererAuditSink()
            : createHttpRendererAuditSink({ apiUrl: await getApiUrl() });
        const response = await callRendererTool(payload.request, {
          turnId: payload.turnId,
          expectedSessionToken: payload.expectedSessionToken,
          providedSessionToken: payload.sessionToken,
          agentCapabilities: payload.agentCapabilities,
          boundWorkspaceId,
          currentWorkspaceId,
          folders: useWorkspaceStore.getState().folders,
          auditSink,
          abortSignal: abortController.signal,
          trustedContext: payload.trustedContext,
        });

        if (
          payload.boundWorkspaceId === undefined &&
          payload.request.agent_identity === 'local-in-app-chat' &&
          payload.request.tool_name === 'workspace_projects' &&
          response.ok &&
          response.audit_id &&
          response.result &&
          typeof response.result === 'object'
        ) {
          const transition = (
            response.result as {
              workspaceTransition?: {
                fromWorkspaceId?: unknown;
                toWorkspaceId?: unknown;
              };
            }
          ).workspaceTransition;
          const nextWorkspaceId = getCurrentRendererWorkspaceId();
          if (
            transition &&
            transition.fromWorkspaceId === boundWorkspaceId &&
            transition.fromWorkspaceId === currentWorkspaceId &&
            transition.toWorkspaceId === nextWorkspaceId &&
            workspaceBindingByAgent.get(payload.request.agent_identity) === boundWorkspaceId
          )
            workspaceBindingByAgent.set(payload.request.agent_identity, nextWorkspaceId);
        }
        agentTools.respond(payload.requestId, response);
      } catch (err) {
        agentTools.respond(payload.requestId, {
          ok: false,
          error: {
            code: 'HANDLER_ERROR',
            message: err instanceof Error ? err.message : String(err),
            retriable: true,
          },
        });
      } finally {
        controllersByRequestId.delete(payload.requestId);
        if (disposed && controllersByRequestId.size === 0) unsubscribeCancel();
      }
    })();
  });
  const unsubscribeCancel = agentTools.onCancel((payload) => {
    const active = controllersByRequestId.get(payload.requestId);
    if (active?.cancelable) active.controller.abort();
  });

  const respondResource = agentTools.respondResource;
  const unsubscribeReadResource =
    agentTools.onReadResource && respondResource
      ? agentTools.onReadResource((payload) => {
          void (async () => {
            try {
              const currentWorkspaceId = getCurrentRendererWorkspaceId();
              const boundWorkspaceId =
                payload.boundWorkspaceId ??
                bindWorkspaceForAgent(payload.agentIdentity, currentWorkspaceId);
              const response = await readSelectionResource(payload.referenceId, {
                expectedSessionToken: payload.expectedSessionToken,
                providedSessionToken: payload.sessionToken,
                agentCapabilities: payload.agentCapabilities,
                boundWorkspaceId,
                currentWorkspaceId,
                folders: useWorkspaceStore.getState().folders,
              });
              respondResource(payload.requestId, response);
            } catch (err) {
              respondResource(payload.requestId, {
                ok: false,
                error: {
                  code: 'HANDLER_ERROR',
                  message: err instanceof Error ? err.message : String(err),
                  retriable: true,
                },
              });
            }
          })();
        })
      : () => {};

  return () => {
    disposed = true;
    unsubscribeCall();
    if (controllersByRequestId.size === 0) unsubscribeCancel();
    unsubscribeReadResource();
    workspaceBindingByAgent.clear();
    for (const active of controllersByRequestId.values()) {
      if (active.cancelable) active.controller.abort();
    }
  };
}
