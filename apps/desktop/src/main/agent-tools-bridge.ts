import {
  agentToolResourceResponseChannel,
  agentToolResponseChannel,
  mainIpc,
  sendRendererIpc,
} from '../shared/ipc-contract';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserWindow, type WebContents } from 'electron';
import type { RendererToolCallResponseShape } from '../shared/agent-tools-ipc';
import { IN_APP_CHAT_AGENT_IDENTITY, mintInAppChatGrant } from './agent-grants';
import { resolveCurrentAgentCaller } from './agent-caller';
import { AgentAuthorityError } from '../shared/agent-caller';
import { observeRendererUi } from './renderer-ui-observation';
import { observeExternalAccess } from './external-access-observation';
import { projectExternalAccessObservation } from '../shared/external-access-telemetry';
import {
  onProteinExperimentTurnReleased,
  proteinExperimentRendererForTurn,
} from './protein-experiment-workers';
import {
  recordCompletedResourceRead,
  recordCompletedToolCall,
} from './agent-sdk/turn-workspace-provenance';
import {
  agentProjectScopeSchema,
  legacyProjectScope,
  type AgentProjectScope,
  type AuthorizedProjectFolder,
} from '../shared/agent-project-scope';
import {
  createRegisteredProjectAuthority,
  type RegisteredProjectAuthority,
} from './registered-project-authority';
import { getDb } from './ipc/database';

const MAX_BODY_BYTES = 1024 * 1024;

