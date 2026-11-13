import type { TerminalEmulation } from './terminal-runtime-policy';

export interface TerminalProfile {
  id: string;
  name: string;
  path: string;
  args: string[];
  env?: Record<string, string | null>;
}

export interface TerminalProfilesConfiguration {
  profiles: TerminalProfile[];
  defaultProfileId?: string;
}

export interface TerminalCreateRequest {
  cwd?: string;
  profileId?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalCommandRange {
  startLine: number;
  outputStartLine: number;
  endLine?: number;
}

export interface TerminalCommand {
  id?: string;
  range?: TerminalCommandRange;
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface TerminalFixedDimensions {
  cols?: number;
  rows?: number;
}

export interface TerminalFileSearchRequest {
  requestId: string;
  roots: string[];
  query: string;
}
export interface TerminalFileSearchResult {
  requestId: string;
  paths: string[];
  incomplete: boolean;
  cancelled: boolean;
}

export interface TerminalHistoryData {
  previousCommands: Array<{ command: string; cwd: string }>;
  directories: string[];
  shellCommands: string[];
}

export interface TerminalSession {
  colorSchemeReports?: boolean;
  id: string;
  pid: number;
  profileId: string;
  shellPath: string;

  userHome?: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  bufferBaseY?: number;
  promptStart?: { line: number; column: number };
  exitCode: number | null;
  status: 'running' | 'exited';
  integration: boolean;
  alternateScreen: boolean;
  shellState: 'starting' | 'prompt' | 'command';
  commands: TerminalCommand[];
  fixedDimensions?: TerminalFixedDimensions;
  revivalError?: string;

  emulation?: TerminalEmulation;
}

export interface TerminalAttachment {
  session: TerminalSession;
  attachmentId: string;
  sequence: number;

  replay: string;
}

export interface TerminalCommandState {
  commands: TerminalCommand[];
  bufferBaseY?: number;
}

export type TerminalEvent =
  | {
      kind: 'data';
      id: string;
      attachmentId: string;
      sequence: number;
      data: string;
      commandState?: TerminalCommandState;
    }
  | { kind: 'changed'; session: TerminalSession; notifyExit?: boolean }
  | { kind: 'clear'; id: string; attachmentId: string; sequence: number }
  | { kind: 'removed'; ids: string[] }
  | { kind: 'added'; sessions: TerminalSession[]; groupId?: string };
