import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createCodexPermissionHookBridge } from './codex-permission-hook-bridge';

async function runCommand(
  command: string,
  env: Record<string, string>,
  input = ''
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn('/bin/sh', ['-c', command], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  child.stdin.end(input);
  const [code] = (await once(child, 'exit')) as [number | null];
  return { stdout, stderr, code };
}

async function postHook(
  url: string,
  authorization: string,
  body: Buffer
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'content-length': body.length,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('Codex permission hook bridge', () => {
  it('keeps a shell-less-spawnable Codex executable on Windows and carries hook trust in config', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const codexPath = 'C:\\Program Files\\Codex\\codex.exe';
    const bridge = await createCodexPermissionHookBridge({
      codexPath,
      baseEnv: { PATH: process.env.PATH ?? '' },
      preToolUse: async () => ({}),
    });

    try {
      expect(bridge.codexPath).toBe(codexPath);
      expect(bridge.codexPath.toLowerCase()).not.toMatch(/\.(cmd|bat|ps1)$/);
      const hookState = (
        bridge.config as typeof bridge.config & {
          hooks: { state?: Record<string, { trusted_hash: string }> };
        }
      ).hooks.state;
      expect(hookState).toBeDefined();
      expect(Object.values(hookState ?? {})).toEqual([
        { trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      ]);
    } finally {
      await bridge.close();
      platform.mockRestore();
    }
  });

  it('authenticates a PreToolUse callback and emits its blocking JSON', async () => {
    const preToolUse = vi.fn(async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: 'User declined.',
      },
    }));
    const bridge = await createCodexPermissionHookBridge({
      codexPath: '/bin/echo',
      baseEnv: { PATH: process.env.PATH ?? '' },
      preToolUse,
    });

    try {
      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
      };
      const result = await runCommand(bridge.hookCommand, bridge.env, JSON.stringify(input));
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(preToolUse).toHaveBeenCalledWith(input);
    } finally {
      await bridge.close();
    }
  });

  it('trusts only the temporary session hook without bypassing unrelated hook trust', async () => {
    const bridge = await createCodexPermissionHookBridge({
      codexPath: '/bin/echo',
      baseEnv: { PATH: process.env.PATH ?? '' },
      preToolUse: async () => ({}),
    });
    try {
      expect(bridge.codexPath).toBe('/bin/echo');
      expect(Object.keys(bridge.config.hooks.state)).toEqual([
        JSON.stringify('/<session-flags>/config.toml:pre_tool_use:0:0'),
      ]);
      expect(JSON.stringify(bridge.config)).not.toContain('dangerously-bypass-hook-trust');
    } finally {
      await bridge.close();
    }
  });

  it('uses the same normalized trust hash as Codex for a known hook', async () => {
    const bridge = await createCodexPermissionHookBridge({
      codexPath: '/bin/echo',
      baseEnv: { PATH: process.env.PATH ?? '' },
      preToolUse: async () => ({}),
    });
    try {
      const command = bridge.hookCommand;
      const normalized = {
        event_name: 'pre_tool_use',
        matcher: '^Bash$',
        hooks: [
          {
            type: 'command',
            command,
            timeout: 95,
            async: false,
            statusMessage: 'Checking shell supervision',
          },
        ],
      };
      const canonicalize = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
        );
      };
      const { createHash } = await import('node:crypto');
      const expected = `sha256:${createHash('sha256')
        .update(JSON.stringify(canonicalize(normalized)))
        .digest('hex')}`;

      expect(Object.values(bridge.config.hooks.state)).toEqual([{ trusted_hash: expected }]);
    } finally {
      await bridge.close();
    }
  });

  it('rejects unauthenticated and oversized hook requests without invoking the guard', async () => {
    const preToolUse = vi.fn(async () => ({}));
    const bridge = await createCodexPermissionHookBridge({
      codexPath: '/bin/echo',
      baseEnv: { PATH: process.env.PATH ?? '' },
      preToolUse,
    });
    try {
      const url = bridge.env.DNAFORGE_AGENT_PERMISSION_URL;
      const token = bridge.env.DNAFORGE_AGENT_PERMISSION_TOKEN;
      if (!url || !token) throw new Error('bridge hook credentials were not constructed');

      const unauthenticated = await postHook(url, 'Bearer wrong-token', Buffer.from('{}'));
      expect(unauthenticated.status).toBe(403);
      expect(JSON.parse(unauthenticated.body)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });

      const oversized = await postHook(url, `Bearer ${token}`, Buffer.alloc(256 * 1024 + 1, 'x'));
      expect(oversized.status).toBe(413);
      expect(JSON.parse(oversized.body)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(preToolUse).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it('removes its private temporary directory and closes idempotently', async () => {
    const bridge = await createCodexPermissionHookBridge({
      codexPath: '/bin/echo',
      baseEnv: { PATH: process.env.PATH ?? '' },
      preToolUse: async () => ({}),
    });
    const hookPath = bridge.hookCommand.match(/ '([^']+)'$/)?.[1];
    expect(hookPath).toBeTruthy();
    const tempRoot = dirname(hookPath!);
    expect(existsSync(tempRoot)).toBe(true);
    await bridge.close();
    await bridge.close();
    expect(existsSync(tempRoot)).toBe(false);
  });
});
