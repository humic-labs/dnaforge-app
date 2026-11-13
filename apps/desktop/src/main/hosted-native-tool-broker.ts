import {
  HostedNativeShellConfinementError,
  type HostedNativeShellRequest,
} from './hosted-native-shell-confinement';
import type { HostedNativeProcessLaunch } from './hosted-native-process-supervisor';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { glob } from 'glob';
import {
  getHostedNativeToolDefinition,
  type HostedNativeToolName,
} from '@waypoint/hosted-ai-contract';
import type {
  HostedAiNativeToolRequest,
  HostedAiTurnBindingRequest,
} from '../shared/hosted-ai-gateway-ipc';
import type { DestructiveFileConfirmRequest } from '../shared/agent-confirm-types';
import { isPathInsideAnyBoundary } from '../shared/path-boundary';
import { canonicalizePath, classifyToolCall } from './agent-sdk/tool-permission-policy';
import { describeToolCallForConfirmation } from './agent-sdk/destructive-file-guard';
import {
  HostedNativeProcessNotStartedError,
  HostedNativeProcessSupervisor,
  type HostedNativeProcessResult,
} from './hosted-native-process-supervisor';
import { editHostedNotebook, readHostedNotebook } from './hosted-native-notebook';
import { searchHostedTextInDedicatedWorker } from './hosted-native-regex-worker-client';
import type {
  HostedNativeRegexWorkerJob,
  HostedNativeRegexWorkerResult,
} from './hosted-native-regex-worker-job';
import { HostedNativeTaskStore } from './hosted-native-task-store';
import {
  diffHostedWorkspace,
  snapshotHostedWorkspace,
  type HostedWorkspaceSnapshot,
} from './hosted-native-workspace-diff';
import { approvalChoiceAllows, type AgentApprovalChoice } from '../shared/agent-approval';
import { dnaforgeSupervision } from '../shared/agent-permissions';

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_000;
const DEFAULT_LINE_LIMIT = 500;
const DEFAULT_PATH_LIMIT = 500;
const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
const MAX_PROCESS_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 2_000;

export class HostedNativeToolDeclinedError extends Error {
  constructor() {
    super('The user declined this local operation.');
    this.name = 'HostedNativeToolDeclinedError';
  }
}

export class HostedNativeToolStoppedError extends Error {
  constructor() {
    super('Stopped before this local operation completed.');
    this.name = 'HostedNativeToolStoppedError';
  }
}

export class HostedNativeToolAuthorizationError extends Error {
  constructor() {
    super('The Hosted turn authority changed.');
    this.name = 'HostedNativeToolAuthorizationError';
  }
}

interface HostedNativeTurnScope {
  readonly workspacePath: string | null;
}

interface HostedNativeToolBrokerDependencies {
  readonly prepareShellProcess?: (
    request: HostedNativeShellRequest
  ) => Promise<HostedNativeProcessLaunch>;
  readonly authorizeTurn: (
    ownerId: number,
    request: HostedAiTurnBindingRequest
  ) => Promise<HostedNativeTurnScope>;
  readonly confirmDestructiveFile: (
    ownerId: number,
    request: Omit<DestructiveFileConfirmRequest, 'requestId'>,
    signal: AbortSignal
  ) => Promise<AgentApprovalChoice>;
  readonly resolveSafePath: (path: string) => Promise<string>;
  readonly resolveSafeWritablePath: (path: string) => Promise<string>;
  readonly withSafeWritablePaths: <T>(
    paths: readonly string[],
    operation: (paths: readonly string[]) => Promise<T>
  ) => Promise<T>;
  readonly trashPath: (path: string) => Promise<void>;
  readonly fetchWeb: (url: string, signal: AbortSignal) => Promise<unknown>;
  readonly searchText?: (
    job: HostedNativeRegexWorkerJob,
    options: { readonly signal?: AbortSignal }
  ) => Promise<HostedNativeRegexWorkerResult>;
  readonly scratchBase: string;
  readonly idGenerator?: () => string;
  readonly processSupervisor?: HostedNativeProcessSupervisor;
  readonly shutdownDrainMs?: number;
}

interface ActiveOperation {
  readonly ownerId: number;
  readonly turnBindingToken: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native tool input must be an object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`Native tool input ${key} is invalid.`);
  }
  return value;
}

function boundedString(input: Record<string, unknown>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`Native tool input ${key} is invalid.`);
  }
  return value;
}

function boundedIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 ? value : null;
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Native tool input ${key} is invalid.`);
  }
  return value as number;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Error(`Native tool input ${key} is invalid.`);
  return value;
}

function relativeOrAbsolute(candidate: string, cwd: string): string {
  return isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
}

function assertNotStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new HostedNativeToolStoppedError();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sameFileIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function bindingRequest(request: HostedAiNativeToolRequest): HostedAiTurnBindingRequest {
  return {
    turnBindingToken: request.turnBindingToken,
    workflowId: request.workflowId,
    runId: request.runId,
    turnId: request.turnId,
  };
}

export function hostedNativeScratchSegment(token: string): string {
  return `turn-${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
}

