import type { AgentTransport } from '../../platform';

export type AgentInteractionSupport = 'native' | 'dnaforge' | 'not-advertised';
export type AgentInteractionCoverage = 'full' | 'partial' | 'none' | 'not-applicable';

export interface AgentInteractionException {
  readonly owner: string;
  readonly userVisibleReason: string;
  readonly removalCondition: string;
}

export interface AgentInteractionEvidence {
  readonly source:
    | 'claude-runtime'
    | 'claude-cli-help'
    | 'claude-sdk-types'
    | 'codex-app-server-schema'
    | 'codex-sdk-types'
    | 'dnaforge-runtime'
    | 'grok-cli-help'
    | 'grok-acp-schema'
    | 'grok-acp-runtime-meta';
  readonly token: string;
}

export interface AgentInteractionCell {
  readonly agentSupport: AgentInteractionSupport;
  readonly bridge: AgentInteractionCoverage;
  readonly ui: AgentInteractionCoverage;
  readonly evidence: AgentInteractionEvidence;
  readonly userLoss: string;
  readonly exception?: AgentInteractionException;
}

interface AgentInteractionModeDefinition {
  readonly id: string;
  readonly label: string;
  readonly evidence: Readonly<Record<AgentTransport, AgentInteractionEvidence>>;
}

const evidence = (
  claude: AgentInteractionEvidence,
  codex: AgentInteractionEvidence,
  grok: AgentInteractionEvidence
): Readonly<Record<AgentTransport, AgentInteractionEvidence>> => ({
  'claude-agent-sdk': claude,
  'codex-sdk': codex,
  'grok-acp': grok,
});

const claudeTool = (token: string): AgentInteractionEvidence => ({
  source: 'claude-runtime',
  token,
});
const claudeHelp = (token: string): AgentInteractionEvidence => ({
  source: 'claude-cli-help',
  token,
});
const claudeSdk = (token: string): AgentInteractionEvidence => ({
  source: 'claude-sdk-types',
  token,
});
const codexMethod = (token: string): AgentInteractionEvidence => ({
  source: 'codex-app-server-schema',
  token,
});
const codexSdk = (token: string): AgentInteractionEvidence => ({
  source: 'codex-sdk-types',
  token,
});
const grokHelp = (token: string): AgentInteractionEvidence => ({
  source: 'grok-cli-help',
  token,
});
const grokAcp = (token: string): AgentInteractionEvidence => ({
  source: 'grok-acp-schema',
  token,
});
const grokAcpRuntime = (token: string): AgentInteractionEvidence => ({
  source: 'grok-acp-runtime-meta',
  token,
});
const dnaforgeRuntime = (token: string): AgentInteractionEvidence => ({
  source: 'dnaforge-runtime',
  token,
});