function requestProjectScope(req: IncomingMessage): AgentProjectScope {
  const supplied = readHeader(req, 'x-dnaforge-project-scope');
  if (!supplied)
    return legacyProjectScope(readHeader(req, 'x-dnaforge-bound-workspace') || undefined);
  try {
    return agentProjectScopeSchema.parse(JSON.parse(supplied));
  } catch {
    return { kind: 'project-roots', roots: [] };
  }
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface AgentToolsBridgeServer {
  url: string;
  sessionToken: string;
  agentIdentityId: string;
  capabilities: string[];
  callTool(request: {
    readonly turnId: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly actionId: string;
  }): Promise<RendererToolCallResponseShape>;
  close(): Promise<void>;
}

interface RendererBridgePayload {
  requestId: string;
  turnId?: string;
  auditMode?: 'local';
  request: {
    tool_name: string;
    args?: unknown;
    agent_identity: string;
    action_id: string;
    parent_action_id?: string;
  };
  sessionToken: string;
  expectedSessionToken: string;
  agentCapabilities: string[];
  boundWorkspaceId?: string;
  projectScope?: AgentProjectScope;
  authorizedFolders?: AuthorizedProjectFolder[];
  trustedContext?: unknown;
}

interface ActiveRendererToolCall {
  requestId: string;
  turnId?: string;
  cancel(): void;
}

const activeRendererToolCalls = new Map<string, ActiveRendererToolCall>();
const activeRendererToolCallsByTurn = new Map<string, Set<string>>();

export function cancelRendererToolCallsForTurn(turnId: string): number {
  const requestIds = activeRendererToolCallsByTurn.get(turnId);
  if (!requestIds || requestIds.size === 0) return 0;

  let canceled = 0;
  for (const requestId of [...requestIds]) {
    const active = activeRendererToolCalls.get(requestId);
    if (!active) continue;
    active.cancel();
    canceled += 1;
  }
  return canceled;
}

export async function startAgentToolsBridge(
  mainWindow: BrowserWindow,
  options: {
    port?: number;
    sessionToken?: string;
    capabilities?: readonly string[];
    timeoutMs?: number;
    observationSessionToken?: () => string | null;
    resolveRendererTarget?: (turnId?: string) => WebContents | null | undefined;
    projectAuthority?: RegisteredProjectAuthority;
  } = {}
): Promise<AgentToolsBridgeServer> {
  const grant = mintInAppChatGrant({
    sessionToken: options.sessionToken,
    capabilities: options.capabilities,
  });
  const sessionToken = grant.sessionToken;
  const agentIdentityId = grant.agentIdentityId;
  const capabilities = grant.capabilities;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const projectAuthority =
    options.projectAuthority ?? createRegisteredProjectAuthority({ db: getDb });

  const operations = new RendererOperations(
    mainWindow,
    timeoutMs,
    options.resolveRendererTarget ?? proteinExperimentRendererForTurn,
    projectAuthority
  );
  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      mainWindow,
      sessionToken,
      timeoutMs,
      operations,
      projectAuthority,
      ...(options.observationSessionToken
        ? { observationSessionToken: options.observationSessionToken }
        : {}),
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    sessionToken,
    agentIdentityId,
    capabilities,
    callTool: async (request) => {
      const authorityRequestId = randomUUID();
      const controller = new AbortController();
      registerActiveRendererToolCall({
        requestId: authorityRequestId,
        turnId: request.turnId,
        cancel: () =>
          controller.abort(
            new AgentAuthorityError(
              'STOP_REQUESTED',
              'The turn stopped before the tool ran.',
              false
            )
          ),
      });
      try {
        const caller = await resolveCurrentAgentCaller(controller.signal);
        controller.signal.throwIfAborted();
        return operations.call(
          {
            requestId: randomUUID(),
            turnId: request.turnId,
            auditMode: 'local',
            request: {
              tool_name: request.toolName,
              args: request.args,
              agent_identity: caller.agentIdentityId,
              action_id: request.actionId,
            },
            sessionToken,
            expectedSessionToken: sessionToken,
            agentCapabilities: [...caller.effectiveCapabilities],
          },
          true,
          true
        );
      } finally {
        unregisterActiveRendererToolCall(authorityRequestId);
      }
    },
    close: () => {
      operations.close();
      return closeServer(server);
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    mainWindow: BrowserWindow;
    sessionToken: string;
    timeoutMs: number;
    operations: RendererOperations;
    projectAuthority: RegisteredProjectAuthority;
    observationSessionToken?: () => string | null;
  }
): Promise<void> {
  const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (
    req.method === 'POST' &&
    ['/__external-access/observe', '/__external-access/workspace-bound'].includes(
      parsedUrl.pathname
    )
  ) {
    if (req.headers.origin !== undefined || parsedUrl.search) {
      writeJson(res, 403, { ok: false, error: { code: 'OBSERVATION_ORIGIN_REFUSED' } });
      return;
    }
    let source: string | null;
    try {
      source = options.observationSessionToken?.() ?? null;
    } catch {
      writeJson(res, 503, { ok: false });
      return;
    }
    if (
      !options.sessionToken ||
      !tokensEqual(readHeader(req, 'x-dnaforge-session'), options.sessionToken) ||
      !source ||
      !tokensEqual(readHeader(req, 'x-dnaforge-sidecar-session'), source)
    ) {
      writeJson(res, 401, { ok: false, error: { code: 'BAD_OBSERVATION_SOURCE' } });
      return;
    }
    if (parsedUrl.pathname === '/__external-access/workspace-bound') {
      if (options.mainWindow.isDestroyed()) {
        writeJson(res, 503, { ok: false });
        return;
      }
      writeJson(res, 200, { ok: true });
      return;
    }
    let observation;
    try {
      observation = projectExternalAccessObservation(await readJsonBody(req));
    } catch {
      observation = null;
    }
    if (!observation) {
      writeJson(res, 400, { ok: false, error: { code: 'BAD_OBSERVATION' } });
      return;
    }
    let currentSource: string | null;
    try {
      currentSource = options.observationSessionToken?.() ?? null;
    } catch {
      writeJson(res, 503, { ok: false });
      return;
    }
    if (!currentSource || !tokensEqual(source, currentSource)) {
      writeJson(res, 401, { ok: false, error: { code: 'BAD_OBSERVATION_SOURCE' } });
      return;
    }
    writeJson(res, 200, { ok: true, emitted: observeExternalAccess(observation) });
    return;
  }
  if (req.method === 'GET' && parsedUrl.pathname === '/__test/ui-observation') {
    await handleTestUiObservation(req, res, options, parsedUrl);
    return;
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/__test/reference-navigation') {
    await handleTestReferenceNavigation(req, res, options);
    return;
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/__resources/read') {
    await handleResourceRead(req, res, options);
    return;
  }

  if (req.method !== 'POST' || !['/__tools/call', '/__tools/result'].includes(parsedUrl.pathname)) {
    writeJson(res, 404, {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: 'Unknown renderer bridge endpoint.',
        retriable: false,
      },
    });
    return;
  }

  const providedSession = readHeader(req, 'x-dnaforge-session');
  if (!tokensEqual(providedSession, options.sessionToken)) {
    writeJson(res, 401, {
      ok: false,
      error: {
        code: 'BAD_SESSION',
        message: 'Renderer bridge session token is missing or invalid.',
        retriable: true,
      },
    });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: err instanceof Error ? err.message : String(err),
        retriable: false,
      },
    });
    return;
  }

  if (parsedUrl.pathname === '/__tools/result') {
    const response = await options.operations.lookup(
      readHeader(req, 'x-dnaforge-agent-identity') || IN_APP_CHAT_AGENT_IDENTITY,
      readHeader(req, 'x-dnaforge-action-id') || stringField(body, 'action_id'),
      parseCapabilities(readHeader(req, 'x-dnaforge-agent-capabilities'))
    );
    writeJson(res, statusCodeForRendererResponse(response), response);
    return;
  }

  const toolName = body['tool_name'];
  if (typeof toolName !== 'string' || toolName.length === 0) {
    writeJson(res, 400, {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: 'Renderer tool call must include tool_name.',
        retriable: false,
      },
    });
    return;
  }

  const actionId = readHeader(req, 'x-dnaforge-action-id') || stringField(body, 'action_id');
  const agentIdentity =
    readHeader(req, 'x-dnaforge-agent-identity') || stringField(body, 'agent_identity');
  const turnId = readHeader(req, 'x-dnaforge-turn-id') || undefined;
  const payload: RendererBridgePayload = {
    requestId: randomUUID(),
    ...(turnId ? { turnId } : {}),
    request: {
      tool_name: toolName,
      args: body['args'] ?? {},
      agent_identity: agentIdentity || IN_APP_CHAT_AGENT_IDENTITY,
      action_id: actionId || randomUUID(),
      ...(typeof body['parent_action_id'] === 'string'
        ? { parent_action_id: body['parent_action_id'] }
        : {}),
    },
    sessionToken: providedSession,
    expectedSessionToken: options.sessionToken,
    agentCapabilities: parseCapabilities(readHeader(req, 'x-dnaforge-agent-capabilities')),
    projectScope: requestProjectScope(req),
    ...(readHeader(req, 'x-dnaforge-bound-workspace')
      ? { boundWorkspaceId: readHeader(req, 'x-dnaforge-bound-workspace') }
      : {}),
    ...(body['trusted_context'] !== undefined ? { trustedContext: body['trusted_context'] } : {}),
  };

  try {
    const response = await options.operations.call(
      payload,
      readHeader(req, 'x-dnaforge-cancelable') === 'true'
    );
    writeJson(res, statusCodeForRendererResponse(response), response);
  } catch (err) {
    writeJson(res, 500, {
      ok: false,
      error: {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retriable: true,
      },
    });
  }
}

