export interface RemoteSshCommand {
  readonly executable: string;
  readonly prefixArgs?: readonly string[];
  readonly runtime?: 'wsl';
}

export function remoteSshInvocation(command: RemoteSshCommand, args: readonly string[]) {
  return { executable: command.executable, args: [...(command.prefixArgs ?? []), ...args] };
}
