import { spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';

import { proveCliMcpToolsReachable } from '../cli-mcp-liveness';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: vi.fn(),
}));

it('reports malformed stdout delivered after process exit and before stdio closes', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

  const pending = proveCliMcpToolsReachable(
    { serverName: 'dnaforge', command: process.execPath, args: [], env: {} },
    { requiredToolNames: ['list_files', 'read_file'], timeoutMs: 5_000 }
  );
  child.emit('exit', 0, null);
  child.stdout.end('starting up...\n');
  child.stderr.end();
  child.emit('close', 0, null);

  const result = await pending;
  expect(result).toMatchObject({ ok: false, reason: 'protocol-error' });
  if (!result.ok) expect(result.detail).not.toContain('starting up');
});