export const AGENT_INTERACTION_MODES = [
  {
    id: 'question.single',
    label: 'Question: choose one',
    evidence: evidence(
      claudeTool('AskUserQuestion'),
      codexMethod('item/tool/requestUserInput'),
      grokAcp('session/request_permission')
    ),
  },
  {
    id: 'question.multi',
    label: 'Question: choose several',
    evidence: evidence(
      claudeTool('AskUserQuestion'),
      codexMethod('item/tool/requestUserInput'),
      grokAcp('elicitation/create')
    ),
  },
  {
    id: 'question.free_text',
    label: 'Question: free text',
    evidence: evidence(
      claudeTool('AskUserQuestion'),
      codexMethod('item/tool/requestUserInput'),
      grokAcp('elicitation/create')
    ),
  },
  {
    id: 'question.default',
    label: 'Question: default answer',
    evidence: evidence(
      claudeTool('AskUserQuestion'),
      codexMethod('item/tool/requestUserInput'),
      grokAcp('elicitation/create')
    ),
  },
  {
    id: 'question.cancel',
    label: 'Question: cancel',
    evidence: evidence(
      claudeTool('AskUserQuestion'),
      codexMethod('item/tool/requestUserInput'),
      grokAcp('session/cancel')
    ),
  },
  {
    id: 'approval.tool',
    label: 'Approval: tool',
    evidence: evidence(
      claudeSdk('canUseTool'),
      codexMethod('item/permissions/requestApproval'),
      grokAcp('session/request_permission')
    ),
  },
  {
    id: 'approval.command',
    label: 'Approval: command',
    evidence: evidence(
      claudeTool('Bash'),
      codexMethod('item/commandExecution/requestApproval'),
      grokAcp('session/request_permission')
    ),
  },
  {
    id: 'approval.file_change',
    label: 'Approval: file change',
    evidence: evidence(
      claudeTool('Edit'),
      codexMethod('item/fileChange/requestApproval'),
      grokAcp('session/request_permission')
    ),
  },
  {
    id: 'plan.enter',
    label: 'Plan mode: enter',
    evidence: evidence(
      claudeTool('EnterPlanMode'),
      codexMethod('collaborationMode/list'),
      grokHelp('--permission-mode plan')
    ),
  },
  {
    id: 'plan.presentation',
    label: 'Plan mode: presentation',
    evidence: evidence(
      claudeTool('ExitPlanMode'),
      codexMethod('turn/plan/updated'),
      grokAcp('plan')
    ),
  },
  {
    id: 'plan.decision',
    label: 'Plan mode: approve or reject',
    evidence: evidence(
      claudeTool('ExitPlanMode'),
      codexMethod('item/tool/requestUserInput'),
      grokAcp('session/request_permission')
    ),
  },
  {
    id: 'plan.edit',
    label: 'Plan mode: edit feedback',
    evidence: evidence(
      claudeTool('ExitPlanMode'),
      codexMethod('turn/steer'),
      grokAcp('session/prompt')
    ),
  },
  {
    id: 'plan.indicator',
    label: 'Plan mode: visible indicator',
    evidence: evidence(
      claudeTool('EnterPlanMode'),
      codexMethod('thread/status/changed'),
      grokAcp('current_mode_update')
    ),
  },
  {
    id: 'subagent.spawn',
    label: 'Subagents: spawn',
    evidence: evidence(
      claudeTool('Task'),
      codexMethod('collaborationMode/list'),
      grokHelp('--agents')
    ),
  },
  {
    id: 'subagent.progress',
    label: 'Subagents: progress',
    evidence: evidence(
      claudeTool('TaskOutput'),
      codexMethod('item/mcpToolCall/progress'),
      grokAcp('tool_call_update')
    ),
  },
  {
    id: 'stream.partial',
    label: 'Streaming partial output',
    evidence: evidence(
      claudeSdk('includePartialMessages'),
      codexMethod('item/agentMessage/delta'),
      grokHelp('--include-partial-messages')
    ),
  },
  {
    id: 'reasoning.display',
    label: 'Reasoning display',
    evidence: evidence(
      claudeSdk('SDKAssistantMessage'),
      codexMethod('item/reasoning/summaryTextDelta'),
      grokAcp('agent_thought_chunk')
    ),
  },
  {
    id: 'todo.display',
    label: 'To-do list',
    evidence: evidence(claudeTool('TaskList'), codexSdk('todo_list'), grokAcp('plan')),
  },
  {
    id: 'diff.review',
    label: 'File diff accept or reject',
    evidence: evidence(
      claudeTool('Edit'),
      codexMethod('turn/diff/updated'),
      grokAcp('tool_call_update')
    ),
  },
  {
    id: 'turn.stop',
    label: 'Interrupt or stop',
    evidence: evidence(
      claudeSdk('AbortController'),
      codexMethod('turn/interrupt'),
      grokAcp('session/cancel')
    ),
  },
  {
    id: 'turn.queue',
    label: 'Queue a follow-up mid-turn',
    evidence: evidence(
      claudeSdk('AsyncIterable<SDKUserMessage>'),
      codexMethod('thread/queue/add'),
      grokAcp('session/prompt')
    ),
  },
  {
    id: 'command.slash',
    label: 'Slash commands',
    evidence: evidence(
      claudeSdk('supportedCommands'),
      codexMethod('not-advertised:slash-command'),
      grokAcpRuntime('availableCommands')
    ),
  },
  {
    id: 'command.custom',
    label: 'DNAForge custom commands',
    evidence: evidence(
      dnaforgeRuntime('dnaforge-custom-command'),
      dnaforgeRuntime('dnaforge-custom-command'),
      dnaforgeRuntime('dnaforge-custom-command')
    ),
  },
  {
    id: 'skill.invoke',
    label: 'Skills',
    evidence: evidence(claudeTool('Skill'), codexMethod('skills/list'), grokHelp('plugin')),
  },
  {
    id: 'memory.manage',
    label: 'DNAForge scoped memory',
    evidence: evidence(
      dnaforgeRuntime('dnaforge-memory'),
      dnaforgeRuntime('dnaforge-memory'),
      dnaforgeRuntime('dnaforge-memory')
    ),
  },
  {
    id: 'memory.native_reset',
    label: 'Provider-native memory reset',
    evidence: evidence(
      claudeSdk('not-advertised:memory-management'),
      codexMethod('memory/reset'),
      grokHelp('memory')
    ),
  },
  {
    id: 'plugin.manage',
    label: 'Provider plugin management',
    evidence: evidence(claudeHelp('plugin'), codexMethod('plugin/list'), grokHelp('plugin')),
  },
  {
    id: 'session.resume',
    label: 'Session resume',
    evidence: evidence(claudeSdk('resume'), codexMethod('thread/resume'), grokAcp('session/load')),
  },
  {
    id: 'session.fork',
    label: 'Session fork',
    evidence: evidence(
      claudeSdk('forkSession'),
      codexMethod('thread/fork'),
      grokHelp('--fork-session')
    ),
  },
  {
    id: 'session.history',
    label: 'Session history',
    evidence: evidence(claudeSdk('listSessions'), codexMethod('thread/list'), grokHelp('sessions')),
  },
  {
    id: 'mcp.elicitation',
    label: 'MCP elicitation',
    evidence: evidence(
      claudeSdk('canUseTool'),
      codexMethod('mcpServer/elicitation/request'),
      grokAcp('elicitation/create')
    ),
  },
  {
    id: 'attachment.input',
    label: 'Input attachments',
    evidence: evidence(
      claudeSdk('SDKUserMessage'),
      codexMethod('turn/start'),
      grokAcp('ContentBlock')
    ),
  },
  {
    id: 'attachment.output',
    label: 'Output attachments',
    evidence: evidence(
      claudeSdk('SDKAssistantMessage'),
      codexMethod('item/completed'),
      grokAcp('ContentBlock')
    ),
  },
  {
    id: 'output.structured',
    label: 'Structured JSON-schema output',
    evidence: evidence(
      claudeSdk('outputFormat'),
      codexMethod('turn/start'),
      grokHelp('--json-schema')
    ),
  },
  {
    id: 'auth.login',
    label: 'Login',
    evidence: evidence(
      claudeSdk('SDKAuthStatusMessage'),
      codexMethod('account/login/start'),
      grokHelp('login')
    ),
  },
  {
    id: 'auth.logout',
    label: 'Logout',
    evidence: evidence(
      claudeSdk('not-advertised:logout'),
      codexMethod('account/logout'),
      grokHelp('logout')
    ),
  },
  {
    id: 'auth.account_switch',
    label: 'Account switching',
    evidence: evidence(
      claudeSdk('SDKAuthStatusMessage'),
      codexMethod('account/read'),
      grokHelp('login')
    ),
  },
  {
    id: 'schedule.create',
    label: 'Schedule: create',
    evidence: evidence(
      claudeTool('CronCreate'),
      codexMethod('not-advertised:schedule'),
      grokHelp('not-advertised:schedule')
    ),
  },
  {
    id: 'schedule.list',
    label: 'Schedule: list',
    evidence: evidence(
      claudeTool('CronList'),
      codexMethod('not-advertised:schedule'),
      grokHelp('not-advertised:schedule')
    ),
  },
  {
    id: 'schedule.cancel',
    label: 'Schedule: cancel',
    evidence: evidence(
      claudeTool('CronDelete'),
      codexMethod('not-advertised:schedule'),
      grokHelp('not-advertised:schedule')
    ),
  },
  {
    id: 'schedule.wakeup',
    label: 'Schedule: wake-up',
    evidence: evidence(
      claudeTool('ScheduleWakeup'),
      codexMethod('not-advertised:schedule'),
      grokHelp('not-advertised:schedule')
    ),
  },
  {
    id: 'notification.push',
    label: 'Push notification',
    evidence: evidence(
      claudeTool('PushNotification'),
      codexMethod('not-advertised:notification'),
      grokHelp('not-advertised:notification')
    ),
  },
  {
    id: 'worktree.enter',
    label: 'Worktree: enter',
    evidence: evidence(
      claudeTool('EnterWorktree'),
      codexMethod('not-advertised:worktree'),
      grokHelp('--worktree')
    ),
  },
  {
    id: 'worktree.exit',
    label: 'Worktree: exit',
    evidence: evidence(
      claudeTool('ExitWorktree'),
      codexMethod('not-advertised:worktree'),
      grokHelp('worktree')
    ),
  },
] as const satisfies readonly AgentInteractionModeDefinition[];