function pathInputForPolicy(
  toolName: HostedNativeToolName,
  input: Record<string, unknown>,
  cwd: string
): Record<string, unknown> {
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return {
      ...input,
      file_path: canonicalizePath(
        relativeOrAbsolute(requiredString(input, 'file_path', 4096), cwd)
      ),
    };
  }
  if (toolName === 'NotebookEdit') {
    return {
      ...input,
      notebook_path: canonicalizePath(
        relativeOrAbsolute(requiredString(input, 'notebook_path', 4096), cwd)
      ),
    };
  }
  if (toolName === 'Move') {
    return {
      ...input,
      source_path: canonicalizePath(
        relativeOrAbsolute(requiredString(input, 'source_path', 4096), cwd)
      ),
      destination_path: canonicalizePath(
        relativeOrAbsolute(requiredString(input, 'destination_path', 4096), cwd)
      ),
    };
  }
  if (toolName === 'Delete') {
    return {
      ...input,
      path: canonicalizePath(relativeOrAbsolute(requiredString(input, 'path', 4096), cwd)),
    };
  }
  return input;
}

function validateMutatingInputForApproval(
  toolName: HostedNativeToolName,
  input: Record<string, unknown>
): void {
  switch (toolName) {
    case 'NotebookEdit': {
      requiredString(input, 'notebook_path', 4096);
      boundedString(input, 'new_source', MAX_INPUT_BYTES);
      const mode = input.edit_mode ?? 'replace';
      if (mode !== 'replace' && mode !== 'insert' && mode !== 'delete') {
        throw new Error('Native tool input edit_mode is invalid.');
      }
      if (
        input.cell_type !== undefined &&
        input.cell_type !== 'code' &&
        input.cell_type !== 'markdown'
      ) {
        throw new Error('Native tool input cell_type is invalid.');
      }
      if (mode === 'insert' && input.cell_type === undefined) {
        throw new Error('NotebookEdit cell_type is required when inserting a cell.');
      }
      if (mode !== 'insert') requiredString(input, 'cell_id', 128);
      else if (input.cell_id !== undefined) requiredString(input, 'cell_id', 128);
      return;
    }
    case 'Write':
      requiredString(input, 'file_path', 4096);
      boundedString(input, 'content', MAX_INPUT_BYTES);
      return;
    case 'Edit':
      requiredString(input, 'file_path', 4096);
      requiredString(input, 'old_string', MAX_INPUT_BYTES);
      boundedString(input, 'new_string', MAX_INPUT_BYTES);
      optionalBoolean(input, 'replace_all');
      return;
    case 'MultiEdit': {
      requiredString(input, 'file_path', 4096);
      if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 100) {
        throw new Error('Native tool input edits is invalid.');
      }
      input.edits.forEach((rawEdit) => {
        const edit = record(rawEdit);
        requiredString(edit, 'old_string', MAX_INPUT_BYTES);
        boundedString(edit, 'new_string', MAX_INPUT_BYTES);
        optionalBoolean(edit, 'replace_all');
      });
      return;
    }
    case 'Move':
      requiredString(input, 'source_path', 4096);
      requiredString(input, 'destination_path', 4096);
      optionalBoolean(input, 'overwrite');
      return;
    case 'Delete':
      requiredString(input, 'path', 4096);
      return;
    case 'Bash':
      requiredString(input, 'command', 64 * 1024);
      optionalInteger(input, 'timeout_ms', DEFAULT_PROCESS_TIMEOUT_MS, 100, MAX_PROCESS_TIMEOUT_MS);
      return;
    case 'ProcessStart':
      requiredString(input, 'command', 64 * 1024);
      return;
    case 'ProcessStop':
      requiredString(input, 'process_id', 256);
      return;
    default:
      return;
  }
}

export class HostedNativeToolBroker {
  private readonly operations = new Map<string, ActiveOperation>();
  private readonly turnOwners = new Map<string, number>();
  private readonly drainingOwners = new Set<number>();
  private readonly drainingTurnBindings = new Set<string>();
  private readonly pendingOwnerCleanups = new Map<number, Promise<void>>();
  private readonly pendingTurnCleanups = new Map<string, Promise<void>>();
  private readonly idGenerator: () => string;
  private readonly processes: HostedNativeProcessSupervisor;
  private readonly searchText: NonNullable<HostedNativeToolBrokerDependencies['searchText']>;
  private readonly scratchReady: Promise<void>;
  private readonly tasks: HostedNativeTaskStore;
  private readonly shutdownDrainMs: number;
  private shuttingDown = false;
  private readonly processWorkspaceBaselines = new Map<string, HostedWorkspaceSnapshot>();

  constructor(private readonly deps: HostedNativeToolBrokerDependencies) {
    this.idGenerator = deps.idGenerator ?? randomUUID;
    this.processes = deps.processSupervisor ?? new HostedNativeProcessSupervisor();
    this.searchText = deps.searchText ?? searchHostedTextInDedicatedWorker;
    this.scratchReady = this.removeStaleScratchDirectories();
    this.tasks = new HostedNativeTaskStore(this.idGenerator);
    this.shutdownDrainMs = Math.max(0, deps.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS);
  }

