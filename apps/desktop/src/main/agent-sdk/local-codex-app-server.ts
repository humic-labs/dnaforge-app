import type { NativeTurnFailure } from '../../shared/native-turn-failure';
import { codexCompletedTool, codexTurnError } from './native-provider-error';
import { execFile, spawn as defaultSpawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { CodexAppServerProtocol } from '@waypoint/codex-app-server-contract';

import {
  AppServerSupervisor,
  type IncomingServerRequest,
  type SupervisedChild,
  type SupervisorTerminationReason,
} from '../hosted-codex/app-server-supervisor';
import {
  ANSWERABLE_SERVER_REQUESTS,
  REFUSED_SERVER_REQUESTS,
} from '../hosted-codex/app-server-protocol';
import {
  answerCodexMcpElicitation,
  answerCodexRequestUserInput,
  answerCodexServerApproval,
  type RequestAgentUserInput,
} from './agent-user-input-adapters';
import { nodeAwareSpawn } from './cli-layout';
import { codexCliEnv } from './subprocess-env';
import { DNAFORGE_MCP_SERVER_NAME } from './cli-mcp';
import { CODEX_APP_MCP_FEATURES } from './codex-mcp-session-config';
import { codexProfile, type ResolvedAgentPermissions } from '../../shared/agent-permissions';
import type { ApprovalMemory } from './approval-memory';
import type { ApprovalRoot } from './approval-rules';

export const LOCAL_CODEX_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface LocalCodexAppServer {
  supervisor: AppServerSupervisor;
  runtimeDir: string;
  protocol: LocalCodexProtocol;
  dispose(): Promise<void>;
}

type SpawnLocalAppServer = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'pipe' }
) => SupervisedChild;

export interface LocalCodexProtocol {
  client: string[];
  server: string[];
  notification: string[];
}

const REQUIRED_LOCAL_CODEX_CLIENT_METHODS = [
  'initialize',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
] as const;
const REQUIRED_LOCAL_CODEX_SERVER_METHODS = [
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
] as const;

