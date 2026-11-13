import { publicAgentTraceDisplay } from '../../shared/agent-trace-display';
import type { AgentTraceDisplayShape } from '../../shared/agent-runtime-ipc';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServerStdio,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
} from '@agentclientprotocol/sdk';

import type {
  AgentCliModelCapabilityShape,
  AgentCliModelReasoningEffort as CliModelReasoningEffort,
  AgentCliPermissionMode as CliPermissionMode,
} from '../../shared/agent-runtime-ipc';
import type { ProviderTraceEvent, ProviderTraceVersionStamp } from './trace-adapter';
import { redactProviderSecrets } from './trace-adapter';
import { grokCliEnv, resolveAmbientGrokAuthPath } from './subprocess-env';
import { nodeAwareSpawn } from './cli-layout';
import { mapGrokAcpModelCatalog } from './model-catalog';
import {
  answerGrokElicitation,
  answerGrokPermissionRequest,
  type RequestAgentUserInput,
} from './agent-user-input-adapters';
import {
  answerGrokDnaForgeMcpPermission,
  answerGrokMcpUserInputPermission,
  createGrokUserInputHandoff,
  discardGrokUserInputHandoff,
  resolveGrokToolIdentity,
  grokCanonicalToolInput,
  type GrokToolIdentity,
  type GrokUserInputHandoff,
} from './grok-user-input-bridge';
import type { ApprovalMemory } from './approval-memory';
import type { ApprovalRoot } from './approval-rules';
import type { AgentProcessConfinement } from './agent-process-confinement';

const STDERR_LIMIT = 16_000;