  async describeApproval(
    ownerId: number,
    request: HostedAiNativeToolRequest
  ): Promise<Omit<DestructiveFileConfirmRequest, 'requestId'>> {
    const definition = getHostedNativeToolDefinition(request.toolName);
    if (!definition) throw new Error('Unknown native tool.');
    const serialized = JSON.stringify(request.input);
    if (!serialized || Buffer.byteLength(serialized) > MAX_INPUT_BYTES) {
      throw new Error('Native tool input is too large.');
    }
    const scope = await this.authorize(ownerId, request);
    await this.scratchReady;
    const scratchRoot = join(
      this.deps.scratchBase,
      hostedNativeScratchSegment(request.turnBindingToken)
    );
    const canonicalScratchRoot = await this.deps.resolveSafeWritablePath(scratchRoot);
    const cwd = scope.workspacePath
      ? await this.resolveScopedPath(scope.workspacePath, [scope.workspacePath])
      : canonicalScratchRoot;
    const allowedRoots = scope.workspacePath ? [cwd, canonicalScratchRoot] : [canonicalScratchRoot];
    const input = pathInputForPolicy(
      definition.name as HostedNativeToolName,
      record(request.input),
      cwd
    );
    validateMutatingInputForApproval(definition.name as HostedNativeToolName, input);
    await this.preflightMutation(
      ownerId,
      request.turnBindingToken,
      definition.name as HostedNativeToolName,
      input,
      allowedRoots
    );
    const description = describeToolCallForConfirmation(definition.name, input, cwd);
    description.conversationId = request.workflowId;
    if (definition.name === 'Write') {
      description.operation = (await exists(requiredString(input, 'file_path', 4096)))
        ? 'Overwrite file'
        : 'Create file';
    } else if (definition.name === 'ProcessStop') {
      description.operation = `Stop background process ${requiredString(input, 'process_id', 256)}`;
      description.risk = 'mutating';
      description.riskSummary = 'This stops the selected background process.';
    }
    return description;
  }

  private async preflightMutation(
    ownerId: number,
    turnBindingToken: string,
    toolName: HostedNativeToolName,
    input: Record<string, unknown>,
    allowedRoots: readonly string[]
  ): Promise<void> {
    switch (toolName) {
      case 'NotebookEdit':
        await this.withRevalidatedWritablePaths(
          [requiredString(input, 'notebook_path', 4096)],
          allowedRoots,
          async ([path]) => {
            await this.rejectSymbolicLeaf(path);
            const notebook = await readHostedNotebook(path);
            const cells = Array.isArray(notebook.cells)
              ? (notebook.cells as Array<Record<string, unknown>>)
              : [];
            const mode = input.edit_mode ?? 'replace';
            const cellId = input.cell_id;
            const cell =
              typeof cellId === 'string'
                ? cells.find((candidate) => candidate.id === cellId)
                : undefined;
            if (typeof cellId === 'string' && !cell) {
              throw new Error('The requested notebook cell was not found.');
            }
            if (
              mode === 'replace' &&
              input.cell_type === undefined &&
              cell?.cell_type !== 'code' &&
              cell?.cell_type !== 'markdown'
            ) {
              throw new Error('NotebookEdit can replace only code or markdown cells.');
            }
          }
        );
        return;
      case 'Write':
        await this.withRevalidatedWritablePaths(
          [requiredString(input, 'file_path', 4096)],
          allowedRoots,
          async ([path]) => {
            const info = await this.lstatIfExists(path);
            if (info && (!info.isFile() || info.isSymbolicLink())) {
              throw new Error('Native Write requires a regular non-symbolic file.');
            }
          }
        );
        return;
      case 'Edit':
        await this.withRevalidatedWritablePaths(
          [requiredString(input, 'file_path', 4096)],
          allowedRoots,
          async ([path]) => {
            const current = await this.readMutableText(path);
            this.applyEdit(
              current,
              requiredString(input, 'old_string', MAX_INPUT_BYTES),
              boundedString(input, 'new_string', MAX_INPUT_BYTES),
              optionalBoolean(input, 'replace_all')
            );
          }
        );
        return;
      case 'MultiEdit':
        await this.withRevalidatedWritablePaths(
          [requiredString(input, 'file_path', 4096)],
          allowedRoots,
          async ([path]) => {
            let current = await this.readMutableText(path);
            for (const rawEdit of input.edits as unknown[]) {
              const edit = record(rawEdit);
              current = this.applyEdit(
                current,
                requiredString(edit, 'old_string', MAX_INPUT_BYTES),
                boundedString(edit, 'new_string', MAX_INPUT_BYTES),
                optionalBoolean(edit, 'replace_all')
              );
            }
          }
        );
        return;
      case 'Move':
        await this.withRevalidatedWritablePaths(
          [
            requiredString(input, 'source_path', 4096),
            requiredString(input, 'destination_path', 4096),
          ],
          allowedRoots,
          async ([source, destination]) => {
            await lstat(source);
            if ((await this.lstatIfExists(destination)) && !optionalBoolean(input, 'overwrite')) {
              throw new Error('The move destination already exists.');
            }
          }
        );
        return;
      case 'Delete':
        await this.withRevalidatedWritablePaths(
          [requiredString(input, 'path', 4096)],
          allowedRoots,
          async ([path]) => {
            await lstat(path);
          }
        );
        return;
      case 'ProcessStop':
        this.processes.status(ownerId, turnBindingToken, requiredString(input, 'process_id', 256));
        return;
      default:
        return;
    }
  }

