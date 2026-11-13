import { ipcMain, ipcRenderer } from 'electron';
import {
  isUserMessagePayload,
  renderUserMessagePayload,
  userMessagePayloadFromError,
  withUserMessage,
  UserMessageError,
} from '@waypoint/user-messages';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import type {
  AgentConfirmResponseChannel,
  AgentUserInputResponse,
  AgentUserInputResponseChannel,
  DestructiveFileConfirmResponse,
} from './agent-confirm-types';
import type { ComputeJobTerminalEvent } from './compute-jobs-ipc';
import type { HostedAiStreamEventEnvelope } from './hosted-ai-gateway-ipc';
import type {
  RendererResourceReadResponseShape,
  RendererToolCallResponseShape,
} from './agent-tools-ipc';
import type { GenomeSessionUpdate } from './indexed-genome';
import type {
  ReferenceAssetHostedInstallProgressV1,
  ReferenceAssetPreparationProgressV1,
} from './reference-assets-ipc';
import type {
  LargeFileImportDialogResponse,
  LargeFileImportDialogResponseChannel,
} from './large-file-import-dialog';
import type {
  WorkspaceSyncReplicaDeliveryAck,
  WorkspaceSyncReplicaLifecycleEvent,
  WorkspaceSyncStatusEvent,
} from './workspace-sync-ipc';
import type { UpdateEventPayloadMap } from './update-ipc';
import type {
  WorkspaceRendererMutationEvent,
  WorkspaceRendererMutationAck,
} from './workspace-renderer-mutation';
import type { BenchlingMigrationProgressEvent } from './benchling-migration-ipc';
import type {
  BenchlingMigrationRenderValidationResponseChannel,
  MigrationRenderValidationRequest,
  MigrationRenderValidationResponse,
} from './benchling-migration-render-validation';
import type { InvokeContract } from './ipc-invoke-contract.generated';
import type { RemoteGenomicsStatusDeliveryV1 } from './remote-genomics-ipc';
import type {
  StaticIpcChannel,
  StaticInvokeChannel,
  StaticMainSendChannel,
  StaticRendererSendChannel,
} from './ipc-channel-catalog.generated';
import { contractEntries } from './ipc/contract';
import type {
  AnyContractGroup,
  ClientOf,
  ConditionalMethodsOf,
  ContractEventMap,
  ContractInvokeMap,
  ContractReplyChannel,
  ContractSendMap,
  HandlersOf,
  ReplyArgsOf,
  ReplyMethodsOf,
} from './ipc/contract';
import type { IpcContracts } from './ipc/contracts';

export type AgentToolResponseChannel = `agent-tools:response:${string}`;
export type AgentToolResourceResponseChannel = `agent-tools:resource-response:${string}`;
export type DynamicIpcChannel =
  | AgentToolResponseChannel
  | AgentToolResourceResponseChannel
  | AgentConfirmResponseChannel
  | AgentUserInputResponseChannel
  | LargeFileImportDialogResponseChannel
  | BenchlingMigrationRenderValidationResponseChannel;
type ContractEventChannel = keyof ContractEventMap<IpcContracts>;
type ContractChannel =
  | keyof ContractInvokeMap<IpcContracts>
  | keyof ContractSendMap<IpcContracts>
  | ContractEventChannel
  | ContractReplyChannel<IpcContracts>;
export type IpcChannel = StaticIpcChannel | DynamicIpcChannel | ContractChannel;

export function agentToolResponseChannel(requestId: string): AgentToolResponseChannel {
  return `agent-tools:response:${requestId}`;
}

export function agentToolResourceResponseChannel(
  requestId: string
): AgentToolResourceResponseChannel {
  return `agent-tools:resource-response:${requestId}`;
}

interface EventEntry<Args extends unknown[]> {
  args: Args;
}

export interface RendererSendContract {
  'benchling-migration:render-validation-ready': EventEntry<[ready: boolean]>;
  'diagnostics:renderer-error': EventEntry<
    [payload: { errorClass: string; source: 'error' | 'unhandledrejection' }]
  >;
  'diagnostics:breadcrumbs': EventEntry<[lines: string[]]>;
  'app:saveAllDone': EventEntry<[requestId: string]>;
  'cloudSync:replicaAppliedAck': EventEntry<[ack: WorkspaceSyncReplicaDeliveryAck]>;
  'workspace:mutationAck': EventEntry<[ack: WorkspaceRendererMutationAck]>;
  'workspace:set-path-listener-ready': EventEntry<[]>;
}