async function handleResourceRead(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    mainWindow: BrowserWindow;
    sessionToken: string;
    timeoutMs: number;
    projectAuthority: RegisteredProjectAuthority;
  }
): Promise<void> {
  const providedSession = readHeader(req, 'x-dnaforge-session');
  if (!tokensEqual(providedSession, options.sessionToken)) {
    writeJson(res, 401, {
      ok: false,
      error: {
        code: 'BAD_SESSION',
        message: 'Renderer bridge session token is missing or invalid.',
        retriable: true,
      },
    });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: err instanceof Error ? err.message : String(err),
        retriable: false,
      },
    });
    return;
  }

  const referenceId = body['reference_id'];
  if (typeof referenceId !== 'string' || referenceId.length === 0) {
    writeJson(res, 400, {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: 'Renderer resource read must include reference_id.',
        retriable: false,
      },
    });
    return;
  }

  try {
    const agentIdentity =
      readHeader(req, 'x-dnaforge-agent-identity') || IN_APP_CHAT_AGENT_IDENTITY;
    const boundWorkspaceId = readHeader(req, 'x-dnaforge-bound-workspace') || undefined;
    const turnId = readHeader(req, 'x-dnaforge-turn-id') || undefined;
    const projectScope = requestProjectScope(req);
    const response = await sendRendererResourceRead(
      options.mainWindow,
      {
        referenceId,
        ...(turnId ? { turnId } : {}),
        sessionToken: providedSession,
        expectedSessionToken: options.sessionToken,
        agentIdentity,
        agentCapabilities: parseCapabilities(readHeader(req, 'x-dnaforge-agent-capabilities')),
        projectScope,
        authorizedFolders: options.projectAuthority.folders(projectScope),
        ...(boundWorkspaceId ? { boundWorkspaceId } : {}),
      },
      options.timeoutMs
    );
    writeJson(res, statusCodeForRendererResponse(response), response);
  } catch (err) {
    writeJson(res, 500, {
      ok: false,
      error: {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retriable: true,
      },
    });
  }
}