export interface GrokAcpRpc {
  initialize(): Promise<InitializeResponse>;
  newSession(request: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse | void>;
  setMode(request: SetSessionModeRequest): Promise<void>;
  setConfigOption(request: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
  prompt(request: PromptRequest): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  close(): void;
}

export interface GrokAcpLaunchInput {
  binaryPath: string;
  cwd: string;
  permissionMode: CliPermissionMode;
  grokMode?: string;
  model?: string;
  reasoningEffort?: CliModelReasoningEffort;
  systemPrompt: string;
  mcpUserInputBridge?: boolean;
  runtimeRoot: string;
  pluginDirectories?: readonly string[];
  selectedSkills?: readonly { nativeId: string; sourcePath: string }[];
  processConfinement?: AgentProcessConfinement;
}

export interface GrokRuntimeIsolation {
  processHome: string;
  grokHome: string;
  authPath: string;
  config: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildGrokRuntimeIsolation(input: {
  runtimeRoot: string;
  userHome: string;
  ambientGrokHome?: string;
  ambientAuthPath?: string;
}): GrokRuntimeIsolation {
  const processHome = join(input.runtimeRoot, 'home');
  const grokHome = join(processHome, '.grok');
  return {
    processHome,
    grokHome,
    authPath: resolveAmbientGrokAuthPath(input),
    config: ['[shell_environment_policy.set]', `HOME = ${tomlString(input.userHome)}`, ''].join(
      '\n'
    ),
  };
}

const GROK_COMPATIBILITY_ISOLATION_ENV = {
  GROK_CLAUDE_AGENTS_ENABLED: 'false',
  GROK_CLAUDE_HOOKS_ENABLED: 'false',
  GROK_CLAUDE_MCPS_ENABLED: 'false',
  GROK_CLAUDE_RULES_ENABLED: 'false',
  GROK_CLAUDE_SKILLS_ENABLED: 'false',
  GROK_CURSOR_AGENTS_ENABLED: 'false',
  GROK_CURSOR_HOOKS_ENABLED: 'false',
  GROK_CURSOR_MCPS_ENABLED: 'false',
  GROK_CURSOR_RULES_ENABLED: 'false',
  GROK_CURSOR_SKILLS_ENABLED: 'false',
} as const;

export function buildGrokAcpEnvironment(
  isolation: GrokRuntimeIsolation,
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return {
    ...grokCliEnv(base),
    HOME: isolation.processHome,
    GROK_HOME: isolation.grokHome,
    GROK_AUTH_PATH: isolation.authPath,
    ...GROK_COMPATIBILITY_ISOLATION_ENV,
  };
}

function prepareGrokRuntimeIsolation(input: GrokAcpLaunchInput): GrokRuntimeIsolation {
  const isolation = buildGrokRuntimeIsolation({
    runtimeRoot: input.runtimeRoot,
    userHome: process.env.HOME?.trim() || process.cwd(),
    ...(process.env.GROK_HOME ? { ambientGrokHome: process.env.GROK_HOME } : {}),
    ...(process.env.GROK_AUTH_PATH ? { ambientAuthPath: process.env.GROK_AUTH_PATH } : {}),
  });
  mkdirSync(isolation.grokHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(isolation.grokHome, '.config-init.lock'), '', {
    flag: 'a',
    mode: 0o600,
  });
  const configPath = join(isolation.grokHome, 'requirements.toml');
  let current = '';
  try {
    current = readFileSync(configPath, 'utf8');
  } catch {}
  if (current !== isolation.config) {
    const temporary = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, isolation.config, { mode: 0o600 });
    renameSync(temporary, configPath);
  }
  return isolation;
}

export function buildGrokAcpLaunch(input: GrokAcpLaunchInput): {
  command: string;
  args: string[];
} {
  const pluginDirectories = input.pluginDirectories ?? [];
  if (pluginDirectories.some((path) => !isAbsolute(path))) {
    throw new Error('Grok plugin directories must be absolute paths.');
  }
  const args = [
    '--no-auto-update',
    '--cwd',
    input.cwd,
    '--permission-mode',
    desiredMode(input.permissionMode, input.grokMode),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.reasoningEffort && input.reasoningEffort !== 'max'
      ? ['--reasoning-effort', input.reasoningEffort]
      : []),
    '--rules',
    input.mcpUserInputBridge
      ? `${input.systemPrompt}\n\nIn DNAForge ACP sessions, the only available structured user-choice primitive is the MCP tool whose fully qualified name is dnaforge__request_user_input (ACP trace name mcp__dnaforge__request_user_input). Call that exact MCP tool. Never call or retry the built-in ask_user_question tool because it is unavailable in ACP. Wait for the MCP elicitation result, then continue the same turn.`
      : input.systemPrompt,
    ...(input.mcpUserInputBridge ? ['--disallowed-tools', 'ask_user_question'] : []),
    ...(input.mcpUserInputBridge ? ['--allow', 'MCPTool(dnaforge__request_user_input)'] : []),
    'agent',
    ...pluginDirectories.flatMap((path) => ['--plugin-dir', path]),
    'stdio',
  ];
  return { command: input.binaryPath, args };
}

function prepareSelectedSkillPlugin(
  isolation: GrokRuntimeIsolation,
  selectedSkill: NonNullable<GrokAcpLaunchInput['selectedSkills']>[number]
): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(selectedSkill.nativeId) ||
    !isAbsolute(selectedSkill.sourcePath) ||
    !selectedSkill.sourcePath.endsWith('SKILL.md')
  ) {
    throw new Error('The selected Grok skill has an invalid provider identity.');
  }
  const pluginRoot = mkdtempSync(join(isolation.grokHome, 'dnaforge-selected-skill-'));
  const qualifiedParts = selectedSkill.nativeId.split(':');
  const skillName = qualifiedParts.at(-1);
  if (!skillName) {
    throw new Error('The selected Grok skill has an invalid provider identity.');
  }
  const providerPrefix = qualifiedParts[0];
  const pluginName =
    qualifiedParts.length > 1 && providerPrefix ? providerPrefix : `dnaforge-selected-${skillName}`;
  const manifestDirectory = join(pluginRoot, '.claude-plugin');
  mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(manifestDirectory, 'plugin.json'),
    `${JSON.stringify({
      name: pluginName,
      version: '1.0.0',
      description: `Turn-scoped DNAForge wrapper for ${skillName}.`,
    })}\n`,
    { mode: 0o600 }
  );
  const target = join(pluginRoot, 'skills', skillName);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(dirname(selectedSkill.sourcePath), target, { recursive: true, force: true });
  return pluginRoot;
}

