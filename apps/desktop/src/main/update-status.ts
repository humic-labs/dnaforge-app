import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { appendBootLog } from './boot-log';
import { isBackgroundWindowMode } from './background-window-mode';

export async function showMacUpdateStatus(version: string): Promise<() => void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return () => undefined;
  const contents = dirname(dirname(process.execPath));
  const executable = join(contents, 'Helpers/dnaforge-update-status');
  if (!existsSync(executable)) throw new Error('The update status component is missing.');
  const logs = join(app.getPath('userData'), 'logs');
  mkdirSync(logs, { recursive: true });
  const receipt = join(logs, `update-status-${randomUUID()}.jsonl`);
  const fd = openSync(receipt, 'wx', 0o600);
  const requested = Date.now();
  appendFileSync(fd, `${JSON.stringify({ kind: 'requested', at: requested, version })}\n`);
  let child: ChildProcess;
  try {
    child = spawn(
      executable,
      [
        dirname(contents),
        join(logs, 'main-boot.log'),
        version,
        String(requested),
        isBackgroundWindowMode() ? 'background' : 'normal',
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] }
    );
  } finally {
    closeSync(fd);
  }
  let failed: Error | undefined;
  child.on('error', (error) => {
    failed = error;
  });
  child.unref();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    appendFileSync(receipt, `${JSON.stringify({ kind: 'cancelled', at: Date.now() })}\n`);
  };
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (failed) throw failed;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('The update status window closed before installation.');
      const shown = readFileSync(receipt, 'utf8')
        .trim()
        .split('\n')
        .some((line) => {
          const event: unknown = JSON.parse(line);
          return (
            typeof event === 'object' &&
            event !== null &&
            'kind' in event &&
            event.kind === 'shown' &&
            'visible' in event &&
            event.visible === true &&
            'pid' in event &&
            event.pid === child.pid
          );
        });
      if (shown) {
        appendBootLog(`update_status_shown pid=${child.pid} receipt=${receipt}`);
        return stop;
      }
      if (Date.now() >= deadline) throw new Error('The update status window did not open.');
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) {
    stop();
    throw error;
  }
}