function sendRendererResourceRead(
  mainWindow: BrowserWindow,
  payload: {
    referenceId: string;
    turnId?: string;
    sessionToken: string;
    expectedSessionToken: string;
    agentIdentity: string;
    agentCapabilities: string[];
    boundWorkspaceId?: string;
    projectScope?: AgentProjectScope;
    authorizedFolders?: AuthorizedProjectFolder[];
  },
  timeoutMs: number
): Promise<unknown> {
  if (mainWindow.isDestroyed()) {
    return Promise.reject(new Error('Renderer window is not available.'));
  }

  const requestId = randomUUID();
  const channel = agentToolResourceResponseChannel(requestId);
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      mainIpc.removeListener(channel, listener);
    };
    const listener = (_event: Electron.IpcMainEvent, response: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ((response as { ok?: unknown })?.ok === true) {
        recordCompletedResourceRead(payload.turnId, payload.referenceId);
      }
      resolve(response);
    };

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Renderer resource read timed out.'));
    }, timeoutMs);

    mainIpc.once(channel, listener);
    sendRendererIpc(mainWindow.webContents, 'agent-tools:read-resource', { requestId, ...payload });
  });
}

async function handleTestReferenceNavigation(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    mainWindow: BrowserWindow;
    sessionToken: string;
    timeoutMs: number;
  }
): Promise<void> {
  if (process.env.WAYPOINT_TEST !== '1') {
    writeJson(res, 404, {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: 'Test reference navigation endpoint is disabled.',
        retriable: false,
      },
    });
    return;
  }

  const providedSession = readHeader(req, 'x-dnaforge-session');
  if (!tokensEqual(providedSession, options.sessionToken)) {
    writeJson(res, 401, {
      ok: false,
      error: {
        code: 'BAD_SESSION',
        message: 'Renderer bridge session token is missing or invalid.',
        retriable: true,
      },
    });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: err instanceof Error ? err.message : String(err),
        retriable: false,
      },
    });
    return;
  }

  const referenceId = body['referenceId'];
  if (typeof referenceId !== 'string' || referenceId.length === 0) {
    writeJson(res, 400, {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: 'Reference navigation requires referenceId.',
        retriable: false,
      },
    });
    return;
  }

  try {
    const navigation = await navigateRendererReference(options.mainWindow, referenceId);
    writeJson(res, 200, { ok: true, navigation });
  } catch (err) {
    writeJson(res, 500, {
      ok: false,
      error: {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retriable: true,
      },
    });
  }
}

async function handleTestUiObservation(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    mainWindow: BrowserWindow;
    sessionToken: string;
    timeoutMs: number;
  },
  url: URL
): Promise<void> {
  if (process.env.WAYPOINT_TEST !== '1') {
    writeJson(res, 404, {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: 'Test UI observation endpoint is disabled.',
        retriable: false,
      },
    });
    return;
  }

  const providedSession = readHeader(req, 'x-dnaforge-session');
  if (!tokensEqual(providedSession, options.sessionToken)) {
    writeJson(res, 401, {
      ok: false,
      error: {
        code: 'BAD_SESSION',
        message: 'Renderer bridge session token is missing or invalid.',
        retriable: true,
      },
    });
    return;
  }

  try {
    const observation = await observeRendererUi(
      options.mainWindow,
      url.searchParams.get('label') || undefined,
      url.searchParams.get('designId') || undefined
    );
    writeJson(res, 200, { ok: true, observation });
  } catch (err) {
    writeJson(res, 500, {
      ok: false,
      error: {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retriable: true,
      },
    });
  }
}

