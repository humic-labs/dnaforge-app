export function quoteTerminalPath(path: string, shell: string): string {
  if (path.includes('\0')) throw new Error('A terminal path cannot contain a null character.');
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'pwsh' || name === 'pwsh.exe' || name === 'powershell.exe') {
    return `'${path.split("'").join("''")}'`;
  }
  if (name === 'cmd.exe' || name === 'cmd') return `"${path.split('"').join('""')}"`;
  return `'${path.split("'").join("'\\''")}'`;
}

export function terminalFileCommand(path: string, shell: string): string {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const invocation = ['pwsh', 'pwsh.exe', 'powershell.exe'].includes(name) ? '& ' : '';
  return invocation + quoteTerminalPath(path, shell);
}

export function terminalDirectoryCommand(path: string, shell: string): string {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const command = ['pwsh', 'pwsh.exe', 'powershell.exe'].includes(name)
    ? 'Set-Location -LiteralPath '
    : name === 'cmd' || name === 'cmd.exe'
      ? 'cd /d '
      : 'cd -- ';
  return command + quoteTerminalPath(path, shell);
}

export function splitTerminalInput(input: string): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < input.length; ) {
    let end = Math.min(offset + 65_536, input.length);
    if (end < input.length && /[\uD800-\uDBFF]/.test(input[end - 1]!)) end -= 1;
    result.push(input.slice(offset, end));
    offset = end;
  }
  return result;
}
