import type { AgentProjectScope, AuthorizedProjectFolder } from '../../shared/agent-project-scope';
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
  projectScope?: AgentProjectScope;
  authorizedFolders?: AuthorizedProjectFolder[];
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
  projectScope?: AgentProjectScope;
  authorizedFolders?: AuthorizedProjectFolder[];
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
        const boundWorkspaceId = payload.boundWorkspaceId;

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
          folders: payload.authorizedFolders ?? useWorkspaceStore.getState().folders,
          projectScope: payload.projectScope,
          auditSink,
          abortSignal: abortController.signal,
          trustedContext: payload.trustedContext,
        });

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
              const boundWorkspaceId = payload.boundWorkspaceId;
              const response = await readSelectionResource(payload.referenceId, {
                expectedSessionToken: payload.expectedSessionToken,
                providedSessionToken: payload.sessionToken,
                agentCapabilities: payload.agentCapabilities,
                boundWorkspaceId,
                currentWorkspaceId,
                folders: payload.authorizedFolders ?? useWorkspaceStore.getState().folders,
                projectScope: payload.projectScope,
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
    for (const active of controllersByRequestId.values()) {
      if (active.cancelable) active.controller.abort();
    }
  };
}