export interface MainSendContract {
  'app:saveAll': EventEntry<[requestId: string]>;
  'remoteGenomics:statusChanged': EventEntry<[delivery: RemoteGenomicsStatusDeliveryV1]>;
  'benchling-migration:render-validation-request': EventEntry<
    [request: MigrationRenderValidationRequest]
  >;
  'benchlingMigration:progressChanged': EventEntry<[payload: BenchlingMigrationProgressEvent]>;
  'cloudSync:statusChanged': EventEntry<[event: WorkspaceSyncStatusEvent]>;
  'cloudSync:replicaApplied': EventEntry<[event: WorkspaceSyncReplicaLifecycleEvent]>;
  'workspace:mutation': EventEntry<[event: WorkspaceRendererMutationEvent]>;
  'compute:jobTerminal': EventEntry<[event: ComputeJobTerminalEvent]>;
  'file-changed': EventEntry<[path: string]>;
  'genome:sessionUpdated': EventEntry<[update: GenomeSessionUpdate]>;
  'hostedAi:streamEvent': EventEntry<[envelope: HostedAiStreamEventEnvelope]>;
  'menu:check-for-updates': EventEntry<[]>;
  'menu:close-tab': EventEntry<[]>;
  'menu:explorer': EventEntry<[]>;
  'menu:import-files': EventEntry<[]>;
  'menu:import-folder': EventEntry<[]>;
  'menu:import-registry-records': EventEntry<[]>;
  'menu:new-chat': EventEntry<[]>;
  'menu:organizations': EventEntry<[]>;
  'menu:reopen-closed-tab': EventEntry<[]>;
  'menu:redo': EventEntry<[]>;
  'menu:search': EventEntry<[]>;
  'menu:settings': EventEntry<[]>;
  'menu:undo': EventEntry<[]>;
  'referenceAssets:hostedInstallProgress': EventEntry<
    [progress: ReferenceAssetHostedInstallProgressV1]
  >;
  'referenceAssets:preparationProgress': EventEntry<
    [progress: ReferenceAssetPreparationProgressV1]
  >;
  'sidecar:status': EventEntry<
    [status: 'starting' | 'ready' | 'stopped' | 'error' | 'timeout' | 'restarting']
  >;
  'update:available': EventEntry<[payload: UpdateEventPayloadMap['update:available']]>;
  'update:downloaded': EventEntry<[payload: UpdateEventPayloadMap['update:downloaded']]>;
  'update:error': EventEntry<[payload: UpdateEventPayloadMap['update:error']]>;
  'update:no-update': EventEntry<[payload: UpdateEventPayloadMap['update:no-update']]>;
  'update:progress': EventEntry<[payload: UpdateEventPayloadMap['update:progress']]>;
  'window:resize': EventEntry<[]>;
  'window:move': EventEntry<[]>;
  'workspace:set-path': EventEntry<
    [workspacePath: string, deliveryId: string, telemetryContext?: 'managed_sync']
  >;
}

export interface DynamicContract {
  'agent-tools:response': {
    channel: AgentToolResponseChannel;
    direction: 'renderer-to-main';
    args: [response: RendererToolCallResponseShape];
  };
  'agent-tools:resource-response': {
    channel: AgentToolResourceResponseChannel;
    direction: 'renderer-to-main';
    args: [response: RendererResourceReadResponseShape];
  };
  'agent:confirm-destructive-file:response': {
    channel: AgentConfirmResponseChannel;
    direction: 'renderer-to-main';
    args: [response: DestructiveFileConfirmResponse];
  };
  'agent:user-input:response': {
    channel: AgentUserInputResponseChannel;
    direction: 'renderer-to-main';
    args: [response: AgentUserInputResponse];
  };
  'workspace:large-file-import-response': {
    channel: LargeFileImportDialogResponseChannel;
    direction: 'renderer-to-main';
    args: [response: LargeFileImportDialogResponse];
  };
  'benchling-migration:render-validation-response': {
    channel: BenchlingMigrationRenderValidationResponseChannel;
    direction: 'renderer-to-main';
    args: [response: MigrationRenderValidationResponse];
  };
}

