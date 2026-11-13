import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveCliMcpToolsReachable } from '../cli-mcp-liveness';
import type { CliMcpServerLaunch } from '../cli-mcp';

let scratch: string;

function fakeCompanion(name: string, body: string): CliMcpServerLaunch {
  const file = join(scratch, `${name}.cjs`);
  writeFileSync(file, body, 'utf8');
  chmodSync(file, 0o755);
  return {
    serverName: 'dnaforge',
    command: process.execPath,
    args: [file],
    env: { DNAFORGE_TEST_FAKE: '1' },
  };
}

function serverServing(
  toolNames: string[],
  options: { callError?: boolean; callIsError?: boolean } = {}
): string {
  return `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: ${JSON.stringify(
        toolNames
      )}.map((n) => ({ name: n, inputSchema: { type: 'object' } })) } });
    } else if (msg.method === 'tools/call') {
      ${options.callError ? "send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'bridge down' } });" : `send({ jsonrpc: '2.0', id: msg.id, result: { isError: ${options.callIsError === true}, content: [{ type: 'text', text: '${options.callIsError ? 'workspace unavailable' : '{"folders":[]}'}' }] } });`}
    }
  }
});
`;
}

const REQUIRED = ['list_files', 'read_file'];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fixture-liveness-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('proveCliMcpToolsReachable', () => {
  it('does not start a companion after its captured generation is revoked', async () => {
    const marker = join(scratch, 'revoked-companion-started');
    const launch = fakeCompanion(
      'revoked-generation',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`
    );
    launch.assertCurrent = () => {
      throw new Error('Revoked generation');
    };
    await expect(
      proveCliMcpToolsReachable(launch, { requiredToolNames: REQUIRED })
    ).resolves.toMatchObject({ ok: false, reason: 'spawn-failed' });
    expect(existsSync(marker)).toBe(false);
  });

  it('returns a receipt when the companion serves every required tool', async () => {
    const launch = fakeCompanion(
      'good',
      serverServing([...REQUIRED, 'find_features', 'get_workspace'])
    );
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      probeToolName: 'get_workspace',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolNames).toContain('list_files');
    expect(result.requiredToolNames).toEqual(REQUIRED);
    expect(result.probeToolName).toBe('get_workspace');
    expect(result.provedAtMs).toBeGreaterThan(0);
  });

  it('does not lend the user turn id to the diagnostic companion', async () => {
    const launch = fakeCompanion(
      'no-user-turn-correlation',
      `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: ${JSON.stringify([
        ...REQUIRED,
        'get_workspace',
      ])}.map((name) => ({ name, inputSchema: { type: 'object' } })) } });
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: Boolean(process.env.DNAFORGE_MCP_TURN_ID), content: [] } });
    }
  }
});
`
    );
    launch.env.DNAFORGE_MCP_TURN_ID = 'user-turn-that-must-not-ground-the-preflight';

    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      probeToolName: 'get_workspace',
    });

    expect(result.ok).toBe(true);
  });

  it('REFUSES when discovery succeeds but a real MCP tool call fails', async () => {
    const launch = fakeCompanion(
      'call-error',
      serverServing([...REQUIRED, 'get_workspace'], { callError: true })
    );
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      probeToolName: 'get_workspace',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('probe-tool-call-failed');
    expect(result.detail).toContain('code=-32000');
    expect(result.detail).not.toContain('bridge down');
  });

  it('REFUSES when the probe tool returns an MCP error result', async () => {
    const launch = fakeCompanion(
      'call-is-error',
      serverServing([...REQUIRED, 'get_workspace'], { callIsError: true })
    );
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      probeToolName: 'get_workspace',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('probe-tool-call-failed');
    expect(result.detail).not.toContain('workspace unavailable');
  });

  it('REFUSES when the probe call returns a malformed success payload', async () => {
    const launch = fakeCompanion(
      'call-malformed-result',
      `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: ${JSON.stringify([
        ...REQUIRED,
        'get_workspace',
      ])}.map((name) => ({ name, inputSchema: { type: 'object' } })) } });
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  }
});
`
    );
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      probeToolName: 'get_workspace',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('probe-tool-call-failed');
  });

  it('REFUSES when the required tools exist but the real-call probe is missing', async () => {
    const launch = fakeCompanion('probe-missing', serverServing(REQUIRED));
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      probeToolName: 'get_workspace',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('probe-tool-missing');
    expect(result.missingToolNames).toEqual(['get_workspace']);
  });

  it('REFUSES when the companion cannot be started at all', async () => {
    const result = await proveCliMcpToolsReachable(
      {
        serverName: 'dnaforge',
        command: join(scratch, 'does-not-exist-anywhere'),
        args: [],
        env: {},
      },
      { requiredToolNames: REQUIRED, timeoutMs: 5_000 }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['spawn-failed', 'companion-exited']).toContain(result.reason);
  });

  it('REFUSES when the companion dies before reporting its tools', async () => {
    const launch = fakeCompanion(
      'crasher',
      "process.stderr.write('session-token-and-workspace-path'); process.exit(3);"
    );
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('companion-exited');
    expect(result.detail).toContain('stderr was withheld');
    expect(result.detail).not.toContain('session-token-and-workspace-path');
  });

  it('REFUSES when the companion starts but serves zero tools', async () => {
    const launch = fakeCompanion('empty', serverServing([]));
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty-tool-list');
  });

  it('REFUSES when tools are served but the workspace tools are missing', async () => {
    const launch = fakeCompanion('partial', serverServing(['get_workspace', 'highlight_range']));
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-required-tools');
    expect(result.missingToolNames).toEqual(REQUIRED);
  });

  it('REFUSES when one capability-eligible discovered tool is absent from the companion', async () => {
    const expected = [...REQUIRED, 'get_workspace', 'observe_app_state'];
    const launch = fakeCompanion(
      'eligible-tool-missing',
      serverServing([...REQUIRED, 'get_workspace'])
    );
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      expectedToolNames: expected,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('tool-surface-mismatch');
    expect(result.missingToolNames).toEqual(['observe_app_state']);
    expect(result.unexpectedToolNames).toEqual([]);
  });

  it('REFUSES when the companion advertises a tool outside authenticated discovery', async () => {
    const expected = [...REQUIRED, 'get_workspace'];
    const launch = fakeCompanion(
      'unexpected-tool',
      serverServing([...expected, 'ungranted_hidden_tool'])
    );
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      expectedToolNames: expected,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('tool-surface-mismatch');
    expect(result.missingToolNames).toEqual([]);
    expect(result.unexpectedToolNames).toEqual(['ungranted_hidden_tool']);
  });

  it('REFUSES when the companion hangs instead of answering', async () => {
    const launch = fakeCompanion('hanger', 'setInterval(() => {}, 1000);');
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('handshake-timeout');
  });

  it('stops the companion proof promptly when the owning turn is cancelled', async () => {
    const launch = fakeCompanion('abortable-hanger', 'setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      timeoutMs: 10_000,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('aborted');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('REFUSES an oversized newline-terminated protocol line', async () => {
    const launch = fakeCompanion(
      'oversized-line',
      "process.stdout.write('x'.repeat(9 * 1024 * 1024) + '\\n');"
    );
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('protocol-error');
    expect(result.detail).toContain('JSON-RPC newline');
  });

  it('REFUSES when stdout carries something that is not JSON-RPC', async () => {
    const launch = fakeCompanion('noisy', "process.stdout.write('starting up...\\n');");
    const result = await proveCliMcpToolsReachable(launch, {
      requiredToolNames: REQUIRED,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('protocol-error');
    expect(result.detail).not.toContain('starting up');
  });

  it('never reports success on any degraded surface', async () => {
    const degraded: Array<[string, string]> = [
      ['exit', 'process.exit(1);'],
      ['silent', 'setInterval(() => {}, 1000);'],
      ['garbage', "process.stdout.write('not json\\n');"],
      ['nothing-served', serverServing([])],
      ['wrong-tools', serverServing(['unrelated_tool'])],
    ];
    for (const [name, body] of degraded) {
      const result = await proveCliMcpToolsReachable(fakeCompanion(`sweep-${name}`, body), {
        requiredToolNames: REQUIRED,
        timeoutMs: 1_000,
      });
      expect(result.ok, `"${name}" produced a receipt for a degraded tool surface`).toBe(false);
    }
  });
});
