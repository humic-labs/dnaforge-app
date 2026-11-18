import type { ChildProcess } from 'child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  children: new Array<ChildProcess>(),
  events: new Array<string>(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      observed.children.push(child);
      child.stdout?.pause();
      child.once('exit', () => observed.events.push('exit'));
      child.stdout?.on('data', () => observed.events.push('stdout'));
      child.once('close', () => observed.events.push('close'));
      return child;
    },
  };
});

import { proveCliMcpToolsReachable } from '../cli-mcp-liveness';

afterEach(async () => {
  for (const child of observed.children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  }
  observed.events.length = 0;
});

it('refuses invalid stdout drained after the companion exits', async () => {
  const pending = proveCliMcpToolsReachable(
    {
      serverName: 'dnaforge',
      command: process.execPath,
      args: ['-e', "process.stdout.write('starting up...\\n');"],
      env: {},
    },
    { requiredToolNames: ['get_workspace'] }
  );
  const child = observed.children[0];
  if (!child) throw new Error('The liveness proof did not spawn its companion.');
  const closed = once(child, 'close');
  const result = await pending;
  await closed;

  expect(observed.events).toEqual(['exit', 'stdout', 'close']);
  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBeNull();
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe('protocol-error');
  expect(result.detail).not.toContain('starting up');
});
