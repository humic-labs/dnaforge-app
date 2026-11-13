import { canonicalizePath, classifyShellCommand, classifyToolCall } from './tool-permission-policy';
import type { DestructiveFileConfirmRequest } from '../../shared/agent-confirm-types';
import type { AgentShellSupervision } from '../../shared/agent-runtime-ipc';
import { approvalChoiceAllows, type AgentApprovalChoice } from '../../shared/agent-approval';
import type { ApprovalMemory } from './approval-memory';
import {
  commandApprovalRule,
  displayApprovalCommand,
  displayApprovalPath,
  writeApprovalRule,
  type ApprovalRoot,
} from './approval-rules';

interface PreToolUseHookInputLike {
  tool_name?: unknown;
  tool_input?: unknown;
}

function readHookInput(input: unknown): { toolName: string; toolInput: unknown } {
  const record = (input && typeof input === 'object' ? input : {}) as PreToolUseHookInputLike;
  return {
    toolName: typeof record.tool_name === 'string' ? record.tool_name : '',
    toolInput: record.tool_input,
  };
}

export interface PreToolUseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

export interface DestructiveFileGuardDeps {
  cwd: string | null;
  userRoots: readonly string[];
  scratchRoot: string;
  shellSupervision: AgentShellSupervision;
  askBeforeWrites?: boolean;
  commandSandbox?: boolean;
  conversationId?: string | null;
  approvalMemory?: ApprovalMemory | null;
  approvalRoots?: readonly ApprovalRoot[];
  onStop?: () => void;
  confirmDestructiveFile: (
    request: Omit<DestructiveFileConfirmRequest, 'requestId'>,
    signal?: AbortSignal
  ) => Promise<AgentApprovalChoice>;
}

const STRUCTURED_WRITE_TOOLS = new Set(['Write', 'MultiEdit']);
const EDIT_TOOLS = new Set(['Edit', 'NotebookEdit']);

export function describeToolCallForConfirmation(
  toolName: string,
  input: unknown,
  commandCwd?: string | null
): Omit<DestructiveFileConfirmRequest, 'requestId'> {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'Bash' || toolName === 'ProcessStart') {
    const command = typeof record.command === 'string' ? record.command : '';
    const classification = classifyShellCommand(command);
    const unsandboxed = record.dangerouslyDisableSandbox === true;
    return {
      toolName,
      operation: unsandboxed ? 'Run command outside the sandbox' : classification.operation,
      resolvedPath: commandCwd && commandCwd.trim().length > 0 ? canonicalizePath(commandCwd) : '',
      command,
      risk: unsandboxed ? 'unknown' : classification.risk,
      riskSummary: unsandboxed
        ? 'This command asks to run with network access and without the folder limits.'
        : classification.riskSummary,
    };
  }
  if (toolName === 'Move') {
    const source =
      typeof record.source_path === 'string' ? canonicalizePath(record.source_path) : '';
    const destination =
      typeof record.destination_path === 'string' ? canonicalizePath(record.destination_path) : '';
    return {
      toolName,
      operation: 'Move file or directory',
      resolvedPath: `${source} → ${destination}`,
    };
  }
  if (toolName === 'Delete') {
    const target = typeof record.path === 'string' ? canonicalizePath(record.path) : '';
    return { toolName, operation: 'Move file or directory to Trash', resolvedPath: target };
  }
  const rawTarget = toolName === 'NotebookEdit' ? record.notebook_path : record.file_path;
  const resolvedPath =
    typeof rawTarget === 'string' && rawTarget.trim().length > 0 ? canonicalizePath(rawTarget) : '';
  const operation = STRUCTURED_WRITE_TOOLS.has(toolName)
    ? 'Overwrite file'
    : EDIT_TOOLS.has(toolName)
      ? 'Edit file'
      : 'Modify file';
  return { toolName, operation, resolvedPath };
}

export function createDestructiveFilePreToolUseHook(deps: DestructiveFileGuardDeps) {
  const {
    cwd,
    userRoots,
    scratchRoot,
    shellSupervision,
    askBeforeWrites,
    commandSandbox,
    conversationId,
    approvalMemory,
    approvalRoots = [],
    onStop,
    confirmDestructiveFile,
  } = deps;

  return async function preToolUseGuard(
    input: unknown,
    _toolUseId?: string,
    _options?: { signal: AbortSignal }
  ): Promise<PreToolUseHookOutput> {
    const { toolName, toolInput } = readHookInput(input);

    const classification = classifyToolCall({
      toolName,
      input: toolInput,
      cwd,
      userRoots,
      scratchRoot,
      shellSupervision,
      askBeforeWrites,
      commandSandbox,
    });

    if (classification === 'allow') return {};

    const request = describeToolCallForConfirmation(toolName, toolInput, cwd ?? scratchRoot);
    if (conversationId) request.conversationId = conversationId;
    const isShell = toolName === 'Bash' || toolName === 'ProcessStart';
    if (isShell) {
      request.resolvedPath = canonicalizePath(cwd && cwd.trim().length > 0 ? cwd : scratchRoot);
    }
    const rule =
      isShell && request.command
        ? commandApprovalRule(request.command)
        : writeApprovalRule(request.resolvedPath, approvalRoots);
    if (approvalMemory?.allows(conversationId, rule.key)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Allowed earlier for ${rule.label}.`,
        },
      };
    }
    request.rule = rule;
    request.displayPath = displayApprovalPath(request.resolvedPath, approvalRoots);
    if (request.command) {
      request.displayCommand = displayApprovalCommand(request.command, approvalRoots);
    }

    let choice: AgentApprovalChoice = 'deny';
    try {
      choice = await confirmDestructiveFile(request, _options?.signal);
    } catch {
      choice = 'deny';
    }
    approvalMemory?.remember(choice, conversationId, rule);
    if (choice === 'stop') onStop?.();
    const allowed = approvalChoiceAllows(choice);

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: allowed ? 'allow' : 'deny',
        permissionDecisionReason: allowed
          ? 'User confirmed this operation on their files.'
          : choice === 'stop'
            ? 'The user stopped this turn.'
            : 'The user declined this operation. Continue without it.',
      },
    };
  };
}
