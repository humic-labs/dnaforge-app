export type TerminalCompletionKind = 'command' | 'file' | 'directory' | 'argument' | 'option';
export interface TerminalCompletion {
  token: string;
  label: string;
  kind: TerminalCompletionKind;
}
export interface TerminalCompletionResult {
  requestId: string;
  items: TerminalCompletion[];
}