export function validateLocalCodexProtocol(protocol: LocalCodexProtocol): LocalCodexProtocol {
  const missingClient = REQUIRED_LOCAL_CODEX_CLIENT_METHODS.filter(
    (method) => !protocol.client.includes(method)
  );
  const missingServer = REQUIRED_LOCAL_CODEX_SERVER_METHODS.filter(
    (method) => !protocol.server.includes(method)
  );
  const undecidedServer = protocol.server.filter(
    (method) =>
      !ANSWERABLE_SERVER_REQUESTS.includes(method) &&
      !Object.hasOwn(REFUSED_SERVER_REQUESTS, method)
  );
  if (missingClient.length || missingServer.length || undecidedServer.length) {
    throw new Error(
      [
        missingClient.length ? `missing client methods: ${missingClient.join(', ')}` : null,
        missingServer.length ? `missing interaction methods: ${missingServer.join(', ')}` : null,
        undecidedServer.length ? `undecided server requests: ${undecidedServer.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('; ')
    );
  }
  return protocol;
}

function declaredMethods(schema: unknown): string[] {
  const root = record(schema);
  const variants = Array.isArray(root?.oneOf) ? root.oneOf : [];
  return [
    ...new Set(
      variants.flatMap((variant) => {
        const properties = record(record(variant)?.properties);
        const method = record(properties?.method);
        if (Array.isArray(method?.enum)) {
          return method.enum.filter((value): value is string => typeof value === 'string');
        }
        return typeof method?.const === 'string' ? [method.const] : [];
      })
    ),
  ].sort();
}

function execFileBounded(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, timeout: 10_000, maxBuffer: 2_000_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const protocolByExecutable = new Map<string, Promise<LocalCodexProtocol>>();

async function discoverLocalCodexProtocol(
  executablePath: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<LocalCodexProtocol> {
  const existing = protocolByExecutable.get(executablePath);
  if (existing) return existing;
  const work = (async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dnaforge-codex-protocol-'));
    try {
      const spawnable = nodeAwareSpawn(
        executablePath,
        ['app-server', 'generate-json-schema', '--out', out],
        env
      );
      await execFileBounded(spawnable.file, spawnable.args, { cwd, env: spawnable.env });
      return validateLocalCodexProtocol({
        client: declaredMethods(
          JSON.parse(readFileSync(path.join(out, 'ClientRequest.json'), 'utf8'))
        ),
        server: declaredMethods(
          JSON.parse(readFileSync(path.join(out, 'ServerRequest.json'), 'utf8'))
        ),
        notification: declaredMethods(
          JSON.parse(readFileSync(path.join(out, 'ServerNotification.json'), 'utf8'))
        ),
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  })();
  protocolByExecutable.set(executablePath, work);
  try {
    return await work;
  } catch (cause) {
    protocolByExecutable.delete(executablePath);
    throw cause;
  }
}

function sameDirectory(reported: unknown, expected: string): boolean {
  if (typeof reported !== 'string' || reported.length === 0) return false;
  try {
    return realpathSync(reported) === realpathSync(expected);
  } catch {
    return false;
  }
}

export async function launchLocalCodexAppServer(options: {
  binaryPath: string;
  rootDir: string;
  molecularTrialAuthor?: true;
  hostEnv?: NodeJS.ProcessEnv;
  spawn?: SpawnLocalAppServer;
  requestTimeoutMs?: number;
}): Promise<LocalCodexAppServer> {
  mkdirSync(options.rootDir, { recursive: true, mode: 0o700 });
  const runtimeDir = mkdtempSync(path.join(options.rootDir, 'local-codex-app-server-'));
  const env = codexCliEnv(options.hostEnv);
  let supervisor: AppServerSupervisor | null = null;
  let disposal: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      try {
        await supervisor?.shutdownAndWait();
      } finally {
        rmSync(runtimeDir, { recursive: true, force: true });
      }
    })();
    return disposal;
  };

  try {
    const executablePath = realpathSync(options.binaryPath);
    const protocol = await discoverLocalCodexProtocol(executablePath, env, runtimeDir);
    const startupOverrides = options.molecularTrialAuthor
      ? Object.entries(FRESH_MOLECULAR_AUTHOR_CONFIG).flatMap(([key, value]) =>
          key === 'features'
            ? Object.entries(FRESH_MOLECULAR_AUTHOR_CONFIG.features).flatMap(
                ([feature, enabled]) => ['-c', `features.${feature}=${enabled}`]
              )
            : ['-c', `${key}=${JSON.stringify(value)}`]
        )
      : [];
    const featureArgs = Object.entries(CODEX_APP_MCP_FEATURES).flatMap(([name, enabled]) => [
      '-c',
      `features.${name}=${String(enabled)}`,
    ]);
    const spawnable = nodeAwareSpawn(
      executablePath,
      [...featureArgs, 'app-server', ...startupOverrides],
      env
    );
    const child = (options.spawn ?? defaultSpawn)(spawnable.file, spawnable.args, {
      cwd: runtimeDir,
      env: spawnable.env,
      stdio: 'pipe',
    });
    child.stderr?.on('data', () => undefined);
    supervisor = new AppServerSupervisor({
      child,
      maxFrameBytes: LOCAL_CODEX_MAX_FRAME_BYTES,
      allowedNotifications: protocol.notification,
      answerableRequests: ANSWERABLE_SERVER_REQUESTS,
      refusedRequests: REFUSED_SERVER_REQUESTS,
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
    });
    child.on('exit', () => {
      void dispose().catch((error: unknown) => {
        console.error('[agent-sdk] Failed to dispose the local Codex App Server:', error);
      });
    });

    const initialized = (await supervisor.request('initialize', {
      clientInfo: { name: 'dnaforge-local', title: 'DNAForge', version: '1' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: [],
        extensions: {},
      },
    } satisfies CodexAppServerProtocol.InitializeParams)) as { codexHome?: unknown } | null;
    const expectedCodexHome = env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
    if (!initialized || !sameDirectory(initialized.codexHome, expectedCodexHome)) {
      throw new Error('The Codex App Server did not confirm the installed CLI credential home.');
    }
    return { supervisor, runtimeDir, protocol, dispose };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

export interface LocalCodexAppServerTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  onNotification(listener: (notification: { method: string; params: unknown }) => void): void;
  onServerRequest(listener: (request: IncomingServerRequest) => void): void;
  onExit(listener: (reason?: SupervisorTerminationReason | null) => void): void;
  interrupt(): void;
}

export interface LocalCodexAppServerTurnResult {
  ok: boolean;
  text: string;
  threadId: string;
  turnId: string | null;
  error?: string;
  failure?: NativeTurnFailure;
  completedTool?: true;
}

export const FRESH_MOLECULAR_AUTHOR_CONFIG = {
  project_doc_max_bytes: 0,
  project_doc_fallback_filenames: [],
  web_search: 'disabled',
  features: {
    shell_tool: false,
    unified_exec: false,
    view_image: false,
    code_mode: false,
    code_mode_host: true,
    multi_agent: false,
    multi_agent_v2: false,
    request_permissions_tool: false,
    artifact: false,
    apps: false,
    enable_mcp_apps: false,
    hooks: false,
    memories: false,
    external_agent_memory_import: false,
    plugins: false,
    recommended_plugins: false,
    remote_plugin: false,
    plugin_sharing: false,
    computer_use: false,
    browser_use: false,
    in_app_browser: false,
    skill_mcp_dependency_install: false,
    skill_search: false,
    skip_host_skill_discovery: true,
  },
} as const;

export async function freshMolecularAuthorConfig(
  transport: Pick<LocalCodexAppServerTransport, 'request'>,
  cwd: string,
  supplied: NonNullable<CodexAppServerProtocol.v2.ThreadStartParams['config']>
): Promise<NonNullable<CodexAppServerProtocol.v2.ThreadStartParams['config']>> {
  const suppliedServers = supplied.mcp_servers;
  const dnaforge =
    suppliedServers && typeof suppliedServers === 'object' && !Array.isArray(suppliedServers)
      ? suppliedServers.dnaforge
      : undefined;
  if (!dnaforge || typeof dnaforge !== 'object' || Array.isArray(dnaforge))
    throw new Error('Fresh protein authors require the scoped DNAForge MCP server.');
  const resolved = record(await transport.request('config/read', { cwd, includeLayers: false }));
  const config = record(resolved?.config);
  if (!config) throw new Error('Codex did not provide its resolved configuration.');
  for (const key of [
    'model_instructions_file',
    'experimental_compact_prompt_file',
    'compact_prompt',
    'instructions',
  ])
    if (config[key])
      throw new Error(
        'Fresh protein authors cannot load external instruction or compaction files.'
      );
  const inheritedServers = record(config.mcp_servers) ?? {};
  return {
    ...supplied,
    ...FRESH_MOLECULAR_AUTHOR_CONFIG,
    project_doc_fallback_filenames: [
      ...FRESH_MOLECULAR_AUTHOR_CONFIG.project_doc_fallback_filenames,
    ],
    features: { ...record(supplied.features), ...FRESH_MOLECULAR_AUTHOR_CONFIG.features },
    mcp_servers: {
      ...Object.fromEntries(
        Object.keys(inheritedServers)
          .filter((name) => name !== 'dnaforge')
          .map((name) => [name, { enabled: false }])
      ),
      dnaforge,
    },
    skills: { config: [] },
  };
}

interface TerminalResult {
  ok: boolean;
  failure?: NativeTurnFailure;
  error?: string;
}

function appServerExitMessage(reason?: SupervisorTerminationReason | null): string {
  if (!reason || reason === 'child_exit') return 'The Codex App Server exited.';
  const explanations: Record<Exclude<SupervisorTerminationReason, 'child_exit'>, string> = {
    shutdown: 'it was shut down',
    interrupted: 'a stop was requested',
    malformed_frame: 'it sent an invalid JSON message',
    oversized_frame: 'a response exceeded the transport message-size limit',
    forbidden_server_method: 'it attempted a forbidden server request',
    unknown_server_method: 'it sent an unrecognized server request',
    request_timeout: 'a response timed out',
  };
  return `DNAForge stopped the Codex App Server because ${explanations[reason]} (${reason}).`;
}

function nestedId(value: unknown, key: 'thread' | 'turn'): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return null;
  const id = (nested as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failedTurn(error: unknown): TerminalResult {
  const message = record(error)?.message;
  return {
    ok: false,
    error: typeof message === 'string' ? message : 'The Codex turn failed.',
    failure: codexTurnError(error),
  };
}

function itemAgentText(params: unknown): string | null {
  const item = record(record(params)?.item);
  return item?.type === 'agentMessage' && typeof item.text === 'string' ? item.text : null;
}

const CODEX_ITEM_TYPES: Readonly<Record<string, string>> = {
  agentMessage: 'agent_message',
  commandExecution: 'command_execution',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  webSearch: 'web_search',
  plan: 'todo_list',
};

function sdkItem(value: unknown): unknown {
  const item = record(value);
  if (!item) return value;
  return {
    ...item,
    type: typeof item.type === 'string' ? (CODEX_ITEM_TYPES[item.type] ?? item.type) : item.type,
    status: item.status === 'inProgress' ? 'in_progress' : item.status,
  };
}

function codexPlanText(params: Record<string, unknown> | null): string {
  const explanation = typeof params?.explanation === 'string' ? params.explanation.trim() : '';
  const steps = Array.isArray(params?.plan)
    ? params.plan.flatMap((candidate) => {
        const step = record(candidate);
        if (!step || typeof step.step !== 'string') return [];
        const marker = step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '○';
        return [`${marker} ${step.step}`];
      })
    : [];
  return [explanation, ...steps].filter(Boolean).join('\n');
}

export function appServerNotificationAsCodexSdkEvent(notification: {
  method: string;
  params: unknown;
}): unknown {
  const params = record(notification.params);
  if (notification.method === 'item/started' || notification.method === 'item/completed') {
    return {
      type: notification.method.replace('/', '.'),
      item: sdkItem(params?.item),
      appServer: notification,
    };
  }
  if (notification.method === 'turn/plan/updated') {
    return {
      type: 'item.updated',
      item: {
        id: typeof params?.turnId === 'string' ? `plan:${params.turnId}` : 'turn-plan',
        type: 'todo_list',
        text: codexPlanText(params),
        items: params?.plan,
      },
      appServer: notification,
    };
  }
  if (notification.method === 'item/plan/delta') {
    return {
      type: 'item.updated',
      item: {
        id: typeof params?.itemId === 'string' ? params.itemId : 'turn-plan',
        type: 'todo_list',
        text: typeof params?.delta === 'string' ? params.delta : '',
      },
      appServer: notification,
    };
  }
  if (notification.method === 'turn/completed') {
    const turn = record(params?.turn);
    return {
      type: turn?.status === 'failed' ? 'turn.failed' : 'turn.completed',
      ...(turn?.error ? { error: turn.error } : {}),
      appServer: notification,
    };
  }
  if (notification.method === 'turn/started') {
    return { type: 'turn.started', appServer: notification };
  }
  if (notification.method === 'error') {
    return { type: 'error', error: params?.error, appServer: notification };
  }
  return { type: notification.method.replaceAll('/', '.'), appServer: notification };
}

function inputParams(value: unknown): CodexAppServerProtocol.v2.ToolRequestUserInputParams {
  const params = record(value);
  if (!params || !Array.isArray(params.questions)) {
    throw new Error('Codex sent malformed request_user_input parameters.');
  }
  return value as CodexAppServerProtocol.v2.ToolRequestUserInputParams;
}

async function waitForThreadMcpTools(options: {
  transport: LocalCodexAppServerTransport;
  threadId: string;
  signal: AbortSignal;
  requiredTools: readonly string[];
  startupFailure: () => string | null;
}): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    options.signal.throwIfAborted();
    const failure = options.startupFailure();
    if (failure) throw new Error(failure);
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      options.signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const inventory = await Promise.race([
        options.transport.request('mcpServerStatus/list', {
          threadId: options.threadId,
          cursor,
          detail: 'toolsAndAuthOnly',
          limit: 100,
        } satisfies CodexAppServerProtocol.v2.ListMcpServerStatusParams),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('DNAForge tools did not become ready in the agent runtime.')),
            Math.max(1, deadline - Date.now())
          );
          abort = () => reject(new Error('Stop requested.'));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (abort) options.signal.removeEventListener('abort', abort);
      });
      options.signal.throwIfAborted();
      const currentFailure = options.startupFailure();
      if (currentFailure) throw new Error(currentFailure);
      const response = record(inventory);
      if (!Array.isArray(response?.data))
        throw new Error('The agent runtime returned an invalid DNAForge tool inventory.');
      const server = response.data
        .map(record)
        .find((item) => item?.name === DNAFORGE_MCP_SERVER_NAME);
      const tools = record(server?.tools);
      const names = new Set(
        Object.values(tools ?? {}).flatMap((tool) => {
          const name = record(tool)?.name;
          return typeof name === 'string' ? [name] : [];
        })
      );
      if (names.size && options.requiredTools.every((name) => names.has(name))) return;
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
      if (!cursor) break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('DNAForge tools did not become ready in the agent runtime.');
}

type ThreadConfig = NonNullable<CodexAppServerProtocol.v2.ThreadStartParams['config']>;

function threadPermissionParams(
  config: ThreadConfig,
  permissions: ResolvedAgentPermissions | undefined,
  molecularTrialAuthor: true | undefined
): {
  config: ThreadConfig;
  approvalPolicy?: CodexAppServerProtocol.v2.AskForApproval;
  approvalsReviewer?: CodexAppServerProtocol.v2.ApprovalsReviewer;
  sandbox?: CodexAppServerProtocol.v2.SandboxMode;
} {
  if (molecularTrialAuthor) return { config, approvalPolicy: 'never', sandbox: 'read-only' };
  if (!permissions) return { config, approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  return {
    config: { ...config, default_permissions: codexProfile(permissions.codex) },
    ...(permissions.codexApproval
      ? { approvalPolicy: permissions.codexApproval as CodexAppServerProtocol.v2.AskForApproval }
      : {}),
    ...(permissions.codexReviewer
      ? {
          approvalsReviewer:
            permissions.codexReviewer as CodexAppServerProtocol.v2.ApprovalsReviewer,
        }
      : {}),
  };
}

function turnSandboxPolicy(options: {
  cwd: string;
  writableRoots?: readonly string[];
  permissions?: ResolvedAgentPermissions;
  molecularTrialAuthor?: true;
}): NonNullable<CodexAppServerProtocol.v2.TurnStartParams['sandboxPolicy']> | null {
  if (options.molecularTrialAuthor) return null;
  if (options.permissions && codexProfile(options.permissions.codex) !== ':workspace') return null;
  if (!options.writableRoots?.length) return null;
  return {
    type: 'workspaceWrite',
    writableRoots: [...new Set([options.cwd, ...options.writableRoots])],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export async function runLocalCodexAppServerTurn(options: {
  transport: LocalCodexAppServerTransport;
  message: string;
  cwd: string;
  writableRoots?: readonly string[];
  permissions?: ResolvedAgentPermissions;
  approvalMemory?: ApprovalMemory | null;
  approvalRoots?: readonly ApprovalRoot[];
  conversationId: string | null;
  providerConversationId?: string;
  model?: string;
  effort?: Exclude<CodexAppServerProtocol.ReasoningEffort, { [key: string]: unknown }> | null;
  serviceTier?: string | null;
  personality?: CodexAppServerProtocol.Personality | null;
  config: NonNullable<CodexAppServerProtocol.v2.ThreadStartParams['config']>;
  requiredMcpTools?: readonly string[];
  molecularTrialAuthor?: true;
  developerInstructions: string;
  requestUserInput: RequestAgentUserInput;
  signal: AbortSignal;
  onNotification?: (notification: { method: string; params: unknown }) => void;
}): Promise<LocalCodexAppServerTurnResult> {
  if (options.molecularTrialAuthor && options.providerConversationId)
    throw new Error('Fresh protein authors cannot resume a previous Codex thread.');
  let threadId = options.providerConversationId ?? null;
  let turnId: string | null = null;
  let deltaText = '';
  let completedText: string | null = null;
  let completedTool = false;
  let settle: ((result: TerminalResult) => void) | null = null;
  const terminal = new Promise<TerminalResult>((resolve) => {
    settle = resolve;
  });
  const finish = (result: TerminalResult): void => {
    const resolve = settle;
    settle = null;
    resolve?.(result);
  };
  const pendingRequests = new Set<Promise<void>>();
  let mcpStartupFailure: string | null = null;

  options.transport.onNotification((notification) => {
    options.onNotification?.(notification);
    const params = record(notification.params);
    if (
      notification.method === 'mcpServer/startupStatus/updated' &&
      threadId !== null &&
      params?.threadId === threadId &&
      params?.name === DNAFORGE_MCP_SERVER_NAME &&
      (params.status === 'failed' || params.status === 'cancelled')
    )
      mcpStartupFailure = 'The DNAForge tool companion failed to start in the agent runtime.';
    const notifiedTurnId = nestedId(notification.params, 'turn');
    if (notifiedTurnId) turnId = notifiedTurnId;
    if (notification.method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
      deltaText += params.delta;
      return;
    }
    if (notification.method === 'item/completed') {
      completedTool ||= codexCompletedTool(sdkItem(params?.item));
      completedText = itemAgentText(notification.params) ?? completedText;
      return;
    }
    if (notification.method === 'error' && params?.willRetry !== true) {
      finish(failedTurn(params?.error));
      return;
    }
    if (notification.method !== 'turn/completed') return;
    const turn = record(params?.turn);
    if (turn?.status === 'completed') finish({ ok: true });
    else if (turn?.status === 'interrupted')
      finish({
        ok: false,
        error: 'Stop requested.',
        failure: { reason: 'provider_cancelled', stage: 'provider_stream' },
      });
    else finish(failedTurn(turn?.error));
  });

  options.transport.onServerRequest((request) => {
    const work = (async () => {
      try {
        if (options.signal.aborted) {
          request.refuse('The turn was stopped.');
          return;
        }
        if (request.method === 'item/tool/requestUserInput') {
          request.respond(
            await answerCodexRequestUserInput({
              params: inputParams(request.params),
              conversationId: options.conversationId,
              signal: options.signal,
              requestUserInput: options.requestUserInput,
            })
          );
          return;
        }
        if (request.method === 'mcpServer/elicitation/request') {
          request.respond(
            await answerCodexMcpElicitation({
              params: request.params as CodexAppServerProtocol.v2.McpServerElicitationRequestParams,
              conversationId: options.conversationId,
              signal: options.signal,
              requestUserInput: options.requestUserInput,
            })
          );
          return;
        }
        if (
          request.method === 'item/commandExecution/requestApproval' ||
          request.method === 'item/fileChange/requestApproval' ||
          request.method === 'item/permissions/requestApproval'
        ) {
          if (options.molecularTrialAuthor) {
            request.refuse('Fresh protein authors cannot request native host permissions.');
            return;
          }
          const response = await answerCodexServerApproval({
            method: request.method,
            params: request.params as Parameters<typeof answerCodexServerApproval>[0]['params'],
            conversationId: options.conversationId,
            signal: options.signal,
            requestUserInput: options.requestUserInput,
            approvalMemory: options.approvalMemory ?? null,
            approvalRoots: options.approvalRoots ?? [],
          });
          if (response === null) request.refuse('The user denied the requested permissions.');
          else request.respond(response);
          return;
        }
        request.refuse(`DNAForge does not handle ${request.method}.`);
      } catch (cause) {
        request.refuse(cause instanceof Error ? cause.message : 'The interaction failed.');
      }
    })();
    pendingRequests.add(work);
    void work.finally(() => pendingRequests.delete(work));
  });
  options.transport.onExit((reason) => {
    const stage = turnId ? 'provider_stream' : 'provider_start';
    const failure: NativeTurnFailure = {
      reason:
        reason === 'child_exit'
          ? 'process_exit'
          : reason === 'request_timeout'
            ? 'provider_timeout'
            : 'unknown',
      stage,
    };
    finish({ ok: false, error: appServerExitMessage(reason), failure });
  });

  const abort = (): void => options.transport.interrupt();
  if (options.signal.aborted) abort();
  else options.signal.addEventListener('abort', abort, { once: true });

  try {
    const config = options.molecularTrialAuthor
      ? await freshMolecularAuthorConfig(options.transport, options.cwd, options.config)
      : options.config;
    const threadParams = {
      cwd: options.cwd,
      ...threadPermissionParams(config, options.permissions, options.molecularTrialAuthor),
      developerInstructions: options.developerInstructions,
      ...(options.model ? { model: options.model } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(options.personality ? { personality: options.personality } : {}),
    };
    if (threadId) {
      const resumed = await options.transport.request('thread/resume', {
        threadId,
        ...threadParams,
      } satisfies CodexAppServerProtocol.v2.ThreadResumeParams);
      threadId = nestedId(resumed, 'thread') ?? threadId;
    } else {
      const started = await options.transport.request('thread/start', {
        ...threadParams,
        ephemeral: options.molecularTrialAuthor === true,
        ...(options.molecularTrialAuthor ? { environments: [] } : {}),
      } satisfies CodexAppServerProtocol.v2.ThreadStartParams);
      if (options.molecularTrialAuthor) {
        const environments = record(record(started)?.thread)?.environments;
        if (!Array.isArray(environments) || environments.length !== 0)
          throw new Error('Codex did not confirm an environment-free protein author thread.');
      }
      threadId = nestedId(started, 'thread');
    }
    if (!threadId) throw new Error('The Codex App Server did not return a thread id.');

    const dnaforgeServer = record(record(options.config.mcp_servers)?.[DNAFORGE_MCP_SERVER_NAME]);
    if (dnaforgeServer && dnaforgeServer.enabled !== false)
      await waitForThreadMcpTools({
        transport: options.transport,
        threadId,
        signal: options.signal,
        requiredTools: options.requiredMcpTools ?? [],
        startupFailure: () => mcpStartupFailure,
      });
    if (options.molecularTrialAuthor) {
      let cursor: string | null = null;
      let dnaforgeFound = false;
      do {
        const page = record(
          await options.transport.request('mcpServerStatus/list', { threadId, cursor, limit: 100 })
        );
        if (!page || !Array.isArray(page.data))
          throw new Error('Codex did not provide its thread MCP catalog.');
        for (const candidate of page.data) {
          const server = record(candidate);
          const tools = record(server?.tools);
          const resources = server?.resources;
          const templates = server?.resourceTemplates;
          if (!tools || !Array.isArray(resources) || !Array.isArray(templates))
            throw new Error('Codex did not provide its complete thread MCP inventory.');
          if (server?.name === 'dnaforge') {
            dnaforgeFound = Object.keys(tools).length > 0;
          } else if (Object.keys(tools).length || resources.length || templates.length) {
            throw new Error('Fresh protein authors refuse inherited MCP tools and resources.');
          }
        }
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null;
      } while (cursor);
      if (!dnaforgeFound) throw new Error('The scoped DNAForge MCP server is unavailable.');
    }

    const sandboxPolicy = turnSandboxPolicy(options);
    const started = await options.transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: options.message, text_elements: [] }],
      ...(options.molecularTrialAuthor ? { environments: [] } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    } satisfies CodexAppServerProtocol.v2.TurnStartParams);
    turnId = nestedId(started, 'turn') ?? turnId;
    const outcome = await terminal;
    await Promise.allSettled([...pendingRequests]);
    return {
      ok: outcome.ok,
      text: (completedText ?? deltaText).trim(),
      threadId,
      turnId,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      ...(completedTool ? { completedTool: true } : {}),
    };
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
}
