import type { HostedNativeToolName } from '@waypoint/hosted-ai-contract';

export const CLAUDE_BUNDLED_RUNTIME_VERSION = '2.1.150';

interface ActiveRuntimeToolPolicy {
  readonly status: 'active';
}

interface AppBridgedRuntimeToolPolicy {
  readonly status: 'app-bridge';
}

interface ProviderInternalRuntimeToolPolicy {
  readonly status: 'provider-runtime-internal';
  readonly owner: string;
  readonly reason: string;
  readonly userVisibleReason: string;
  readonly removalCondition: string;
}

type ClaudeRuntimeToolPolicy =
  | ActiveRuntimeToolPolicy
  | AppBridgedRuntimeToolPolicy
  | ProviderInternalRuntimeToolPolicy;

const active = (): ActiveRuntimeToolPolicy => ({ status: 'active' });
const appBridge = (): AppBridgedRuntimeToolPolicy => ({ status: 'app-bridge' });
const providerInternal = (
  reason: string,
  removalCondition: string
): ProviderInternalRuntimeToolPolicy => ({
  status: 'provider-runtime-internal',
  owner: 'Desktop AI',
  reason,
  userVisibleReason: reason,
  removalCondition,
});

export const CLAUDE_RUNTIME_TOOL_POLICY = {
  Task: active(),
  AskUserQuestion: appBridge(),
  Bash: active(),
  CronCreate: active(),
  CronDelete: active(),
  CronList: active(),
  Edit: active(),
  EnterPlanMode: active(),
  EnterWorktree: providerInternal(
    'Agent-created Git worktrees do not map to a scientist workspace and could hide edits outside the selected DNAForge workspace.',
    'Remove only if DNAForge gains an explicit scientist-facing branch-workspace model with enter, exit, recovery, and cleanup controls.'
  ),
  ExitPlanMode: appBridge(),
  ExitWorktree: providerInternal(
    'Agent-created Git worktrees do not map to a scientist workspace and could hide edits outside the selected DNAForge workspace.',
    'Remove only if DNAForge gains an explicit scientist-facing branch-workspace model with enter, exit, recovery, and cleanup controls.'
  ),
  Glob: active(),
  Grep: active(),
  Monitor: active(),
  NotebookEdit: active(),
  PushNotification: active(),
  Read: active(),
  ScheduleWakeup: active(),
  Skill: providerInternal(
    'Claude skills are exposed only through the SDK skills allow-list, which enables exact DNAForge-approved names without making the unrestricted Skill tool part of the general native-tool policy.',
    'Keep this provider-internal: the SDK automatically enables Skill(name) for each exact entry in its skills option.'
  ),
  TaskCreate: active(),
  TaskGet: active(),
  TaskList: active(),
  TaskOutput: active(),
  TaskStop: active(),
  TaskUpdate: active(),
  WebFetch: active(),
  WebSearch: active(),
  Write: active(),
} as const satisfies Record<string, ClaudeRuntimeToolPolicy>;

export type ClaudeRuntimeToolName = keyof typeof CLAUDE_RUNTIME_TOOL_POLICY;
export type ActiveClaudeRuntimeToolName = {
  [ToolName in ClaudeRuntimeToolName]: (typeof CLAUDE_RUNTIME_TOOL_POLICY)[ToolName]['status'] extends 'active'
    ? ToolName
    : never;
}[ClaudeRuntimeToolName];

function activeRuntimeToolNames(): ActiveClaudeRuntimeToolName[] {
  return (Object.keys(CLAUDE_RUNTIME_TOOL_POLICY) as ClaudeRuntimeToolName[]).filter(
    (toolName): toolName is ActiveClaudeRuntimeToolName =>
      CLAUDE_RUNTIME_TOOL_POLICY[toolName].status === 'active'
  );
}

export const CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS: readonly ActiveClaudeRuntimeToolName[] =
  activeRuntimeToolNames();

export const HOSTED_EQUIVALENTS_FOR_CLAUDE_TOOL: Readonly<
  Record<ActiveClaudeRuntimeToolName, readonly HostedNativeToolName[]>
> = {
  Task: [],
  Bash: ['Bash', 'ProcessStart'],
  CronCreate: [],
  CronDelete: [],
  CronList: [],
  Edit: ['Edit'],
  Glob: ['Glob'],
  Grep: ['Grep'],
  EnterPlanMode: [],
  Monitor: [],
  NotebookEdit: ['NotebookEdit'],
  PushNotification: [],
  Read: ['Read'],
  ScheduleWakeup: [],
  TaskCreate: ['TaskCreate'],
  TaskGet: ['TaskGet'],
  TaskList: ['TaskList'],
  TaskOutput: ['ProcessStatus'],
  TaskStop: ['ProcessStop'],
  TaskUpdate: ['TaskUpdate'],
  WebFetch: ['WebFetch'],
  WebSearch: [],
  Write: ['Write'],
};

export interface HostedClaudeCapabilityException {
  readonly owner: string;
  readonly reason: string;
  readonly removalCondition: string;
}

const HOSTED_WEB_SEARCH_EXCEPTION: HostedClaudeCapabilityException = {
  owner: 'AI Platform',
  reason:
    'DNAForge has no approved app-owned search provider whose privacy, cost, credentials, citations, and Hosted reservation accounting are reviewed.',
  removalCondition:
    'Remove after an app-owned search provider passes privacy, cost, credential-boundary, citation, cancellation, and reservation-accounting review.',
};

export const HOSTED_CLAUDE_CAPABILITY_EXCEPTIONS: Readonly<
  Partial<Record<ActiveClaudeRuntimeToolName, HostedClaudeCapabilityException>>
