import type { ClientOf } from './ipc/contract';
import type { terminalContract } from './ipc/terminal.contract';
import type { TerminalEvent } from './terminal-ipc';

export interface TerminalPort extends ClientOf<typeof terminalContract> {
  focus?(id: string | null): Promise<void>;
  paste(id: string, warnMultiline: boolean): Promise<string>;
  subscribe(callback: (event: TerminalEvent) => void): () => void;
}
