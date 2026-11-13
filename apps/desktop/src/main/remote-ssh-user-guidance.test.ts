import { toUserMessage } from '@waypoint/user-messages';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createFakeSshBoundary,
  fakeSshProcessHasExited,
  readFakeSshProcesses,
} from '../../../../e2e/electron/fixtures/fake-ssh-boundary';
import { remoteSshErrorMessage } from '../shared/remote-ssh-error-message';
import { RemoteEndpointExplorer } from './remote-endpoint-explorer';
import { RemoteGenomicsError } from './remote-genomics-error';

const owned: Array<{ root: string; explorer: RemoteEndpointExplorer }> = [];

afterEach(async () => {
  for (const fixture of owned.splice(0)) {
    await fixture.explorer.stopAll();
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

it.each([
  ['python-unavailable-hpc', /does not provide Python 3/u],
  ['forward-denied-hpc', /forward/u],
] as const)(
  'retains actionable guidance from the actual SSH failure at %s',
  async (target, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'remote-ssh-guidance-'));
    const ssh = createFakeSshBoundary(root);
    vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', ssh.bridgePath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', ssh.logPath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', ssh.failureMarkerPath);
    const explorer = new RemoteEndpointExplorer({ sshPath: ssh.executablePath, timeoutMs: 5_000 });
    owned.push({ root, explorer });

    const failure = await explorer
      .open({ requestId: `guidance-${target}`, target }, 42)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteGenomicsError);
    if (!(failure instanceof RemoteGenomicsError))
      throw new Error('Expected the SSH fixture failure');
    const received = new Error(
      `Error invoking remote method 'remoteGenomics:openExplorer': RemoteGenomicsError: ${failure.message}`
    );
    const message = toUserMessage(remoteSshErrorMessage(received), 'remote.connectionFailed');
    expect(message, failure.message).toMatch(expected);
    expect(message).not.toMatch(/remoteGenomics:|RemoteGenomicsError/u);
    for (const child of readFakeSshProcesses(ssh.logPath, target)) {
      await expect.poll(() => fakeSshProcessHasExited(child.pid)).toBe(true);
    }
  },
  15_000
);