  async execute(
    ownerId: number,
    request: HostedAiNativeToolRequest
  ): Promise<{ readonly output: unknown; readonly effectReceiptRef: string }> {
    if (
      this.shuttingDown ||
      this.drainingOwners.has(ownerId) ||
      this.drainingTurnBindings.has(request.turnBindingToken)
    ) {
      throw new HostedNativeToolAuthorizationError();
    }
    const definition = getHostedNativeToolDefinition(request.toolName);
    if (!definition) throw new Error('Unknown native tool.');
    if (
      !request.operationId ||
      request.operationId.length > 256 ||
      this.operations.has(request.operationId)
    ) {
      throw new Error('The native operation id is invalid or already active.');
    }
    const serialized = JSON.stringify(request.input);
    if (!serialized || Buffer.byteLength(serialized) > MAX_INPUT_BYTES) {
      throw new Error('Native tool input is too large.');
    }
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.operations.set(request.operationId, {
      ownerId,
      turnBindingToken: request.turnBindingToken,
      controller,
      completion,
    });
    try {
      const scope = await this.authorize(ownerId, request);
      this.turnOwners.set(request.turnBindingToken, ownerId);
      await this.scratchReady;
      const scratchRoot = join(
        this.deps.scratchBase,
        hostedNativeScratchSegment(request.turnBindingToken)
      );
      await mkdir(scratchRoot, { recursive: true });
      const canonicalScratchRoot = await this.deps.resolveSafeWritablePath(scratchRoot);
      const cwd = scope.workspacePath
        ? await this.resolveScopedPath(scope.workspacePath, [scope.workspacePath])
        : canonicalScratchRoot;
      const allowedRoots = scope.workspacePath
        ? [cwd, canonicalScratchRoot]
        : [canonicalScratchRoot];
      assertNotStopped(controller.signal);
      const input = pathInputForPolicy(
        definition.name as HostedNativeToolName,
        record(request.input),
        cwd
      );
      const supervision = request.permissions
        ? dnaforgeSupervision('codex', request.permissions)
        : null;
      const classification = classifyToolCall({
        toolName: definition.name,
        input,
        cwd,
        userRoots: scope.workspacePath ? [cwd] : [],
        scratchRoot: canonicalScratchRoot,
        shellSupervision: request.shellSupervision,
      });
      if (
        !supervision?.skipConfirmations &&
        (classification === 'confirm-destructive-user-file' ||
          classification === 'confirm-shell-command')
      ) {
        const confirmationRequest = describeToolCallForConfirmation(definition.name, input, cwd);
        confirmationRequest.conversationId = request.workflowId;
        const allowed = approvalChoiceAllows(
          await this.deps.confirmDestructiveFile(ownerId, confirmationRequest, controller.signal)
        );
        assertNotStopped(controller.signal);
        if (!allowed) throw new HostedNativeToolDeclinedError();
      }
      assertNotStopped(controller.signal);
      await this.authorize(ownerId, request);
      const isManagedShell = ['Bash', 'ProcessStart', 'ProcessStatus', 'ProcessStop'].includes(
        definition.name
      );
      const processId = boundedIdentity(record(request.input).process_id);
      const before = isManagedShell
        ? processId && this.processWorkspaceBaselines.get(processId)
          ? this.processWorkspaceBaselines.get(processId)!
          : await snapshotHostedWorkspace(cwd)
        : null;
      const rawOutput = await this.dispatch(
        ownerId,
        request.turnBindingToken,
        definition.name as HostedNativeToolName,
        input,
        cwd,
        allowedRoots,
        controller.signal,
        definition.name === 'Write' &&
          (classification === 'confirm-destructive-user-file' ||
            isPathInsideAnyBoundary(canonicalizePath(requiredString(input, 'file_path', 4096)), [
              canonicalScratchRoot,
            ])),
        { workspacePath: scope.workspacePath ? cwd : null, scratchRoot: canonicalScratchRoot }
      );
      const after = before ? await snapshotHostedWorkspace(cwd) : null;
      const output =
        before && after && rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput)
          ? {
              ...(rawOutput as Record<string, unknown>),
              workspace_diff: diffHostedWorkspace(before, after),
            }
          : rawOutput;
      if (definition.name === 'ProcessStart' && rawOutput && typeof rawOutput === 'object') {
        const startedId = boundedIdentity((rawOutput as Record<string, unknown>).process_id);
        if (startedId && before) this.processWorkspaceBaselines.set(startedId, before);
      }
      if ((definition.name === 'ProcessStop' || definition.name === 'ProcessStatus') && processId) {
        const status =
          rawOutput && typeof rawOutput === 'object'
            ? (rawOutput as Record<string, unknown>).status
            : null;
        if (definition.name === 'ProcessStop' || status === 'exited' || status === 'failed') {
          this.processWorkspaceBaselines.delete(processId);
        }
      }
      return {
        output,
        effectReceiptRef: `native:${this.idGenerator()}`,
      };
    } finally {
      resolveCompletion();
      this.operations.delete(request.operationId);
    }
  }

  async cancel(ownerId: number, operationId: string): Promise<boolean> {
    const active = this.operations.get(operationId);
    if (!active || active.ownerId !== ownerId) return false;
    active.controller.abort();
    return true;
  }

  async cancelOwner(ownerId: number): Promise<void> {
    const pending = this.pendingOwnerCleanups.get(ownerId);
    if (pending) return pending;
    this.drainingOwners.add(ownerId);
    const activeOperations = [...this.operations.values()].filter(
      (active) => active.ownerId === ownerId
    );
    const turnBindingTokens = new Set(
      [...this.turnOwners.entries()]
        .filter(([, activeOwnerId]) => activeOwnerId === ownerId)
        .map(([token]) => token)
    );
    for (const active of activeOperations) {
      turnBindingTokens.add(active.turnBindingToken);
      active.controller.abort();
    }
    let processCancellationError: unknown = null;
    try {
      await this.processes.cancelOwner(ownerId);
    } catch (error) {
      processCancellationError = error;
    }
    await Promise.allSettled(activeOperations.map((active) => active.completion));
    if (processCancellationError !== null) {
      const cleanup = Promise.all(
        [...turnBindingTokens].map((token) =>
          this.scheduleTurnCleanupAfterProcessClose(token, activeOperations)
        )
      )
        .then(() => {
          this.tasks.clearOwner(ownerId);
          this.drainingOwners.delete(ownerId);
        })
        .finally(() => {
          this.pendingOwnerCleanups.delete(ownerId);
        });
      this.pendingOwnerCleanups.set(ownerId, cleanup);
      throw processCancellationError;
    }
    this.tasks.clearOwner(ownerId);
    await Promise.all([...turnBindingTokens].map((token) => this.removeScratchDirectory(token)));
    this.drainingOwners.delete(ownerId);
  }

  async cancelTurnBinding(turnBindingToken: string): Promise<void> {
    const pending = this.pendingTurnCleanups.get(turnBindingToken);
    if (pending) return pending;
    this.drainingTurnBindings.add(turnBindingToken);
    const activeOperations = [...this.operations.values()].filter(
      (active) => active.turnBindingToken === turnBindingToken
    );
    for (const active of activeOperations) active.controller.abort();
    let processCancellationError: unknown = null;
    try {
      await this.processes.cancelTurnBinding(turnBindingToken);
    } catch (error) {
      processCancellationError = error;
    }
    await Promise.allSettled(activeOperations.map((active) => active.completion));
    if (processCancellationError !== null) {
      this.scheduleTurnCleanupAfterProcessClose(turnBindingToken, activeOperations);
      throw processCancellationError;
    }
    this.tasks.clearTurnBinding(turnBindingToken);
    await this.removeScratchDirectory(turnBindingToken);
    this.drainingTurnBindings.delete(turnBindingToken);
  }

  waitForTurnBindingCleanup(turnBindingToken: string): Promise<void> {
    return this.pendingTurnCleanups.get(turnBindingToken) ?? Promise.resolve();
  }

  waitForOwnerCleanup(ownerId: number): Promise<void> {
    return this.pendingOwnerCleanups.get(ownerId) ?? Promise.resolve();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const deadlineMs = Date.now() + this.shutdownDrainMs;
    const ownerIds = new Set<number>([
      ...this.turnOwners.values(),
      ...[...this.operations.values()].map((active) => active.ownerId),
    ]);
    await this.waitForShutdownWork(
      Promise.allSettled([...ownerIds].map((ownerId) => this.cancelOwner(ownerId))),
      deadlineMs
    );
    await this.waitForShutdownWork(
      Promise.allSettled([
        ...this.pendingOwnerCleanups.values(),
        ...this.pendingTurnCleanups.values(),
      ]),
      deadlineMs
    );
  }

  private async waitForShutdownWork(work: Promise<unknown>, deadlineMs: number): Promise<void> {
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    if (remainingMs === 0) {
      void work.catch(() => undefined);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work.then(
          () => undefined,
          () => undefined
        ),
        new Promise<void>((resolvePromise) => {
          timer = setTimeout(resolvePromise, remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private scheduleTurnCleanupAfterProcessClose(
    turnBindingToken: string,
    activeOperations: readonly ActiveOperation[]
  ): Promise<void> {
    const existing = this.pendingTurnCleanups.get(turnBindingToken);
    if (existing) return existing;
    const matchingOperations = activeOperations.filter(
      (active) => active.turnBindingToken === turnBindingToken
    );
    const cleanup = Promise.all([
      this.processes.waitForTurnBindingClosed(turnBindingToken),
      Promise.allSettled(matchingOperations.map((active) => active.completion)),
    ])
      .then(async () => {
        this.tasks.clearTurnBinding(turnBindingToken);
        await this.removeScratchDirectory(turnBindingToken);
      })
      .finally(() => {
        this.pendingTurnCleanups.delete(turnBindingToken);
        this.drainingTurnBindings.delete(turnBindingToken);
      });
    this.pendingTurnCleanups.set(turnBindingToken, cleanup);
    return cleanup;
  }

  private async removeStaleScratchDirectories(): Promise<void> {
    const entries = await readdir(this.deps.scratchBase, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^turn-[0-9a-f]{32}$/.test(entry.name))
        .map((entry) =>
          rm(join(this.deps.scratchBase, entry.name), { recursive: true, force: true }).catch(
            () => undefined
          )
        )
    );
  }

  private async removeScratchDirectory(turnBindingToken: string): Promise<void> {
    await this.scratchReady;
    await rm(join(this.deps.scratchBase, hostedNativeScratchSegment(turnBindingToken)), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    this.turnOwners.delete(turnBindingToken);
  }

  private async dispatch(
    ownerId: number,
    token: string,
    toolName: HostedNativeToolName,
    input: Record<string, unknown>,
    cwd: string,
    allowedRoots: readonly string[],
    signal: AbortSignal,
    writeOverwriteAuthorized: boolean,
    shellScope: { workspacePath: string | null; scratchRoot: string }
  ): Promise<unknown> {
    switch (toolName) {
      case 'Read':
        return this.read(input, cwd, allowedRoots, signal);
      case 'LS':
        return this.list(input, cwd, allowedRoots, signal);
      case 'Glob':
        return this.findGlob(input, cwd, allowedRoots, signal);
      case 'Grep':
        return this.grep(input, cwd, allowedRoots, signal);
      case 'WebFetch':
        requiredString(input, 'prompt', 16 * 1024);
        return this.deps.fetchWeb(requiredString(input, 'url', 8192), signal);
      case 'NotebookEdit':
        return this.editNotebook(input, allowedRoots, signal);
      case 'TaskCreate':
        return this.tasks.create(ownerId, token, input);
      case 'TaskGet':
        return this.tasks.get(ownerId, token, input);
      case 'TaskList':
        return this.tasks.list(ownerId, token);
      case 'TaskUpdate':
        return this.tasks.update(ownerId, token, input);
      case 'Write':
        return this.write(input, allowedRoots, signal, writeOverwriteAuthorized);
      case 'Edit':
        return this.edit(input, allowedRoots, signal);
      case 'MultiEdit':
        return this.multiEdit(input, allowedRoots, signal);
      case 'Move':
        return this.move(input, allowedRoots, signal);
      case 'Delete':
        return this.delete(input, allowedRoots, signal);
      case 'Bash':
      case 'ProcessStart': {
        const command = requiredString(input, 'command', 64 * 1024);
        if (!this.deps.prepareShellProcess)
          throw new HostedNativeShellConfinementError(
            'no verified filesystem sandbox was provided'
          );
        let launch: HostedNativeProcessLaunch;
        try {
          launch = await this.deps.prepareShellProcess({ command, cwd, ...shellScope, signal });
        } catch (error) {
          assertNotStopped(signal);
          throw error;
        }
        let handedOff = false;
        try {
          assertNotStopped(signal);
          handedOff = true;
          if (toolName === 'ProcessStart')
            return this.processes.start(ownerId, token, command, cwd, launch);
          return await this.processes.run(
            ownerId,
            token,
            command,
            cwd,
            optionalInteger(
              input,
              'timeout_ms',
              DEFAULT_PROCESS_TIMEOUT_MS,
              100,
              MAX_PROCESS_TIMEOUT_MS
            ),
            signal,
            launch
          );
        } catch (error) {
          if (!handedOff) launch.release();
          if (error instanceof HostedNativeProcessNotStartedError)
            throw new HostedNativeToolStoppedError();
          throw error;
        }
      }
      case 'ProcessStatus':
        return this.processes.status(ownerId, token, requiredString(input, 'process_id', 256));
      case 'ProcessStop':
        return this.processes.stop(ownerId, token, requiredString(input, 'process_id', 256));
    }
  }

  private async authorize(
    ownerId: number,
    request: HostedAiNativeToolRequest
  ): Promise<HostedNativeTurnScope> {
    try {
      return await this.deps.authorizeTurn(ownerId, bindingRequest(request));
    } catch {
      throw new HostedNativeToolAuthorizationError();
    }
  }

  private async read(
    input: Record<string, unknown>,
    cwd: string,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const path = await this.resolveScopedPath(
      relativeOrAbsolute(requiredString(input, 'file_path', 4096), cwd),
      allowedRoots
    );
    if (path.toLowerCase().endsWith('.ipynb')) {
      assertNotStopped(signal);
      return readHostedNotebook(path);
    }
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error('The requested file is too large.');
    assertNotStopped(signal);
    const content = await readFile(path, 'utf8');
    const lines = content.split('\n');
    const offset = optionalInteger(input, 'offset', 0, 0, 1_000_000);
    const limit = optionalInteger(input, 'limit', DEFAULT_LINE_LIMIT, 1, 5_000);
    return {
      path,
      content: lines.slice(offset, offset + limit).join('\n'),
      start_line: offset + 1,
      total_lines: lines.length,
      truncated: offset + limit < lines.length,
    };
  }

  private async list(
    input: Record<string, unknown>,
    cwd: string,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const raw =
      input.path === undefined || input.path === null ? cwd : requiredString(input, 'path', 4096);
    const root = await this.resolveScopedPath(relativeOrAbsolute(raw, cwd), allowedRoots);
    const depth = optionalInteger(input, 'depth', 1, 1, 8);
    const entries: Array<{ path: string; type: 'file' | 'directory' | 'other' }> = [];
    const visit = async (directory: string, remaining: number): Promise<void> => {
      assertNotStopped(signal);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entries.length >= MAX_DIRECTORY_ENTRIES) return;
        const path = join(directory, entry.name);
        entries.push({
          path,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        });
        if (entry.isDirectory() && !entry.isSymbolicLink() && remaining > 1) {
          await visit(path, remaining - 1);
        }
      }
    };
    await visit(root, depth);
    return { root, entries, truncated: entries.length >= MAX_DIRECTORY_ENTRIES };
  }

  private async findGlob(
    input: Record<string, unknown>,
    cwd: string,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const pattern = requiredString(input, 'pattern', 1024);
    if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
      throw new Error('Glob patterns must stay inside the selected search root.');
    }
    const raw =
      input.path === undefined || input.path === null ? cwd : requiredString(input, 'path', 4096);
    const root = await this.resolveScopedPath(relativeOrAbsolute(raw, cwd), allowedRoots);
    const limit = optionalInteger(input, 'limit', DEFAULT_PATH_LIMIT, 1, 2_000);
    assertNotStopped(signal);
    const matches = await glob(pattern, {
      cwd: root,
      absolute: true,
      dot: true,
      follow: false,
      nodir: false,
      ignore: ['**/.git/**', '**/node_modules/**'],
    });
    assertNotStopped(signal);
    const safeMatches: string[] = [];
    for (const match of matches.slice(0, limit))
      safeMatches.push(await this.resolveScopedPath(match, allowedRoots));
    return { root, matches: safeMatches, truncated: matches.length > limit };
  }

  private async grep(
    input: Record<string, unknown>,
    cwd: string,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const source = requiredString(input, 'pattern', 256);
    const raw =
      input.path === undefined || input.path === null ? cwd : requiredString(input, 'path', 4096);
    const root = await this.resolveScopedPath(relativeOrAbsolute(raw, cwd), allowedRoots);
    const filePattern =
      input.glob === undefined || input.glob === null
        ? '**/*'
        : requiredString(input, 'glob', 1024);
    if (isAbsolute(filePattern) || filePattern.split(/[\\/]+/).includes('..')) {
      throw new Error('Grep file patterns must stay inside the selected search root.');
    }
    const limit = optionalInteger(input, 'limit', DEFAULT_LINE_LIMIT, 1, 2_000);
    const files = (
      await glob(filePattern, {
        cwd: root,
        absolute: true,
        dot: true,
        follow: false,
        nodir: true,
        ignore: ['**/.git/**', '**/node_modules/**'],
      })
    ).sort((left, right) => left.localeCompare(right));
    const searchableFiles: Array<{ path: string; content: string }> = [];
    let readBytes = 0;
    for (const candidate of files.slice(0, MAX_DIRECTORY_ENTRIES)) {
      assertNotStopped(signal);
      const path = await this.resolveScopedPath(candidate, allowedRoots);
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES || readBytes + info.size > MAX_SEARCH_BYTES)
        continue;
      readBytes += info.size;
      const content = await readFile(path, 'utf8').catch(() => null);
      if (content === null || content.includes('\0')) continue;
      searchableFiles.push({ path, content });
    }
    try {
      const result = await this.searchText(
        {
          source,
          caseSensitive: optionalBoolean(input, 'case_sensitive'),
          limit,
          files: searchableFiles,
        },
        { signal }
      );
      return { root, ...result };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new HostedNativeToolStoppedError();
      }
      throw error;
    }
  }

  private async write(
    input: Record<string, unknown>,
    allowedRoots: readonly string[],
    signal: AbortSignal,
    overwriteAuthorized: boolean
  ) {
    const requestedPath = requiredString(input, 'file_path', 4096);
    const content = boundedString(input, 'content', MAX_INPUT_BYTES);
    return this.withRevalidatedWritablePaths([requestedPath], allowedRoots, async ([path]) => {
      assertNotStopped(signal);
      await mkdir(dirname(path), { recursive: true });
      await this.rejectSymbolicLeaf(path);
      let handle: FileHandle | undefined;
      let preWriteExisted = false;
      let createdByThisWrite = false;
      try {
        if (overwriteAuthorized && (await exists(path))) {
          const preWriteStatus = await lstat(path);
          if (!preWriteStatus.isFile() || preWriteStatus.isSymbolicLink()) {
            throw new Error('Native Write requires a regular non-symbolic file.');
          }
          handle = await open(path, 'r+');
          const openedStatus = await handle.stat();
          if (!openedStatus.isFile() || !sameFileIdentity(preWriteStatus, openedStatus)) {
            throw new Error('The native tool path changed after approval.');
          }
          preWriteExisted = true;
        } else {
          handle = await open(path, 'wx+');
          createdByThisWrite = true;
        }

        await handle.truncate(0);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        const openedStatus = await handle.stat();
        const pathStatusBeforeRead = await lstat(path);
        if (
          !openedStatus.isFile() ||
          !pathStatusBeforeRead.isFile() ||
          pathStatusBeforeRead.isSymbolicLink() ||
          !sameFileIdentity(openedStatus, pathStatusBeforeRead)
        ) {
          throw new Error('Native Write readback path changed before observation.');
        }
        const observedBytes = Buffer.alloc(openedStatus.size);
        let offset = 0;
        while (offset < observedBytes.byteLength) {
          const { bytesRead } = await handle.read(
            observedBytes,
            offset,
            observedBytes.byteLength - offset,
            offset
          );
          if (bytesRead === 0) throw new Error('Native Write readback ended early.');
          offset += bytesRead;
        }
        const pathStatusAfterRead = await lstat(path);
        if (
          !pathStatusAfterRead.isFile() ||
          pathStatusAfterRead.isSymbolicLink() ||
          !sameFileIdentity(openedStatus, pathStatusAfterRead)
        ) {
          throw new Error('Native Write readback path changed during observation.');
        }
        return {
          path,
          bytes_written: Buffer.byteLength(content),
          pre_write_existed: preWriteExisted,
          created: !preWriteExisted,
          observed_byte_count: observedBytes.byteLength,
          observed_content_sha256: createHash('sha256').update(observedBytes).digest('hex'),
        };
      } catch (error) {
        const ownedStatus = createdByThisWrite ? await handle?.stat().catch(() => null) : null;
        await handle?.close().catch(() => undefined);
        handle = undefined;
        if (ownedStatus) {
          const currentStatus = await lstat(path).catch(() => null);
          if (currentStatus && sameFileIdentity(ownedStatus, currentStatus)) {
            await unlink(path).catch(() => undefined);
          }
        }
        throw error;
      } finally {
        await handle?.close();
      }
    });
  }

  private async editNotebook(
    input: Record<string, unknown>,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const requestedPath = requiredString(input, 'notebook_path', 4096);
    return this.withRevalidatedWritablePaths([requestedPath], allowedRoots, async ([path]) => {
      await this.rejectSymbolicLeaf(path);
      assertNotStopped(signal);
      return editHostedNotebook({
        path,
        cellId: input.cell_id,
        newSource: input.new_source,
        cellType: input.cell_type,
        editMode: input.edit_mode,
        generateId: this.idGenerator,
        signal,
        assertNotStopped,
      });
    });
  }

  private async edit(
    input: Record<string, unknown>,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const requestedPath = requiredString(input, 'file_path', 4096);
    return this.withRevalidatedWritablePaths([requestedPath], allowedRoots, async ([path]) => {
      const current = await this.readMutableText(path);
      const oldText = requiredString(input, 'old_string', MAX_INPUT_BYTES);
      const replaceAll = optionalBoolean(input, 'replace_all');
      const updated = this.applyEdit(
        current,
        oldText,
        boundedString(input, 'new_string', MAX_INPUT_BYTES),
        replaceAll
      );
      assertNotStopped(signal);
      await this.rejectSymbolicLeaf(path);
      await writeFile(path, updated, 'utf8');
      return {
        path,
        replacements: replaceAll ? current.split(oldText).length - 1 : 1,
      };
    });
  }

  private async multiEdit(
    input: Record<string, unknown>,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const requestedPath = requiredString(input, 'file_path', 4096);
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > 100) {
      throw new Error('Native tool input edits is invalid.');
    }
    return this.withRevalidatedWritablePaths([requestedPath], allowedRoots, async ([path]) => {
      let updated = await this.readMutableText(path);
      for (const rawEdit of edits) {
        const edit = record(rawEdit);
        updated = this.applyEdit(
          updated,
          requiredString(edit, 'old_string', MAX_INPUT_BYTES),
          boundedString(edit, 'new_string', MAX_INPUT_BYTES),
          optionalBoolean(edit, 'replace_all')
        );
      }
      assertNotStopped(signal);
      await this.rejectSymbolicLeaf(path);
      await writeFile(path, updated, 'utf8');
      return { path, edits_applied: edits.length };
    });
  }

  private async move(
    input: Record<string, unknown>,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const requestedSource = requiredString(input, 'source_path', 4096);
    const requestedDestination = requiredString(input, 'destination_path', 4096);
    return this.withRevalidatedWritablePaths(
      [requestedSource, requestedDestination],
      allowedRoots,
      async ([source, destination]) => {
        assertNotStopped(signal);
        if (await exists(destination)) {
          if (!optionalBoolean(input, 'overwrite'))
            throw new Error('The move destination already exists.');
          await this.deps.trashPath(destination);
        }
        await mkdir(dirname(destination), { recursive: true });
        await rename(source, destination);
        return { source_path: source, destination_path: destination };
      }
    );
  }

  private async delete(
    input: Record<string, unknown>,
    allowedRoots: readonly string[],
    signal: AbortSignal
  ) {
    const requestedPath = requiredString(input, 'path', 4096);
    return this.withRevalidatedWritablePaths([requestedPath], allowedRoots, async ([path]) => {
      assertNotStopped(signal);
      await this.deps.trashPath(path);
      return { path, trashed: true };
    });
  }

  private async withRevalidatedWritablePaths<T>(
    requestedPaths: readonly string[],
    allowedRoots: readonly string[],
    operation: (paths: readonly string[]) => Promise<T>
  ): Promise<T> {
    return this.deps.withSafeWritablePaths(requestedPaths, async (actualPaths) => {
      if (actualPaths.length !== requestedPaths.length) {
        throw new Error('The native writable-path lease returned an invalid path set.');
      }
      actualPaths.forEach((actual, index) => {
        if (canonicalizePath(actual) !== canonicalizePath(requestedPaths[index])) {
          throw new Error('The native tool path changed after approval.');
        }
        this.assertInsideTurnScope(actual, allowedRoots);
      });
      return operation(actualPaths);
    });
  }

  private async revalidateWritablePath(
    path: string,
    allowedRoots: readonly string[]
  ): Promise<string> {
    const expected = canonicalizePath(path);
    const actual = await this.deps.resolveSafeWritablePath(path);
    if (canonicalizePath(actual) !== expected)
      throw new Error('The native tool path changed after approval.');
    this.assertInsideTurnScope(actual, allowedRoots);
    return actual;
  }

  private async resolveScopedPath(path: string, allowedRoots: readonly string[]): Promise<string> {
    const resolved = await this.deps.resolveSafePath(path);
    this.assertInsideTurnScope(resolved, allowedRoots);
    return resolved;
  }

  private assertInsideTurnScope(path: string, allowedRoots: readonly string[]): void {
    if (!isPathInsideAnyBoundary(canonicalizePath(path), allowedRoots.map(canonicalizePath))) {
      throw new Error('Native tool paths must stay inside the bound workspace or turn scratch.');
    }
  }

  private async rejectSymbolicLeaf(path: string): Promise<void> {
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error('Refusing to write through a symbolic link.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readMutableText(path: string): Promise<string> {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error('The requested file is too large.');
    return readFile(path, 'utf8');
  }

  private applyEdit(
    current: string,
    oldText: string,
    newText: string,
    replaceAll: boolean
  ): string {
    if (!oldText) throw new Error('Edit old_string cannot be empty.');
    const first = current.indexOf(oldText);
    if (first < 0) throw new Error('Edit old_string was not found exactly.');
    if (!replaceAll && current.indexOf(oldText, first + oldText.length) >= 0) {
      throw new Error('Edit old_string is not unique. Set replace_all or provide more context.');
    }
    return replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
  }
}

export function isHostedNativeToolMutation(name: string): boolean {
  return getHostedNativeToolDefinition(name)?.effects.includes('mutating') ?? false;
}

export function isHostedNativeProcessResult(value: unknown): value is HostedNativeProcessResult {
  return Boolean(value && typeof value === 'object' && 'process_id' in value && 'status' in value);
}
