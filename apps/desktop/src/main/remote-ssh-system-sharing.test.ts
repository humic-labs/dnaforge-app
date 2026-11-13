import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeSshProcessHasExited } from '../../../../e2e/electron/fixtures/fake-ssh-boundary';
import { resolveSystemSshControlPath } from './remote-ssh-system-sharing';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(policy: string, check = 0) {
  const root = await mkdtemp('/tmp/df-ssh-policy-');
  roots.push(root);
  const path = join(root, 'control');
  const executable = join(root, 'ssh');
  await writeFile(
    executable,
    [
      '#!/bin/sh',
      `if [ "$1" = -S ]; then exit ${check}; fi`,
      '[ "$1" = -G ] || exit 255',
      "cat <<'SSH_POLICY'",
      policy.replaceAll('CONTROL_PATH', path),
      'SSH_POLICY',
      '',
    ].join('\n'),
    { mode: 0o700 }
  );
  return { root, path, executable };
}

describe.runIf(process.platform !== 'win32')('system OpenSSH sharing policy', () => {
  it('reports a failed settings query instead of silently selecting another authentication', async () => {
    const f = await fixture('');
    await writeFile(f.executable, '#!/bin/sh\nexit 255\n', { mode: 0o700 });
    await expect(resolveSystemSshControlPath(f.executable, 'lab-hpc')).rejects.toThrow(
      'OpenSSH connection settings could not be read'
    );
  });

  it('keeps the missing OpenSSH prerequisite distinct from unreadable settings', async () => {
    const f = await fixture('');
    await expect(
      resolveSystemSshControlPath(join(f.root, 'missing-ssh'), 'lab-hpc')
    ).rejects.toMatchObject({
      code: 'ssh-unavailable',
    });
  });

  it('uses automatic persistent sharing in the user-owned private directory without creating a socket', async () => {
    const f = await fixture('controlmaster auto\ncontrolpersist 300\ncontrolpath CONTROL_PATH');
    expect(await resolveSystemSshControlPath(f.executable, 'lab-hpc')).toBe(f.path);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'controlmaster false\ncontrolpersist 300\ncontrolpath CONTROL_PATH',
    'controlmaster autoask\ncontrolpersist 300\ncontrolpath CONTROL_PATH',
    'controlmaster auto\ncontrolpersist no\ncontrolpath CONTROL_PATH',
    'controlmaster auto\ncontrolpersist 0\ncontrolpath CONTROL_PATH',
    'controlmaster auto\ncontrolpersist 300\ncontrolpath none',
    'controlmaster auto\ncontrolpersist 300\ncontrolpath relative/control',
  ])('keeps an independent connection for an unsuitable policy %#', async (policy) => {
    const f = await fixture(policy);
    expect(await resolveSystemSshControlPath(f.executable, 'lab-hpc')).toBeNull();
  });

  it('does not adopt or remove a regular file at the configured socket path', async () => {
    const f = await fixture('controlmaster auto\ncontrolpersist yes\ncontrolpath CONTROL_PATH');
    await writeFile(f.path, 'owned by the user');
    expect(await resolveSystemSshControlPath(f.executable, 'lab-hpc')).toBeNull();
    expect(await readFile(f.path, 'utf8')).toBe('owned by the user');
  });

  it('does not adopt a socket directory accessible to other users', async () => {
    const f = await fixture('controlmaster auto\ncontrolpersist 300\ncontrolpath CONTROL_PATH');
    await chmod(f.root, 0o755);
    expect(await resolveSystemSshControlPath(f.executable, 'lab-hpc')).toBeNull();
  });

  it.each([0, 255])(
    'checks an existing socket without taking ownership, status %s',
    async (status) => {
      const f = await fixture(
        'controlmaster auto\ncontrolpersist 300\ncontrolpath CONTROL_PATH',
        status
      );
      const server = createServer();
      server.listen(f.path);
      await once(server, 'listening');
      try {
        expect(await resolveSystemSshControlPath(f.executable, 'lab-hpc')).toBe(
          status === 0 ? f.path : null
        );
        expect((await lstat(f.path)).isSocket()).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it('cancels its own stalled configuration query promptly', async () => {
    const f = await fixture('');
    const pidPath = join(f.root, 'query-pid');
    await writeFile(f.executable, `#!/bin/sh\nprintf '%s' "$$" > '${pidPath}'\nexec sleep 60\n`, {
      mode: 0o700,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled configuration query');
    const resolving = resolveSystemSshControlPath(f.executable, 'lab-hpc', controller.signal);
    const rejected = expect(resolving).rejects.toBe(reason);
    await expect
      .poll(async () => readFile(pidPath, 'utf8').catch(() => ''), { timeout: 1_000 })
      .not.toBe('');
    const pid = Number(await readFile(pidPath, 'utf8'));
    controller.abort(reason);
    await rejected;
    await expect.poll(() => fakeSshProcessHasExited(pid), { timeout: 1_000 }).toBe(true);
  });
});
