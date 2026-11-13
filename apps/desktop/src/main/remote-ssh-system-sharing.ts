import { execFile } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RemoteGenomicsError } from './remote-genomics-error';

export function sshControlPathArgument(path: string): string {
  return path.replaceAll('%', '%%');
}

export async function resolveSystemSshControlPath(
  sshPath: string,
  target: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const query = (args: readonly string[]): Promise<string | null> =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      execFile(
        sshPath,
        [...args],
        { timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal },
        (error, stdout) => {
          if (error && process.env.DNAFORGE_SSH_CONTROL_POLICY_DIAGNOSTICS === '1') {
            console.warn('[remote-ssh] control policy query failed:', {
              operation: args[0] === '-G' ? 'configuration' : 'control-check',
              elapsedMs: Date.now() - startedAt,
              code: error.code ?? null,
              signal: error.signal ?? null,
              killed: error.killed ?? false,
            });
          }
          if (signal?.aborted) reject(signal.reason);
          else if (error && args[0] === '-G') {
            reject(
              new RemoteGenomicsError(
                error.code === 'ENOENT' ? 'ssh-unavailable' : 'helper-failed',
                error.code === 'ENOENT'
                  ? 'The system OpenSSH client was not found. Install or restore ssh on this computer.'
                  : 'OpenSSH connection settings could not be read. Check your SSH configuration or try again.'
              )
            );
          } else resolve(error ? null : stdout);
        }
      );
    });
  const config = await query(['-G', target]);
  signal?.throwIfAborted();
  if (config === null) return null;
  const setting = (name: string): string | undefined =>
    config.match(new RegExp(`^${name} (.+)$`, 'mu'))?.[1]?.trim();
  const persist = setting('controlpersist');
  const path = setting('controlpath');
  if (
    setting('controlmaster') !== 'auto' ||
    !(
      persist === 'yes' ||
      (persist !== undefined && /^\d+$/u.test(persist) && Number(persist) > 0)
    ) ||
    !path?.startsWith('/') ||
    path.length > 100 ||
    /[\0\r\n]/u.test(path)
  ) {
    if (process.env.DNAFORGE_SSH_CONTROL_POLICY_DIAGNOSTICS === '1') {
      console.warn('[remote-ssh] control policy rejected:', {
        automatic: setting('controlmaster') === 'auto',
        persistent:
          persist === 'yes' ||
          (persist !== undefined && /^\d+$/u.test(persist) && Number(persist) > 0),
        absolutePath: path?.startsWith('/') ?? false,
        pathLength: path?.length ?? 0,
      });
    }
    return null;
  }
  try {
    const parent = await stat(dirname(path));
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
      if (process.env.DNAFORGE_SSH_CONTROL_POLICY_DIAGNOSTICS === '1')
        console.warn('[remote-ssh] control directory rejected');
      return null;
    }
    try {
      const socket = await lstat(path);
      if (!socket.isSocket() || socket.uid !== parent.uid) return null;
      if ((await query(['-S', sshControlPathArgument(path), '-O', 'check', target])) === null) {
        return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    signal?.throwIfAborted();
    return path;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}
