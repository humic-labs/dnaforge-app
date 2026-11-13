import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

export interface PortProcess {
  pid: number;
  parent: number;
  group: number;
  foreground: number;
  born: string;
  executable: string;
}
export interface PortSnapshot {
  listeners: number[];
  processes: PortProcess[];
}

function read(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3500,
        maxBuffer: 2_000_000,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (error && (!('code' in error) || error.code !== 1 || stderr.trim()))
          reject(new Error('The native port owner could not be inspected.'));
        else resolve(stdout);
      }
    );
  });
}

export async function inspectTerminalPort(port: number): Promise<PortSnapshot> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TCP port.');
  if (process.platform === 'win32') {
    const shell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $ls=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); $ps=@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; group=0; foreground=0; born=$_.CreationDate.ToUniversalTime().Ticks.ToString(); executable=[string]$_.ExecutablePath} }); @{listeners=$ls; processes=$ps} | ConvertTo-Json -Depth 4 -Compress`;
    const output = await read(shell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);
    return z
      .object({
        listeners: z.array(z.number().int().nonnegative()),
        processes: z.array(
          z.object({
            pid: z.number().int(),
            parent: z.number().int(),
            group: z.number().int(),
            foreground: z.number().int(),
            born: z.string().min(1),
            executable: z.string(),
          })
        ),
      })
      .parse(JSON.parse(output));
  }
  const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(existsSync);
  if (!lsof) throw new Error('Native TCP listener inspection is unavailable.');
  const [listeners, processes] = await Promise.all([
    read(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']),
    read('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=,tpgid=,lstart=,comm=']),
  ]);
  const rows: PortProcess[] = [];
  for (const line of processes.split('\n')) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        line
      );
    if (match)
      rows.push({
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        foreground: Number(match[4]),
        born: match[5]!.replace(/\s+/g, ' '),
        executable: match[6]!,
      });
  }
  return {
    listeners: [...new Set([...listeners.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1])))],
    processes: rows,
  };
}

export function ownedForegroundListener(
  snapshot: PortSnapshot,
  shellPid: number,
  program: string,
  windows: boolean
): string | undefined {
  const processes = new Map(snapshot.processes.map((p) => [p.pid, p]));
  const shell = processes.get(shellPid);
  if (!shell || !snapshot.listeners.length) return undefined;
  for (const pid of snapshot.listeners) {
    const listener = processes.get(pid);
    if (!listener || pid === shellPid || !listener.born) return undefined;
    if (windows) {
      const name = (path: string) =>
        basename(path.replace(/\\/g, '/'))
          .replace(/\.exe$/i, '')
          .toLowerCase();
      if (
        listener.parent !== shellPid ||
        name(listener.executable) !== name(program) ||
        snapshot.processes.filter((p) => p.parent === shellPid).length !== 1
      )
        return undefined;
    } else if (
      shell.foreground <= 0 ||
      listener.group !== shell.foreground ||
      listener.group === shell.group
    )
      return undefined;
    let parent = listener.parent;
    const visited = new Set<number>([pid]);
    while (parent !== shellPid) {
      if (visited.has(parent)) return undefined;
      visited.add(parent);
      const ancestor = processes.get(parent);
      if (!ancestor) return undefined;
      parent = ancestor.parent;
    }
  }
  return [shell, ...[...snapshot.listeners].sort((a, b) => a - b).map((pid) => processes.get(pid)!)]
    .map((p) => `${p.pid}:${p.born}`)
    .join('|');
}