type MaybePromise<T> = T | Promise<T>;
type MainInvokeListener = Parameters<typeof ipcMain.handle>[1];
type RendererEvent = Parameters<Parameters<typeof ipcRenderer.on>[1]>[0];

type AssertNever<T extends never> = T;
type _MissingInvokeContracts = AssertNever<Exclude<StaticInvokeChannel, keyof InvokeContract>>;
type _ExtraInvokeContracts = AssertNever<Exclude<keyof InvokeContract, StaticInvokeChannel>>;
type _MissingRendererSendContracts = AssertNever<
  Exclude<StaticRendererSendChannel, keyof RendererSendContract>
>;
type _ExtraRendererSendContracts = AssertNever<
  Exclude<keyof RendererSendContract, StaticRendererSendChannel>
>;
type _MissingMainSendContracts = AssertNever<
  Exclude<StaticMainSendChannel, keyof MainSendContract>
>;
type _ExtraMainSendContracts = AssertNever<Exclude<keyof MainSendContract, StaticMainSendChannel>>;
type _ContractChannelsDisjoint = AssertNever<Extract<ContractChannel, StaticIpcChannel>>;
type StaticInvokeEntry<C extends StaticInvokeChannel> = InvokeContract[C];
export type StaticInvokeArguments<C extends StaticInvokeChannel> = StaticInvokeEntry<C>['args'];
export type StaticInvokeResult<C extends StaticInvokeChannel> = StaticInvokeEntry<C>['result'];
type DynamicRendererSendEntry<C extends DynamicIpcChannel> =
  C extends DynamicContract['agent-tools:response']['channel']
    ? DynamicContract['agent-tools:response']
    : C extends DynamicContract['agent-tools:resource-response']['channel']
      ? DynamicContract['agent-tools:resource-response']
      : C extends DynamicContract['agent:confirm-destructive-file:response']['channel']
        ? DynamicContract['agent:confirm-destructive-file:response']
        : C extends DynamicContract['agent:user-input:response']['channel']
          ? DynamicContract['agent:user-input:response']
          : C extends DynamicContract['workspace:large-file-import-response']['channel']
            ? DynamicContract['workspace:large-file-import-response']
            : C extends DynamicContract['benchling-migration:render-validation-response']['channel']
              ? DynamicContract['benchling-migration:render-validation-response']
              : never;
type RendererSendChannel = StaticRendererSendChannel | DynamicIpcChannel;
type RendererSendEntryFor<C extends RendererSendChannel> = C extends DynamicIpcChannel
  ? DynamicRendererSendEntry<C>
  : RendererSendContract[Extract<C, StaticRendererSendChannel>];
type MainSendEntryFor<C extends StaticMainSendChannel> = MainSendContract[C];

export type MainSendChannel = StaticMainSendChannel;
export type MainSendArguments<C extends MainSendChannel> = MainSendEntryFor<C>['args'];
export type GenericMainSendChannel = Extract<
  MainSendChannel,
  | 'sidecar:status'
  | 'menu:settings'
  | 'menu:organizations'
  | 'menu:new-chat'
  | 'menu:explorer'
  | 'menu:search'
  | 'window:resize'
  | 'window:move'
  | 'compute:jobTerminal'
  | 'file-changed'
  | 'workspace:set-path'
  | 'update:available'
  | 'update:downloaded'
  | 'update:progress'
  | 'update:error'
  | 'update:no-update'
  | 'menu:check-for-updates'
  | 'menu:close-tab'
  | 'menu:reopen-closed-tab'
  | 'menu:redo'
  | 'menu:import-files'
  | 'menu:import-folder'
  | 'menu:import-registry-records'
  | 'menu:undo'
  | 'app:saveAll'
  | 'genome:sessionUpdated'
>;

