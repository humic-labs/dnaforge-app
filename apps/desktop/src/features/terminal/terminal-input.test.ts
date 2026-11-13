import { describe, expect, it } from 'vitest';
import {
  quoteTerminalPath,
  splitTerminalInput,
  terminalFileCommand,
  terminalDirectoryCommand,
} from './terminal-input';

describe('terminal input preserves literal paths and characters', () => {
  it('changes directories literally using the active shell command', () => {
    expect(terminalDirectoryCommand("/tmp/[a] O'Brien;$(not-run)", '/bin/zsh')).toBe(
      "cd -- '/tmp/[a] O'\\''Brien;$(not-run)'"
    );
    expect(terminalDirectoryCommand('C:\\[literal] path', 'pwsh.exe')).toBe(
      "Set-Location -LiteralPath 'C:\\[literal] path'"
    );
    expect(terminalDirectoryCommand('D:\\a b', 'cmd.exe')).toBe('cd /d "D:\\a b"');
  });
  it('quotes spaces, apostrophes and shell metacharacters without executing them', () => {
    expect(quoteTerminalPath('/tmp/a b;$(touch surprise)', 'zsh')).toBe(
      "'/tmp/a b;$(touch surprise)'"
    );
    expect(quoteTerminalPath("/tmp/a'b", 'bash')).toBe("'/tmp/a'\\''b'");
    expect(quoteTerminalPath("C:\\a b\\x'y", 'powershell.exe')).toBe("'C:\\a b\\x''y'");
    expect(quoteTerminalPath('/tmp/a\nb', 'zsh')).toContain('\n');
  });

  it('splits a large paste without breaking a Unicode surrogate pair', () => {
    const input = 'a'.repeat(65_535) + '🧬' + 'b'.repeat(65_535);
    const chunks = splitTerminalInput(input);
    expect(chunks.join('')).toBe(input);
    expect(chunks.every((chunk) => chunk.length <= 65_536)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });

  it('executes a literal file path and uses the PowerShell invocation operator', () => {
    expect(terminalFileCommand('/tmp/script name;$(not-run).sh', '/bin/zsh')).toBe(
      "'/tmp/script name;$(not-run).sh'"
    );
    expect(terminalFileCommand("C:\\O'Brien\\script.ps1", 'pwsh.exe')).toBe(
      "& 'C:\\O''Brien\\script.ps1'"
    );
  });
});
