import type { TerminalRuntimePolicy } from '../terminal-runtime-policy';
import type { TerminalCompletionResult } from '../terminal-completion';
import type { TerminalPortRelease } from '../terminal-quick-fix';
import type {
  TerminalAttachment,
  TerminalCreateRequest,
  TerminalFixedDimensions,
  TerminalProfile,
  TerminalSession,
  TerminalEvent,
} from '../terminal-ipc';
import { defineGroup, invoke, event } from './contract';

export const terminalContract = defineGroup('terminal', {
  runtimePolicy: invoke<[], TerminalRuntimePolicy>(),
  configureRuntimePolicy: invoke<[policy: TerminalRuntimePolicy], TerminalRuntimePolicy>(),
  closeStatus: invoke<[id: string], { requiresConfirmation: boolean }>(),
  complete: invoke<[id: string, requestId: string], TerminalCompletionResult>(),
  cancelCompletions: invoke<[requestId: string], void>(),
  commitCompletion: invoke<[id: string, token: string], boolean>(),
  preparePortRelease: invoke<[id: string, commandId: string, port: number], TerminalPortRelease>(),
  releasePort: invoke<[id: string, token: string], void>(),
  profileConfiguration: invoke<[], import('../terminal-ipc').TerminalProfilesConfiguration>(),
  configureProfiles: invoke<
    [configuration: import('../terminal-ipc').TerminalProfilesConfiguration],
    void
  >(),
  profiles: invoke<[], TerminalProfile[]>(),
  list: invoke<[], TerminalSession[]>(),
  history: invoke<[id: string], import('../terminal-ipc').TerminalHistoryData>(),
  commandOutput: invoke<[id: string, commandId: string], string | undefined>(),
  create: invoke<[request: TerminalCreateRequest], TerminalSession>(),
  relaunch: invoke<[id: string], TerminalSession>(),
  clear: invoke<[id: string], void>(),
  setFixedDimensions: invoke<[id: string, dimensions: TerminalFixedDimensions], void>(),
  moveToWindow: invoke<[ids: string[], groupId: string], void>(),
  returnToMainWindow: invoke<[], void>(),
  attach: invoke<[id: string], TerminalAttachment>(),
  detach: invoke<[id: string, attachmentId: string], void>(),
  write: invoke<[id: string, data: string, mode?: 'text' | 'binary'], void>(),
  commitPaste: invoke<[id: string, token: string], boolean>(),
  confirmPaste: invoke<[id: string, token: string, accept: boolean], void>(),
  findFiles: invoke<
    [id: string, request: import('../terminal-ipc').TerminalFileSearchRequest],
    import('../terminal-ipc').TerminalFileSearchResult
  >(),
  cancelFileSearch: invoke<[requestId: string], void>(),
  resize: invoke<[id: string, cols: number, rows: number], void>(),
  acknowledge: invoke<[id: string, attachmentId: string, sequence: number], void>(),
  rename: invoke<[id: string, title: string | null], void>(),
  close: invoke<[id: string], void>(),
  subscribe: event<[event: TerminalEvent]>().channel('terminal:event'),
});