export interface OpenGrokAcpClientInput extends GrokAcpLaunchInput {
  conversationId: string | null;
  signal: AbortSignal;
  requestUserInput: RequestAgentUserInput;
  approvalMemory?: ApprovalMemory | null;
  approvalRoots?: readonly ApprovalRoot[];
  onUpdate?: (notification: SessionNotification) => void;
}

export interface OpenGrokAcpClientResult {
  rpc: GrokAcpRpc;
  processExited: Promise<void>;
  mcpUserInputHandoff?: GrokUserInputHandoff;
  registerUpdateSink(sink: (notification: SessionNotification) => void): void;
  stderr(): string;
}

export class GrokUpdateBarrier {
  private pending = 0;
  private failure: Error | null = null;
  private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void }>();

  markSeen(): void {
    if (!this.failure) this.pending += 1;
  }

  markHandled(): void {
    if (this.pending > 0) this.pending -= 1;
    if (this.pending !== 0 || this.failure) return;
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  drain(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.waiters.add({ resolve, reject });
    });
  }
}

function isGrokSessionUpdateWireMessage(message: acp.AnyMessage): boolean {
  return (
    'method' in message &&
    !('id' in message) &&
    message.method === acp.methods.client.session.update
  );
}

export function openGrokAcpClient(input: OpenGrokAcpClientInput): OpenGrokAcpClientResult {
  const isolation = prepareGrokRuntimeIsolation(input);
  const selectedSkillPlugins: string[] = [];
  try {
    for (const selectedSkill of input.selectedSkills ?? []) {
      selectedSkillPlugins.push(prepareSelectedSkillPlugin(isolation, selectedSkill));
    }
  } catch (cause) {
    for (const selectedSkillPlugin of selectedSkillPlugins) {
      rmSync(selectedSkillPlugin, { recursive: true, force: true });
    }
    throw cause;
  }
  const launch = buildGrokAcpLaunch({
    ...input,
    pluginDirectories: [...(input.pluginDirectories ?? []), ...selectedSkillPlugins],
  });
  const spawnable = nodeAwareSpawn(launch.command, launch.args, buildGrokAcpEnvironment(isolation));
  const invocation = input.processConfinement
    ? input.processConfinement.wrap(spawnable.file, spawnable.args, spawnable.env)
    : { command: spawnable.file, args: spawnable.args, env: spawnable.env };
  const mcpUserInputHandoff = input.mcpUserInputBridge
    ? createGrokUserInputHandoff(input.runtimeRoot)
    : undefined;
  const child: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env: invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const processExited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  let stderr = '';
  let updateSink = input.onUpdate;
  const observedToolCalls = new Map<string, GrokToolIdentity>();
  const updateBarrier = new GrokUpdateBarrier();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT);
  });

  const app = acp
    .client({ name: 'dnaforge-desktop' })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      const bridgeResponse = mcpUserInputHandoff
        ? await answerGrokMcpUserInputPermission({
            params,
            observedToolCalls,
            handoff: mcpUserInputHandoff,
            conversationId: input.conversationId,
            signal: input.signal,
            requestUserInput: input.requestUserInput,
          })
        : null;
      return (
        bridgeResponse ??
        answerGrokDnaForgeMcpPermission({ params, observedToolCalls }) ??
        answerGrokPermissionRequest({
          params,
          conversationId: input.conversationId,
          signal: input.signal,
          requestUserInput: input.requestUserInput,
          approvalMemory: input.approvalMemory ?? null,
          approvalRoots: input.approvalRoots ?? [],
        })
      );
    })
    .onRequest(acp.methods.client.elicitation.create, ({ params }) =>
      answerGrokElicitation({
        params,
        conversationId: input.conversationId,
        signal: input.signal,
        requestUserInput: input.requestUserInput,
      })
    )
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      try {
        const update = params.update;
        if (
          (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
          (update.name || update.rawInput)
        ) {
          const identity = resolveGrokToolIdentity(
            update,
            observedToolCalls.get(update.toolCallId)
          );
          if (identity) observedToolCalls.set(update.toolCallId, identity);
        }
        updateSink?.(params);
      } finally {
        updateBarrier.markHandled();
      }
    });
  const baseStream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  );
  const stream: acp.Stream = {
    writable: baseStream.writable,
    readable: baseStream.readable.pipeThrough(
      new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        transform(message, controller) {
          if (isGrokSessionUpdateWireMessage(message)) updateBarrier.markSeen();
          controller.enqueue(message);
        },
      })
    ),
  };
  const connection = app.connect(stream);
  let selectedSkillPluginCleaned = false;
  const cleanupSelectedSkillPlugin = (): void => {
    if (selectedSkillPluginCleaned) return;
    selectedSkillPluginCleaned = true;
    for (const selectedSkillPlugin of selectedSkillPlugins) {
      rmSync(selectedSkillPlugin, { recursive: true, force: true });
    }
  };
  void connection.closed.then(() =>
    updateBarrier.fail(new Error('Grok ACP closed before all session updates were handled.'))
  );
  child.once('error', (error) => {
    cleanupSelectedSkillPlugin();
    connection.close(error);
  });
  child.once('exit', (code, signal) => {
    cleanupSelectedSkillPlugin();
    if (!connection.signal.aborted && code !== 0) {
      connection.close(
        new Error(`Grok ACP process exited with ${signal ? `signal ${signal}` : `code ${code}`}.`)
      );
    }
  });

  let disposed = false;
  const close = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      if (mcpUserInputHandoff) discardGrokUserInputHandoff(mcpUserInputHandoff);
    } finally {
      connection.close();
      child.kill('SIGTERM');
    }
  };
  const rpc: GrokAcpRpc = {
    async initialize() {
      return connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'DNAForge', version: '0.8.7' },
        clientCapabilities: {
          elicitation: { form: {} },
          plan: {},
        },
      });
    },
    newSession: (request) => connection.agent.request(acp.methods.agent.session.new, request),
    loadSession: (request) => connection.agent.request(acp.methods.agent.session.load, request),
    async setMode(request) {
      await connection.agent.request(acp.methods.agent.session.setMode, request);
    },
    setConfigOption: (request) =>
      connection.agent.request(acp.methods.agent.session.setConfigOption, request),
    async prompt(request) {
      const response = await connection.agent.request(acp.methods.agent.session.prompt, request);
      await updateBarrier.drain();
      return response;
    },
    cancel: (sessionId) => connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }),
    close,
  };
  return {
    rpc,
    processExited,
    ...(mcpUserInputHandoff ? { mcpUserInputHandoff } : {}),
    registerUpdateSink(sink) {
      updateSink = sink;
    },
    stderr: () => stderr.trim(),
  };
}