export type AgentInteractionId = (typeof AGENT_INTERACTION_MODES)[number]['id'];

const NATIVE_SUPPORT: Readonly<Record<AgentTransport, ReadonlySet<AgentInteractionId>>> = {
  'claude-agent-sdk': new Set(
    AGENT_INTERACTION_MODES.map((mode) => mode.id).filter(
      (id) => id !== 'memory.native_reset' && id !== 'auth.logout'
    )
  ),
  'codex-sdk': new Set(
    AGENT_INTERACTION_MODES.map((mode) => mode.id).filter(
      (id) =>
        !id.startsWith('schedule.') &&
        !id.startsWith('notification.') &&
        !id.startsWith('worktree.') &&
        id !== 'command.slash' &&
        id !== 'command.custom'
    )
  ),
  'grok-acp': new Set(
    AGENT_INTERACTION_MODES.map((mode) => mode.id).filter(
      (id) => !id.startsWith('schedule.') && !id.startsWith('notification.') && id !== 'turn.queue'
    )
  ),
};

const DNAFORGE_SUPPORT = new Set<AgentInteractionId>(['command.custom', 'memory.manage']);

const FULL_BRIDGE: Readonly<Record<AgentTransport, ReadonlySet<AgentInteractionId>>> = {
  'claude-agent-sdk': new Set([
    'question.single',
    'question.multi',
    'question.free_text',
    'question.default',
    'question.cancel',
    'plan.enter',
    'plan.presentation',
    'plan.decision',
    'plan.edit',
    'plan.indicator',
    'subagent.spawn',
    'subagent.progress',
    'stream.partial',
    'reasoning.display',
    'todo.display',
    'turn.stop',
    'turn.queue',
    'command.slash',
    'command.custom',
    'skill.invoke',
    'memory.manage',
    'plugin.manage',
    'session.resume',
    'session.fork',
    'session.history',
    'attachment.input',
    'output.structured',
    'auth.login',
    'schedule.create',
    'schedule.list',
    'schedule.cancel',
    'schedule.wakeup',
    'notification.push',
  ]),
  'codex-sdk': new Set([
    'question.single',
    'question.multi',
    'question.free_text',
    'question.default',
    'question.cancel',
    'approval.tool',
    'approval.command',
    'approval.file_change',
    'plan.presentation',
    'subagent.progress',
    'stream.partial',
    'reasoning.display',
    'todo.display',
    'diff.review',
    'turn.stop',
    'turn.queue',
    'command.custom',
    'skill.invoke',
    'memory.manage',
    'memory.native_reset',
    'plugin.manage',
    'session.resume',
    'session.fork',
    'session.history',
    'mcp.elicitation',
    'attachment.input',
    'output.structured',
    'auth.login',
  ]),
  'grok-acp': new Set([
    'question.single',
    'question.multi',
    'question.free_text',
    'question.default',
    'question.cancel',
    'approval.tool',
    'approval.command',
    'approval.file_change',
    'plan.presentation',
    'subagent.progress',
    'stream.partial',
    'reasoning.display',
    'todo.display',
    'turn.stop',
    'command.slash',
    'command.custom',
    'skill.invoke',
    'memory.manage',
    'memory.native_reset',
    'plugin.manage',
    'session.resume',
    'session.fork',
    'session.history',
    'mcp.elicitation',
    'attachment.input',
    'output.structured',
    'auth.login',
  ]),
};

