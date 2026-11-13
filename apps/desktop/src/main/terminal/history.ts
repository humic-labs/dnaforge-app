import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { TerminalCommand, TerminalHistoryData } from '../../shared/terminal-ipc';
import {
  parseBashHistory,
  parseFishHistory,
  parsePowerShellHistory,
  parseZshHistory,
} from './upstream/shell-history-parsing';

const LIMIT = 1000;
const text = z.string().max(8192);
const historySchema = z.object({
  commands: z.record(z.array(z.object({ command: text, cwd: text })).max(LIMIT)),
  directories: z.array(text).max(LIMIT),
});

export interface TerminalHistoryProvider {
  flush?(): void;
  recordCommand(shellPath: string, command: TerminalCommand): void;
  recordDirectory(cwd: string): void;
  read(
    shellPath: string,
    environment: NodeJS.ProcessEnv,
    cwd: string
  ): Promise<TerminalHistoryData>;
}

function shellFamily(path: string): string {
  const name = basename(path)
    .toLowerCase()
    .replace(/\.exe$/, '');
  return name === 'powershell' ? 'pwsh' : name;
}

async function readHistoryFile(file: string, shell?: string): Promise<string | undefined> {
  try {
    if (!(await stat(file)).isFile()) return undefined;
    const data = await readFile(file);
    if (shell !== 'zsh') return data.toString('utf8');

    let length = 0;
    for (let index = 0; index < data.length; index++) {
      data[length++] =
        data[index] === 0x83 && index + 1 < data.length ? data[++index] ^ 0x20 : data[index];
    }
    return data.subarray(0, length).toString('utf8');
  } catch {
    return undefined;
  }
}

export class TerminalHistory implements TerminalHistoryProvider {
  private state: z.infer<typeof historySchema> = { commands: {}, directories: [] };
  private loaded = false;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(
    private readonly storage: { read(): string | undefined; write(value: string): void },
    private readonly readText: (
      file: string,
      shell?: string
    ) => Promise<string | undefined> = readHistoryFile,
    private limit = 100
  ) {}

  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 0 || limit > LIMIT)
      throw new Error('Invalid terminal history limit.');
    this.limit = limit;
    this.load();
    this.trim();
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;

    this.storage.write(JSON.stringify(this.state));
    this.dirty = false;
  }

  private trim(): void {
    const before = JSON.stringify(this.state);
    this.state.commands = Object.fromEntries(
      Object.entries(this.state.commands).map(([family, entries]) => [
        family,
        entries.slice(0, this.limit),
      ])
    );
    this.state.directories = this.state.directories.slice(0, this.limit);
    if (JSON.stringify(this.state) !== before) this.scheduleWrite();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const saved = this.storage.read();
      if (saved) {
        const parsed = historySchema.safeParse(JSON.parse(saved));
        if (parsed.success) this.state = parsed.data;
      }
    } catch {
      console.warn('[terminal] Saved history could not be loaded.');
    }
    this.trim();
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (this.pending) return;
    this.pending = setTimeout(() => this.flush(), 100);
    this.pending.unref?.();
  }

  flush(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    if (!this.dirty) return;
    try {
      this.storage.write(JSON.stringify(this.state));
      this.dirty = false;
    } catch {
      console.warn('[terminal] History could not be saved.');
    }
  }

  recordCommand(shellPath: string, command: TerminalCommand): void {
    if (!this.limit || !command.command.trim()) return;
    this.load();
    const family = shellFamily(shellPath);
    const entries = this.state.commands[family] ?? [];
    this.state.commands[family] = [
      { command: command.command.slice(0, 8192), cwd: command.cwd.slice(0, 8192) },
      ...entries.filter((entry) => entry.command !== command.command),
    ].slice(0, this.limit);
    this.visit(command.cwd);
    this.scheduleWrite();
  }

  private visit(cwd: string): void {
    this.state.directories = [
      cwd.slice(0, 8192),
      ...this.state.directories.filter((path) => path !== cwd),
    ].slice(0, this.limit);
  }

  recordDirectory(cwd: string): void {
    this.load();
    if (!this.limit) return;
    if (!cwd || this.state.directories[0] === cwd) return;
    this.visit(cwd);
    this.scheduleWrite();
  }

  async read(
    shellPath: string,
    environment: NodeJS.ProcessEnv,
    cwd: string
  ): Promise<TerminalHistoryData> {
    this.load();
    if (!this.limit) return { previousCommands: [], directories: [], shellCommands: [] };
    const family = shellFamily(shellPath);
    const home = environment.HOME ?? environment.USERPROFILE;
    let file: string | undefined;
    let parse: ((content: string) => string[]) | undefined;
    if (family === 'bash' || family === 'zsh') {
      file = environment.HISTFILE
        ? resolve(cwd, environment.HISTFILE)
        : home
          ? join(home, family === 'bash' ? '.bash_history' : '.zsh_history')
          : undefined;
      parse = family === 'bash' ? parseBashHistory : parseZshHistory;
    } else if (family === 'fish') {
      const data = environment.XDG_DATA_HOME ?? (home ? join(home, '.local/share') : undefined);
      file = data ? join(data, 'fish/fish_history') : undefined;
      parse = parseFishHistory;
    } else if (family === 'pwsh') {
      file =
        process.platform === 'win32'
          ? environment.APPDATA
            ? join(
                environment.APPDATA,
                'Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt'
              )
            : undefined
          : home
            ? join(home, '.local/share/powershell/PSReadLine/ConsoleHost_history.txt')
            : undefined;
      parse = parsePowerShellHistory;
    }
    const content = file ? await this.readText(file, family) : undefined;

    const limit = this.limit;
    if (!limit) return { previousCommands: [], directories: [], shellCommands: [] };
    return {
      previousCommands: (this.state.commands[family] ?? []).map((entry) => ({ ...entry })),
      directories: [...this.state.directories],
      shellCommands:
        content && parse
          ? parse(content)
              .filter((command) => command.length <= 8192)
              .slice(-limit)
              .reverse()
          : [],
    };
  }
}