export async function probeGrokModelCatalog(
  binaryPath: string
): Promise<AgentCliModelCapabilityShape[]> {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'dnaforge-grok-model-catalog-'));
  const controller = new AbortController();
  const client = openGrokAcpClient({
    binaryPath,
    cwd: tmpdir(),
    permissionMode: 'app-supervised',
    systemPrompt: 'Model catalog discovery only.',
    runtimeRoot,
    conversationId: null,
    signal: controller.signal,
    requestUserInput: async () => {
      throw new Error('Grok requested user input during model catalog discovery.');
    },
  });
  try {
    const initialized = await client.rpc.initialize();
    return mapGrokAcpModelCatalog(initialized);
  } finally {
    controller.abort();
    client.rpc.close();
    const cleanupAfterExit = client.processExited.then(() => {
      rmSync(runtimeRoot, { recursive: true, force: true });
    });
    await Promise.race([
      cleanupAfterExit,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
  }
}

function desiredMode(permissionMode: CliPermissionMode, grokMode?: string): string {
  if (permissionMode === 'app-supervised') return 'dontAsk';
  return grokMode ?? 'default';
}

async function configureMode(
  rpc: GrokAcpRpc,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  permissionMode: CliPermissionMode,
  grokMode?: string
): Promise<void> {
  if (!modes) return;
  const modeId = desiredMode(permissionMode, grokMode);
  if (modes.currentModeId === modeId) return;
  if (!modes.availableModes.some((mode) => mode.id === modeId)) {
    throw new Error(`Grok ACP does not expose required permission mode ${modeId}.`);
  }
  await rpc.setMode({ sessionId, modeId });
}

function selectableValues(option: SessionConfigOption): Set<string> {
  if (option.type !== 'select') return new Set();
  const values = option.options.flatMap((entry) =>
    'group' in entry ? entry.options.map((nested) => nested.value) : [entry.value]
  );
  return new Set(values);
}

async function configureOption(
  rpc: GrokAcpRpc,
  sessionId: string,
  options: SessionConfigOption[] | null | undefined,
  category: 'model' | 'thought_level',
  requested: string | undefined
): Promise<void> {
  if (!requested) return;
  const option = options?.find((candidate) => candidate.category === category);
  const label = category === 'thought_level' ? 'reasoning effort' : 'model';
  if (!option || option.type !== 'select') {
    throw new Error(`Grok ACP does not expose a selectable ${label}.`);
  }
  if (!selectableValues(option).has(requested)) {
    throw new Error(`Grok ACP does not support ${label} ${requested}.`);
  }
  if (option.currentValue === requested) return;
  await rpc.setConfigOption({ sessionId, configId: option.id, value: requested });
}

export interface RunGrokAcpTurnInput {
  rpc: GrokAcpRpc;
  cwd: string;
  prompt: string;
  mcpServer?: McpServerStdio;
  assertMcpCurrent?: () => void;
  permissionMode: CliPermissionMode;
  grokMode?: string;
  model?: string;
  reasoningEffort?: CliModelReasoningEffort;
  providerConversationId?: string;
  signal: AbortSignal;
  onUpdate?: (notification: SessionNotification) => void;
  registerUpdateSink?: (sink: (notification: SessionNotification) => void) => void;
}

export interface RunGrokAcpTurnResult {
  ok: boolean;
  text: string;
  sessionId: string;
  stopReason: PromptResponse['stopReason'];
}

export async function runGrokAcpTurn(input: RunGrokAcpTurnInput): Promise<RunGrokAcpTurnResult> {
  const initialize = await input.rpc.initialize();
  if (initialize.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error(
      `Grok ACP protocol mismatch: expected ${acp.PROTOCOL_VERSION}, got ${initialize.protocolVersion}.`
    );
  }
  if (input.providerConversationId && initialize.agentCapabilities?.loadSession !== true) {
    throw new Error('This Grok ACP runtime cannot resume an existing conversation.');
  }

  let text = '';
  const updateSink = (notification: SessionNotification): void => {
    if (
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
    ) {
      text += notification.update.content.text;
    }
    input.onUpdate?.(notification);
  };
  input.registerUpdateSink?.(updateSink);

  const sessionRequest = {
    cwd: input.cwd,
    mcpServers: input.mcpServer ? [input.mcpServer] : [],
  };
  let sessionId: string;
  let modes: SessionModeState | null | undefined;
  let configOptions: SessionConfigOption[] | null | undefined;
  input.assertMcpCurrent?.();
  if (input.providerConversationId) {
    sessionId = input.providerConversationId;
    const loaded = await input.rpc.loadSession({ ...sessionRequest, sessionId });
    modes = loaded?.modes;
    configOptions = loaded?.configOptions;
  } else {
    const created = await input.rpc.newSession(sessionRequest);
    sessionId = created.sessionId;
    modes = created.modes;
    configOptions = created.configOptions;
  }

  await configureMode(input.rpc, sessionId, modes, input.permissionMode, input.grokMode);
  await configureOption(input.rpc, sessionId, configOptions, 'model', input.model);
  await configureOption(
    input.rpc,
    sessionId,
    configOptions,
    'thought_level',
    input.reasoningEffort
  );

  const cancel = (): void => {
    void input.rpc.cancel(sessionId).catch(() => undefined);
  };
  if (input.signal.aborted) cancel();
  else input.signal.addEventListener('abort', cancel, { once: true });
  try {
    input.assertMcpCurrent?.();
    const response = await input.rpc.prompt({
      sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });
    return {
      ok: response.stopReason === 'end_turn',
      text: text.trim(),
      sessionId,
      stopReason: response.stopReason,
    };
  } finally {
    input.signal.removeEventListener('abort', cancel);
  }
}

function toolStatus(
  status: string | null | undefined
): 'requested' | 'running' | 'completed' | 'failed' {
  if (status === 'completed' || status === 'failed') return status;
  return status === 'in_progress' ? 'running' : 'requested';
}

function planEntryText(entries: readonly { content: string; status: string }[]): string {
  return entries
    .map((entry) => {
      const marker =
        entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '→' : '○';
      return `${marker} ${entry.content}`;
    })
    .join('\n');
}

function grokPlanText(update: SessionNotification['update']): string | undefined {
  if (update.sessionUpdate === 'plan') return planEntryText(update.entries);
  if (update.sessionUpdate !== 'plan_update') return undefined;
  if (update.plan.type === 'items') return planEntryText(update.plan.entries);
  if (update.plan.type === 'markdown') return update.plan.content;
  if (update.plan.type === 'file') return update.plan.uri;
  return undefined;
}

export function grokSessionUpdateAsTraceEvent(
  notification: SessionNotification,
  sequence: number,
  versions: ProviderTraceVersionStamp
): ProviderTraceEvent {
  const update = notification.update;
  const providerItemId =
    'toolCallId' in update
      ? update.toolCallId
      : 'messageId' in update && update.messageId
        ? update.messageId
        : undefined;
  let display: AgentTraceDisplayShape = {
    kind: 'unknown',
    title: update.sessionUpdate,
    visibility: 'diagnostic',
  };
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    display = { kind: 'assistant_text', title: 'Grok', text: update.content.text };
  } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
    display = { kind: 'reasoning', title: 'Reasoning', text: update.content.text };
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    display = {
      kind: update.kind === 'execute' ? 'command' : update.kind === 'edit' ? 'file_change' : 'tool',
      title: update.title?.trim() || update.name?.trim() || 'Tool call',
      status: update.status ?? undefined,
    };
  } else if (update.sessionUpdate === 'plan' || update.sessionUpdate === 'plan_update') {
    display = {
      kind: 'todo',
      title: 'Plan',
      status: update.sessionUpdate,
      text: grokPlanText(update),
    };
  } else if (update.sessionUpdate === 'current_mode_update') {
    display = { kind: 'lifecycle', title: 'Mode changed', status: update.currentModeId };
  }

  const toolCalls =
    update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
      ? [
          {
            id: update.toolCallId,
            ...(resolveGrokToolIdentity(update) ?? { name: 'tool' }),
            status: toolStatus(update.status),
            ...(update.rawInput !== undefined
              ? { input: redactProviderSecrets(grokCanonicalToolInput(update)) }
              : {}),
            ...(update.rawOutput !== undefined
              ? { output: redactProviderSecrets(update.rawOutput) }
              : {}),
          },
        ]
      : undefined;
  return {
    transport: 'grok-acp',
    sequence,
    receivedAt: new Date().toISOString(),
    providerEventType: 'session/update',
    providerItemType: update.sessionUpdate,
    ...(providerItemId ? { providerItemId } : {}),
    raw: redactProviderSecrets(notification),
    display: publicAgentTraceDisplay(display, toolCalls),
    ...(toolCalls ? { toolCalls } : {}),
    versions,
  };
}