const FULL_UI: Readonly<Record<AgentTransport, ReadonlySet<AgentInteractionId>>> = {
  'claude-agent-sdk': new Set([
    'question.single',
    'question.multi',
    'question.free_text',
    'question.default',
    'question.cancel',
    'plan.enter',
    'plan.presentation',
    'plan.decision',
    'plan.edit',
    'plan.indicator',
    'subagent.spawn',
    'subagent.progress',
    'stream.partial',
    'reasoning.display',
    'todo.display',
    'turn.stop',
    'turn.queue',
    'command.slash',
    'command.custom',
    'skill.invoke',
    'memory.manage',
    'plugin.manage',
    'session.resume',
    'session.fork',
    'session.history',
    'attachment.input',
    'output.structured',
    'auth.login',
    'schedule.create',
    'schedule.list',
    'schedule.cancel',
    'schedule.wakeup',
    'notification.push',
  ]),
  'codex-sdk': new Set([
    'question.single',
    'question.multi',
    'question.free_text',
    'question.default',
    'question.cancel',
    'approval.tool',
    'approval.command',
    'approval.file_change',
    'plan.presentation',
    'subagent.progress',
    'stream.partial',
    'reasoning.display',
    'todo.display',
    'diff.review',
    'turn.stop',
    'turn.queue',
    'command.custom',
    'skill.invoke',
    'memory.manage',
    'memory.native_reset',
    'plugin.manage',
    'session.resume',
    'session.fork',
    'session.history',
    'mcp.elicitation',
    'attachment.input',
    'output.structured',
    'auth.login',
  ]),
  'grok-acp': new Set([
    'question.single',
    'question.multi',
    'question.free_text',
    'question.default',
    'question.cancel',
    'approval.tool',
    'approval.command',
    'approval.file_change',
    'plan.presentation',
    'subagent.progress',
    'stream.partial',
    'reasoning.display',
    'todo.display',
    'turn.stop',
    'command.slash',
    'command.custom',
    'skill.invoke',
    'memory.manage',
    'memory.native_reset',
    'plugin.manage',
    'session.resume',
    'session.fork',
    'session.history',
    'mcp.elicitation',
    'attachment.input',
    'output.structured',
    'auth.login',
  ]),
};