function navigateRendererReference(
  mainWindow: BrowserWindow,
  referenceId: string
): Promise<unknown> {
  if (mainWindow.isDestroyed()) {
    return Promise.reject(new Error('Renderer window is not available.'));
  }

  const script = `
    (async () => {
      const bridge = window.__test;
      if (!bridge?.openReferenceById) {
        return { ok: false, reason: 'missing_test_bridge' };
      }
      return bridge.openReferenceById(${JSON.stringify(referenceId)});
    })()
  `;

  return mainWindow.webContents.executeJavaScript(script, true) as Promise<unknown>;
}

interface RendererOperation {
  payload: RendererBridgePayload;
  experimental: boolean;
  fingerprint: string;
  response?: RendererToolCallResponseShape;
  expiresAt?: number;
  waiters: Set<(response: RendererToolCallResponseShape) => void>;
  dispose(): void;
  finish(response: RendererToolCallResponseShape): void;
}

const RESULT_RETENTION_MS = 600_000;
const MAX_OPERATIONS = 256;
const MAX_EXPERIMENT_OPERATIONS = 1024;
const MAX_OPERATION_WAITERS = 8;
const MAIN_CALL_WAIT_MS = 3_600_000;

class RendererOperations {
  private readonly entries = new Map<string, RendererOperation>();
  private readonly renderer: WebContents;
  private readonly unsubscribeReleasedTurns: () => void;
  private closed = false;
  private readonly lost = () => this.invalidate();

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly timeoutMs: number,
    private readonly resolveRendererTarget: (turnId?: string) => WebContents | null | undefined,
    private readonly projectAuthority: RegisteredProjectAuthority
  ) {
    this.renderer = mainWindow.webContents;
    this.renderer.on?.('destroyed', this.lost);
    this.renderer.on?.('render-process-gone', this.lost);
    this.renderer.on?.('did-start-navigation', this.onNavigation);
    this.unsubscribeReleasedTurns = onProteinExperimentTurnReleased((turnId) => {
      for (const [key, operation] of this.entries) {
        if (
          operation.experimental &&
          operation.payload.turnId === turnId &&
          operation.response &&
          (operation.response.ok || operation.response.error.code !== 'OUTCOME_UNRESOLVED')
        )
          this.entries.delete(key);
      }
    });
  }

  private readonly onNavigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean
  ) => {
    if (isMainFrame && !isInPlace) this.invalidate();
  };

  private key(identity: string, actionId: string): string {
    return JSON.stringify([identity, actionId]);
  }

  private prune(): void {
    for (const [key, operation] of this.entries) {
      if (operation.expiresAt !== undefined && operation.expiresAt <= Date.now()) {
        this.entries.delete(key);
      }
    }
  }

  call(
    payload: RendererBridgePayload,
    cancelable: boolean,
    mainOwned = false
  ): Promise<RendererToolCallResponseShape> {
    const projectScope = payload.projectScope ?? legacyProjectScope(payload.boundWorkspaceId);
    payload = {
      ...payload,
      projectScope,
      authorizedFolders: this.projectAuthority.folders(projectScope),
    };
    this.prune();
    const key = this.key(payload.request.agent_identity, payload.request.action_id);
    const fingerprint = JSON.stringify([
      payload.request,
      [...payload.agentCapabilities].sort(),
      payload.turnId,
      payload.auditMode,
      payload.trustedContext,
      cancelable,
    ]);
    let operation = this.entries.get(key);
    if (operation && operation.fingerprint !== fingerprint) {
      return Promise.resolve(
        operationError(
          payload,
          'ACTION_CONFLICT',
          'This action ID already belongs to a different request.'
        )
      );
    }
    if (!operation) {
      const workerTarget = this.resolveRendererTarget(payload.turnId);
      const experimental = workerTarget !== undefined;
      if (
        experimental &&
        !payload.request.tool_name.startsWith('mol_') &&
        payload.request.tool_name !== 'protein_get_context'
      ) {
        return Promise.resolve(
          operationError(
            payload,
            'OUTSIDE_EXPERIMENT_CONTEXT',
            'This isolated experiment cannot use non-molecular tools.'
          )
        );
      }
      const renderer = experimental ? workerTarget : this.renderer;
      if (this.closed || this.mainWindow.isDestroyed() || !renderer || renderer.isDestroyed?.()) {
        return Promise.resolve(
          operationError(
            payload,
            'OUTCOME_UNRESOLVED',
            'The renderer connection is unavailable. Recover the original action before repeating work.'
          )
        );
      }
      const retained = [...this.entries.values()].filter(
        (entry) => entry.experimental === experimental
      ).length;
      if (retained >= (experimental ? MAX_EXPERIMENT_OPERATIONS : MAX_OPERATIONS)) {
        return Promise.resolve(
          operationError(
            payload,
            'OPERATION_CAPACITY',
            'Renderer operation tracking is full. No new operation was dispatched.'
          )
        );
      }
      operation = this.start(payload, fingerprint, cancelable, renderer, experimental);
      this.entries.set(key, operation);
    }
    return this.wait(operation, mainOwned ? MAIN_CALL_WAIT_MS : this.timeoutMs);
  }

  lookup(
    identity: string,
    actionId: string,
    capabilities: string[]
  ): Promise<RendererToolCallResponseShape> {
    this.prune();
    const operation = this.entries.get(this.key(identity, actionId));
    if (
      !operation ||
      JSON.stringify([...operation.payload.agentCapabilities].sort()) !==
        JSON.stringify([...capabilities].sort())
    ) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'OUTCOME_UNRESOLVED',
          message:
            'No retained outcome is available for this action and scope. Consult its persisted action and audit; do not replay the write.',
          retriable: false,
          details: { actionId, stateMayHaveChanged: true },
        },
      });
    }
    return this.wait(operation, Math.min(this.timeoutMs, 5_000));
  }

  private wait(
    operation: RendererOperation,
    waitMs: number
  ): Promise<RendererToolCallResponseShape> {
    if (operation.response) return Promise.resolve(operation.response);
    if (operation.waiters.size >= MAX_OPERATION_WAITERS) {
      return Promise.resolve(
        operationError(
          operation.payload,
          'OPERATION_PENDING',
          'The operation is still owned. Recover its result with the same action ID.'
        )
      );
    }
    return new Promise((resolve) => {
      const done = (response: RendererToolCallResponseShape) => {
        clearTimeout(timer);
        operation.waiters.delete(done);
        resolve(response);
      };
      const timer = setTimeout(
        () =>
          done(
            operationError(
              operation.payload,
              'OPERATION_PENDING',
              'The operation is still owned. Recover its result with the same action ID; do not repeat the write.'
            )
          ),
        waitMs
      );
      operation.waiters.add(done);
    });
  }

  private start(
    payload: RendererBridgePayload,
    fingerprint: string,
    cancelable: boolean,
    renderer: WebContents,
    experimental: boolean
  ): RendererOperation {
    const channel = agentToolResponseChannel(payload.requestId);
    let cancellationRequested = false;
    const cancel = () => {
      if (cancellationRequested || !cancelable || operation.response) return;
      cancellationRequested = true;
      if (!renderer.isDestroyed?.()) {
        sendRendererIpc(renderer, 'agent-tools:cancel', {
          requestId: payload.requestId,
          ...(payload.turnId ? { turnId: payload.turnId } : {}),
        });
      }
    };
    const listener = (_event: Electron.IpcMainEvent, response: RendererToolCallResponseShape) => {
      if (_event.sender !== renderer) return;
      operation.finish(response);
    };
    const rendererLost = () =>
      operation.finish(
        operationError(
          payload,
          'OUTCOME_UNRESOLVED',
          'The assigned renderer connection ended before its outcome was received. Recover the persisted action and audit before repeating work.'
        )
      );
    const rendererNavigated = (
      _event: Electron.Event,
      _url: string,
      inPlace: boolean,
      isMainFrame: boolean
    ) => {
      if (isMainFrame && !inPlace) rendererLost();
    };
    const operation: RendererOperation = {
      payload,
      experimental,
      fingerprint,
      waiters: new Set(),
      dispose: () => {
        clearTimeout(deadline);
        mainIpc.removeListener(channel, listener);
        renderer.removeListener?.('destroyed', rendererLost);
        renderer.removeListener?.('render-process-gone', rendererLost);
        renderer.removeListener?.('did-start-navigation', rendererNavigated);
        unregisterActiveRendererToolCall(payload.requestId);
      },
      finish: (response) => {
        if (operation.response) return;
        operation.response = response;
        if (response.ok || response.error.code !== 'OUTCOME_UNRESOLVED') {
          operation.expiresAt = Date.now() + RESULT_RETENTION_MS;
        }
        operation.dispose();
        if (response.ok) {
          try {
            recordCompletedToolCall(
              payload.turnId,
              payload.request.tool_name,
              payload.request.args
            );
          } catch (error) {
            console.error('[AgentToolsBridge] Failed to record workspace provenance:', error);
          }
        }
        for (const waiter of [...operation.waiters]) waiter(response);
      },
    };
    mainIpc.on(channel, listener);
    renderer.on?.('destroyed', rendererLost);
    renderer.on?.('render-process-gone', rendererLost);
    renderer.on?.('did-start-navigation', rendererNavigated);
    if (cancelable)
      registerActiveRendererToolCall({
        requestId: payload.requestId,
        turnId: payload.turnId,
        cancel,
      });
    const deadline = setTimeout(cancel, this.timeoutMs);
    try {
      sendRendererIpc(renderer, 'agent-tools:call', { ...payload, cancelable });
    } catch {
      operation.finish(
        operationError(
          payload,
          'OUTCOME_UNRESOLVED',
          'Renderer delivery was interrupted. Recover the original action before repeating work.'
        )
      );
    }
    return operation;
  }

  close(): void {
    this.closed = true;
    this.unsubscribeReleasedTurns();
    this.renderer.removeListener?.('destroyed', this.lost);
    this.renderer.removeListener?.('render-process-gone', this.lost);
    this.renderer.removeListener?.('did-start-navigation', this.onNavigation);
    this.invalidate();
    this.entries.clear();
  }

  private invalidate(): void {
    for (const operation of this.entries.values()) {
      operation.finish(
        operationError(
          operation.payload,
          'OUTCOME_UNRESOLVED',
          'The renderer connection ended before its outcome was received. Recover the persisted action and audit before repeating work.'
        )
      );
    }
  }
}