type BivariantInvokeListener<Args extends unknown[], Result> = {
  bivarianceHack(event: IpcMainInvokeEvent, ...args: Args): MaybePromise<Result>;
}['bivarianceHack'];
type BivariantMainListener<Args extends unknown[]> = {
  bivarianceHack(event: IpcMainEvent, ...args: Args): void;
}['bivarianceHack'];
type BivariantRendererListener<Args extends unknown[]> = {
  bivarianceHack(event: RendererEvent, ...args: Args): void;
}['bivarianceHack'];

function handleIpc<C extends StaticInvokeChannel>(
  channel: C,
  listener: BivariantInvokeListener<
    StaticInvokeEntry<NoInfer<C>>['args'],
    InvokeContract[NoInfer<C>]['result']
  >
): void {
  ipcMain.handle(channel, listener as MainInvokeListener);
}

function invokeIpc<C extends StaticInvokeChannel>(
  channel: C,
  ...args: StaticInvokeEntry<NoInfer<C>>['args']
): Promise<StaticInvokeEntry<NoInfer<C>>['result']> {
  return ipcRenderer.invoke(channel, ...args) as Promise<StaticInvokeEntry<NoInfer<C>>['result']>;
}

export const mainIpc = Object.freeze({
  handle: handleIpc,
  on: <C extends RendererSendChannel>(
    channel: C,
    listener: BivariantMainListener<RendererSendEntryFor<NoInfer<C>>['args']>
  ): typeof ipcMain => ipcMain.on(channel, listener),
  once: <C extends RendererSendChannel>(
    channel: C,
    listener: BivariantMainListener<RendererSendEntryFor<NoInfer<C>>['args']>
  ): typeof ipcMain => ipcMain.once(channel, listener),
  removeHandler: (channel: StaticInvokeChannel): void => ipcMain.removeHandler?.(channel),
  removeListener: <C extends RendererSendChannel>(
    channel: C,
    listener: BivariantMainListener<RendererSendEntryFor<NoInfer<C>>['args']>
  ): typeof ipcMain => ipcMain.removeListener?.(channel, listener) ?? ipcMain,
  removeAllListeners: (channel?: IpcChannel): typeof ipcMain =>
    ipcMain.removeAllListeners?.(channel) ?? ipcMain,
});

export const rendererIpc = Object.freeze({
  invoke: invokeIpc,
  send: <C extends RendererSendChannel>(
    channel: C,
    ...args: RendererSendEntryFor<NoInfer<C>>['args']
  ): void => ipcRenderer.send(channel, ...args),
  on: <C extends StaticMainSendChannel>(
    channel: C,
    listener: BivariantRendererListener<MainSendEntryFor<NoInfer<C>>['args']>
  ): typeof ipcRenderer => ipcRenderer.on(channel, listener),
  removeListener: <C extends StaticMainSendChannel>(
    channel: C,
    listener: BivariantRendererListener<MainSendEntryFor<NoInfer<C>>['args']>
  ): typeof ipcRenderer => ipcRenderer.removeListener?.(channel, listener) ?? ipcRenderer,
});

type RendererTarget = Pick<WebContents, 'send'> | IpcMainEvent['sender'];

export function sendRendererIpc<C extends StaticMainSendChannel>(
  target: RendererTarget,
  channel: C,
  ...args: MainSendEntryFor<NoInfer<C>>['args']
): void;
export function sendRendererIpc<C extends ContractEventChannel>(
  target: RendererTarget,
  channel: C,
  ...args: ContractEventMap<IpcContracts>[NoInfer<C>]['args']
): void;
export function sendRendererIpc(target: RendererTarget, channel: string, ...args: unknown[]): void {
  target.send(channel, ...args);
}

export type MainHandlersOf<C extends AnyContractGroup> = HandlersOf<
  C,
  IpcMainInvokeEvent,
  IpcMainEvent
>;
type MainListener = Parameters<typeof ipcMain.on>[1];