const providerLabel = (provider: AgentTransport): string =>
  provider === 'claude-agent-sdk'
    ? 'Claude Code'
    : provider === 'codex-sdk'
      ? 'Codex CLI'
      : 'Grok Build';

function reviewedException(
  provider: AgentTransport,
  mode: AgentInteractionModeDefinition
): AgentInteractionException {
  return {
    owner: 'Desktop AI',
    userVisibleReason: `${providerLabel(provider)} supports ${mode.label.toLowerCase()}, but DNAForge does not yet carry the complete interaction through this chat surface.`,
    removalCondition: `Remove when ${mode.label.toLowerCase()} crosses the provider protocol, conversation-scoped IPC, visible chat UI, cancellation, and real-Electron acceptance workflow.`,
  };
}

function buildCell(
  provider: AgentTransport,
  mode: AgentInteractionModeDefinition
): AgentInteractionCell {
  const dnaforge = DNAFORGE_SUPPORT.has(mode.id as AgentInteractionId);
  const native = NATIVE_SUPPORT[provider].has(mode.id as AgentInteractionId);
  if (!native && !dnaforge) {
    return {
      agentSupport: 'not-advertised',
      bridge: 'not-applicable',
      ui: 'not-applicable',
      evidence: mode.evidence[provider],
      userLoss: `${providerLabel(provider)} does not advertise ${mode.label.toLowerCase()} in the reviewed protocol surface.`,
    };
  }
  const bridge = FULL_BRIDGE[provider].has(mode.id as AgentInteractionId) ? 'full' : 'none';
  const ui = FULL_UI[provider].has(mode.id as AgentInteractionId) ? 'full' : 'none';
  if (bridge === 'full' && ui === 'full') {
    return {
      agentSupport: dnaforge ? 'dnaforge' : 'native',
      bridge,
      ui,
      evidence: mode.evidence[provider],
      userLoss: 'None; the native interaction is carried through the DNAForge chat surface.',
    };
  }
  return {
    agentSupport: dnaforge ? 'dnaforge' : 'native',
    bridge,
    ui,
    evidence: mode.evidence[provider],
    userLoss: `The user cannot complete ${mode.label.toLowerCase()} inside DNAForge today.`,
    exception: reviewedException(provider, mode),
  };
}

export interface AgentInteractionMatrixRow {
  readonly id: AgentInteractionId;
  readonly label: string;
  readonly providers: Readonly<Record<AgentTransport, AgentInteractionCell>>;
}

export const AGENT_INTERACTION_MATRIX: Readonly<
  Record<AgentInteractionId, AgentInteractionMatrixRow>
> = Object.fromEntries(
  AGENT_INTERACTION_MODES.map((mode) => [
    mode.id,
    {
      id: mode.id,
      label: mode.label,
      providers: {
        'claude-agent-sdk': buildCell('claude-agent-sdk', mode),
        'codex-sdk': buildCell('codex-sdk', mode),
        'grok-acp': buildCell('grok-acp', mode),
      },
    },
  ])
) as Record<AgentInteractionId, AgentInteractionMatrixRow>;
