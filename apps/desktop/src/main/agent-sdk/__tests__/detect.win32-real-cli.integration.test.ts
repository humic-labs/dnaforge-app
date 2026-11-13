import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectClaudeCode } from '../detect';
import { runChildProcess } from '../auth';

const execFileAsync = promisify(execFile);

const ENABLED = process.platform === 'win32' && process.env.WINDOWS_REAL_CLI === '1';

describe.skipIf(!ENABLED)(' win32 real-CLI spawn boundary', () => {
  it('resolves `claude` to a shell-less-spawnable path (never a raw .cmd/.ps1)', async () => {
    const detection = await detectClaudeCode();

    expect(detection.cli, `searched: ${detection.searchedDirs?.join(', ')}`).toBe('installed');
    expect(detection.path).toBeTruthy();

    const lower = detection.path!.toLowerCase();
    expect(lower).not.toMatch(/\.(cmd|bat|ps1)$/);
    expect(lower).toMatch(/\.(exe|com|c?js|mjs)$/);
  });

  it('launches the resolved path via the REAL login-spawn primitive → exit 0, no EINVAL', async () => {
    const detection = await detectClaudeCode();
    expect(detection.path).toBeTruthy();

    const result = await runChildProcess(detection.path!, ['--version'], {
      timeoutMs: 20_000,
      onOutput: () => {},
    });

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/\d+\.\d+\.\d+/);
  });

  it('CONTROL: spawning the raw .cmd shim WITHOUT a shell still throws EINVAL on this box', async () => {
    let cmdShim: string | null = null;
    try {
      const { stdout } = await execFileAsync('where', ['claude'], { timeout: 5000 });
      cmdShim =
        stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.toLowerCase().endsWith('.cmd')) ?? null;
    } catch {}

    if (!cmdShim) {
      console.warn(
        '[ control] no `.cmd` shim on PATH (native-installer box?) — skipping control'
      );
      return;
    }

    const einval = await new Promise<string | null>((resolve) => {
      const child = spawn(cmdShim!, ['--version'], { stdio: 'ignore', windowsHide: true });
      child.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      child.on('close', () => resolve(null));
    });

    if (einval === null) {
      console.warn(
        '[ control] raw .cmd spawn did NOT throw — Node predates CVE-2024-27980 hardening'
      );
    } else {
      expect(einval).toBe('EINVAL');
    }
  });
});