function operationError(
  payload: RendererBridgePayload,
  code: string,
  message: string
): RendererToolCallResponseShape {
  return {
    ok: false,
    error: {
      code,
      domain: 'core',
      message,
      retriable: false,
      details: {
        actionId: payload.request.action_id,
        requestId: payload.requestId,
        stateMayHaveChanged: code !== 'OPERATION_CAPACITY' && code !== 'OUTSIDE_EXPERIMENT_CONTEXT',
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
      },
    },
  };
}

function registerActiveRendererToolCall(call: ActiveRendererToolCall): void {
  activeRendererToolCalls.set(call.requestId, call);
  if (!call.turnId) return;
  const requestIds = activeRendererToolCallsByTurn.get(call.turnId) ?? new Set<string>();
  requestIds.add(call.requestId);
  activeRendererToolCallsByTurn.set(call.turnId, requestIds);
}

function unregisterActiveRendererToolCall(requestId: string): void {
  const active = activeRendererToolCalls.get(requestId);
  if (!active) return;
  activeRendererToolCalls.delete(requestId);
  if (!active.turnId) return;
  const requestIds = activeRendererToolCallsByTurn.get(active.turnId);
  if (!requestIds) return;
  requestIds.delete(requestId);
  if (requestIds.size === 0) {
    activeRendererToolCallsByTurn.delete(active.turnId);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Renderer tool call body is too large.');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Renderer tool call body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function statusCodeForRendererResponse(response: unknown): number {
  if (!response || typeof response !== 'object') return 500;
  const error = (response as { error?: { code?: unknown } }).error;
  if (error?.code === 'BAD_SESSION') return 401;
  if (error?.code === 'UNKNOWN_TOOL') return 404;
  return 200;
}

function readHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function parseCapabilities(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