interface GrokTextRun {
  id: string;
  text: string;
}

interface RememberedGrokTool {
  title: string;
  name: string;
  mcpServer?: string;
  kind?: string;
}

export interface GrokSessionTraceProjector {
  project(notification: SessionNotification, sequence: number): ProviderTraceEvent;
}

export function createGrokSessionTraceProjector(
  versions: ProviderTraceVersionStamp
): GrokSessionTraceProjector {
  let messageRunNumber = 0;
  let thoughtRunNumber = 0;
  let messageRun: GrokTextRun | null = null;
  let thoughtRun: GrokTextRun | null = null;
  const tools = new Map<string, RememberedGrokTool>();

  return {
    project(notification, sequence) {
      const update = notification.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        messageRun = continueGrokTextRun(
          messageRun,
          update.messageId,
          'grok-message',
          messageRunNumber
        );
        messageRun.text += update.content.text;
        const event = grokSessionUpdateAsTraceEvent(notification, sequence, versions);
        return {
          ...event,
          providerItemId: messageRun.id,
          display: publicAgentTraceDisplay({ ...event.display, text: messageRun.text }),
        };
      }
      if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
        thoughtRun = continueGrokTextRun(
          thoughtRun,
          update.messageId,
          'grok-thought',
          thoughtRunNumber
        );
        thoughtRun.text += update.content.text;
        const event = grokSessionUpdateAsTraceEvent(notification, sequence, versions);
        return {
          ...event,
          providerItemId: thoughtRun.id,
          display: publicAgentTraceDisplay({ ...event.display, text: thoughtRun.text }),
        };
      }

      if (messageRun) messageRunNumber += 1;
      if (thoughtRun) thoughtRunNumber += 1;
      messageRun = null;
      thoughtRun = null;
      const event = grokSessionUpdateAsTraceEvent(notification, sequence, versions);
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        return withRememberedGrokTool(event, rememberGrokTool(update, tools));
      }
      return event;
    },
  };
}