export function handleGroup<C extends AnyContractGroup>(
  contract: C,
  handlers: MainHandlersOf<NoInfer<C>>
): () => void {
  const table = handlers as Readonly<Record<string, MainInvokeListener | null | undefined>>;
  const disposers: Array<() => void> = [];
  for (const { method, kind, channel } of contractEntries(contract)) {
    const handler = table[method];
    if (!handler) continue;
    if (kind === 'invoke') {
      ipcMain.handle(channel, async (...args) => {
        try {
          return await handler(...args);
        } catch (failure) {
          const payload = userMessagePayloadFromError(failure);
          if (!payload) throw failure;
          console.error(`[IPC ${channel}]`, failure);
          return { __waypointUserMessageFailure: payload };
        }
      });
      disposers.push(() => ipcMain.removeHandler(channel));
    } else if (kind === 'send') {
      const listener: MainListener = handler;
      ipcMain.on(channel, listener);
      disposers.push(() => ipcMain.removeListener(channel, listener));
    }
  }
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}

export interface AwaitReplyOptions<Args extends unknown[]> {
  readonly requestId: string;
  readonly sender: Pick<WebContents, 'id'>;
  readonly timeoutMs: number;
  readonly onReply: (...args: Args) => void;
  readonly onTimeout: () => void;
}

export function awaitReply<C extends AnyContractGroup, K extends ReplyMethodsOf<C>>(
  contract: C,
  method: K,
  options: AwaitReplyOptions<ReplyArgsOf<C, K>>
): () => void {
  const entry = contractEntries(contract).find((candidate) => candidate.method === method);
  if (entry?.kind !== 'reply') throw new Error(`${contract.name}.${method} is not a reply method`);
  const channel = `${entry.channel}${options.requestId}`;
  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    clearTimeout(deadline);
    ipcMain.removeListener(channel, listener);
    return true;
  };
  const listener = (event: IpcMainEvent, ...args: ReplyArgsOf<C, K>) => {
    if (event.sender?.id !== options.sender.id) return;
    if (settle()) options.onReply(...args);
  };
  const deadline = setTimeout(() => {
    if (settle()) options.onTimeout();
  }, options.timeoutMs);
  ipcMain.on(channel, listener);
  return () => {
    settle();
  };
}

type ClientOptions<C extends AnyContractGroup> = [ConditionalMethodsOf<C>] extends [never]
  ? []
  : [
      options: {
        readonly include: { readonly [K in ConditionalMethodsOf<C>]: boolean };
      },
    ];

export function createClient<C extends AnyContractGroup>(
  contract: C,
  ...options: ClientOptions<C>
): ClientOf<C> {
  const include: Readonly<Record<string, boolean>> = options[0]?.include ?? {};
  const client: Record<string, unknown> = {};
  const invoke = async (channel: string, args: unknown[]) => {
    const value: unknown = await ipcRenderer.invoke(channel, ...args);
    if (value && typeof value === 'object' && '__waypointUserMessageFailure' in value) {
      const payload = value.__waypointUserMessageFailure;
      if (!isUserMessagePayload(payload)) throw new UserMessageError('operation.failed');
      throw withUserMessage(new Error(renderUserMessagePayload(payload)), payload);
    }
    return value;
  };
  for (const entry of contractEntries(contract)) {
    const { method, channel } = entry;
    if (entry.conditional && include[method] !== true) continue;
    if (entry.kind === 'invoke') {
      const fallback = entry.defaultArgument;
      client[method] = fallback
        ? (...args: unknown[]) => {
            args[fallback.position] ??= fallback.value;
            return invoke(channel, args);
          }
        : (...args: unknown[]) => invoke(channel, args);
    } else if (entry.kind === 'send') {
      client[method] = (...args: unknown[]) => ipcRenderer.send(channel, ...args);
    } else if (entry.kind === 'reply') {
      client[method] = (requestId: string, ...args: unknown[]) =>
        ipcRenderer.send(`${channel}${requestId}`, ...args);
    } else {
      const project = entry.project;
      client[method] = (callback: (...delivered: unknown[]) => void) => {
        const listener = project
          ? (_event: RendererEvent, ...args: unknown[]) => callback(project(...args))
          : (_event: RendererEvent, ...args: unknown[]) => callback(...args);
        ipcRenderer.on(channel, listener);
        return () => {
          ipcRenderer.removeListener(channel, listener);
        };
      };
    }
  }
  return Object.freeze(client) as ClientOf<C>;
}