> = {
  Task: {
    owner: 'Desktop AI',
    reason:
      'Hosted AI has no app-owned, turn-scoped subagent executor with the same local authority, Stop, and observation guarantees.',
    removalCondition:
      'Remove when app-owned turn-scoped subagent orchestration preserves exact tool authority, Stop, result observation, and history persistence.',
  },
  CronCreate: {
    owner: 'AI Platform',
    reason:
      'Hosted Codex does not advertise a native schedule creation protocol; local Claude schedules are indexed and controlled by the desktop app.',
    removalCondition:
      'Remove when Hosted exposes durable scheduled turns with stable IDs, lifecycle events, persistence, and server-side cancellation.',
  },
  CronDelete: {
    owner: 'AI Platform',
    reason: 'Hosted Codex has no native scheduled task to cancel.',
    removalCondition:
      'Remove when Hosted scheduled turns expose stable IDs and a server-side cancellation request.',
  },
  CronList: {
    owner: 'AI Platform',
    reason: 'Hosted Codex has no native scheduled-task inventory.',
    removalCondition:
      'Remove when Hosted scheduled turns expose a user-scoped, server-authoritative inventory.',
  },
  EnterPlanMode: {
    owner: 'Desktop AI',
    reason:
      'Hosted Codex presents plans through App Server notifications rather than Claude EnterPlanMode.',
    removalCondition:
      'Remove when the provider-neutral plan state machine treats Hosted App Server plan updates and Claude plan mode as one accepted workflow.',
  },
  Monitor: {
    owner: 'Desktop AI',
    reason:
      'Hosted background process progress is carried by ProcessStatus and trace events, not Claude Monitor.',
    removalCondition:
      'Remove if Hosted adopts a native long-running monitor request that is not represented by ProcessStatus and trace events.',
  },
  PushNotification: {
    owner: 'Desktop AI',
    reason:
      'Hosted Codex has no matching native notification tool; local Claude notifications map to DNAForge toasts.',
    removalCondition:
      'Remove when Hosted emits an equivalent bounded notification request through the App Server protocol.',
  },
  ScheduleWakeup: {
    owner: 'AI Platform',
    reason: 'Hosted Codex has no native delayed wake-up request.',
    removalCondition:
      'Remove when Hosted provides bounded delayed wake-ups with visible lifecycle and cancellation.',
  },
  WebSearch: HOSTED_WEB_SEARCH_EXCEPTION,
};

export const CODEX_SDK_VERSION = '0.144.5';

interface ActiveCodexEffectPolicy {
  readonly status: 'active-effect';
}

interface CodexProviderOutputPolicy {
  readonly status: 'provider-output';
  readonly reason: string;
}

type CodexThreadItemPolicy = ActiveCodexEffectPolicy | CodexProviderOutputPolicy;

const activeCodexEffect = (): ActiveCodexEffectPolicy => ({ status: 'active-effect' });
const codexProviderOutput = (reason: string): CodexProviderOutputPolicy => ({
  status: 'provider-output',
  reason,
});

export const CODEX_SDK_THREAD_ITEM_POLICY = {
  agent_message: codexProviderOutput('Assistant text is output, not a user capability.'),
  reasoning: codexProviderOutput('Reasoning summaries are output, not a user capability.'),
  command_execution: activeCodexEffect(),
  file_change: activeCodexEffect(),
  mcp_tool_call: activeCodexEffect(),
  web_search: activeCodexEffect(),
  todo_list: activeCodexEffect(),
  error: codexProviderOutput('Diagnostic errors are output, not a user capability.'),
} as const satisfies Record<string, CodexThreadItemPolicy>;

type CodexThreadItemType = keyof typeof CODEX_SDK_THREAD_ITEM_POLICY;
export type ActiveCodexThreadItemType = {
  [ItemType in CodexThreadItemType]: (typeof CODEX_SDK_THREAD_ITEM_POLICY)[ItemType]['status'] extends 'active-effect'
    ? ItemType
    : never;
}[CodexThreadItemType];

type HostedCodexCapabilityEquivalence =
  | {
      readonly kind: 'native-tools';
      readonly tools: readonly HostedNativeToolName[];
    }
  | {
      readonly kind: 'canonical-renderer-catalog';
    }
  | {
      readonly kind: 'reviewed-exception';
      readonly exception: HostedClaudeCapabilityException;
    };

export const HOSTED_EQUIVALENTS_FOR_CODEX_ITEM: Readonly<
  Record<ActiveCodexThreadItemType, HostedCodexCapabilityEquivalence>
> = {
  command_execution: {
    kind: 'native-tools',
    tools: ['Bash', 'ProcessStart', 'ProcessStatus', 'ProcessStop'],
  },
  file_change: {
    kind: 'native-tools',
    tools: ['Write', 'Edit', 'Move', 'Delete'],
  },
  mcp_tool_call: { kind: 'canonical-renderer-catalog' },
  web_search: {
    kind: 'reviewed-exception',
    exception: HOSTED_WEB_SEARCH_EXCEPTION,
  },
  todo_list: {
    kind: 'native-tools',
    tools: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'],
  },
};

export const CODEX_RUNTIME_DISCOVERY_EXCEPTION: HostedClaudeCapabilityException = {
  owner: 'Desktop AI',
  reason:
    'The Codex SDK does not emit a startup native-tool inventory; DNAForge can exhaustively classify its effect events and live MCP catalog, but not provider-owned native tool names without starting a provider turn.',
  removalCondition:
    'Remove when the Codex SDK exposes a provider-free runtime capability inventory, then compare that inventory directly with the Hosted catalog.',
};