function continueGrokTextRun(
  current: GrokTextRun | null,
  messageId: string | null | undefined,
  prefix: string,
  runNumber: number
): GrokTextRun {
  const explicitId = messageId?.trim() || null;
  if (explicitId) {
    return current?.id === explicitId ? current : { id: explicitId, text: '' };
  }
  return current ?? { id: `${prefix}-${runNumber}`, text: '' };
}

function rememberGrokTool(
  update: {
    toolCallId: string;
    title?: string | null;
    name?: string | null;
    kind?: string | null;
    rawInput?: unknown;
  },
  tools: Map<string, RememberedGrokTool>
): RememberedGrokTool {
  const prior = tools.get(update.toolCallId);
  const explicitName = update.name?.trim() || '';
  const title = update.title?.trim() || prior?.title || explicitName || prior?.name || 'Tool call';
  let name = prior?.name ?? '';
  let mcpServer = prior?.mcpServer;
  const identity = resolveGrokToolIdentity(update, prior);
  if (identity) {
    name = identity.name;
    mcpServer = identity.mcpServer;
  } else if (!name || name === 'tool') {
    name = title;
  }
  const kind = update.kind?.trim() || prior?.kind;
  const remembered: RememberedGrokTool = {
    title,
    name,
    ...(mcpServer ? { mcpServer } : {}),
    ...(kind ? { kind } : {}),
  };
  tools.set(update.toolCallId, remembered);
  return remembered;
}

function grokToolDisplayKind(
  kind: string | undefined
): ProviderTraceEvent['display']['kind'] | null {
  if (kind === 'execute') return 'command';
  if (kind === 'edit') return 'file_change';
  if (kind) return 'tool';
  return null;
}

function withRememberedGrokTool(
  event: ProviderTraceEvent,
  remembered: RememberedGrokTool
): ProviderTraceEvent {
  const toolCalls = event.toolCalls?.map((call, index) =>
    index === 0
      ? {
          ...call,
          name: remembered.name,
          ...(remembered.mcpServer ? { mcpServer: remembered.mcpServer } : {}),
        }
      : call
  );
  return {
    ...event,
    display: publicAgentTraceDisplay(
      {
        ...event.display,
        kind: grokToolDisplayKind(remembered.kind) ?? event.display.kind,
        title: remembered.title,
      },
      toolCalls
    ),
    ...(toolCalls ? { toolCalls } : {}),
  };
}
