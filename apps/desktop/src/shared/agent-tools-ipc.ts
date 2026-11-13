export interface RendererToolCallRequestShape {
  tool_name: string;
  args?: unknown;
  agent_identity: string;
  action_id: string;
  parent_action_id?: string;
}

export interface RendererAgentBridgePayload {
  requestId: string;
  cancelable?: boolean;
  turnId?: string;
  request: RendererToolCallRequestShape;
  sessionToken: string;
  expectedSessionToken: string;
  agentCapabilities: string[];
  boundWorkspaceId?: string;
  trustedContext?: unknown;
}

export interface RendererAgentBridgeCancelPayload {
  requestId: string;
  turnId?: string;
}

export interface RendererAgentBridgeResourceReadPayload {
  requestId: string;
  referenceId: string;
  turnId?: string;
  sessionToken: string;
  expectedSessionToken: string;
  agentIdentity: string;
  agentCapabilities: string[];
  boundWorkspaceId?: string;
}

export interface RendererToolCallErrorShape {
  code: string;
  domain?: 'core' | 'structure-mcp' | 'sequence-mcp';
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
}

export type RendererToolCallResponseShape =
  | { ok: true; result: unknown; audit_id: string }
  | { ok: false; error: RendererToolCallErrorShape; audit_id?: string };

export interface RendererResourceReferenceShape {
  id: string;
  entityType: string;
  displayLabel: string;
  locator: string;
  deepLinkParams: unknown;
  data: unknown;
}

export type RendererResourceReadResponseShape =
  | { ok: true; reference: RendererResourceReferenceShape }
  | { ok: false; error: { code: string; message: string; retriable: boolean } };
