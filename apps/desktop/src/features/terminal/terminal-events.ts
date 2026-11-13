export const OPEN_INTEGRATED_TERMINAL_EVENT = 'dnaforge:open-integrated-terminal';
export const RUN_INTEGRATED_TERMINAL_EVENT = 'dnaforge:run-integrated-terminal';

export type TerminalRunRequest = {
  cwd?: string;
  fresh?: boolean;
} & ({ text: string; filePath?: never } | { filePath: string; text?: never });
export function runInIntegratedTerminal(request: TerminalRunRequest): void {
  window.dispatchEvent(new CustomEvent(RUN_INTEGRATED_TERMINAL_EVENT, { detail: request }));
}

export function openIntegratedTerminal(cwd: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_INTEGRATED_TERMINAL_EVENT, { detail: { cwd } }));
}
