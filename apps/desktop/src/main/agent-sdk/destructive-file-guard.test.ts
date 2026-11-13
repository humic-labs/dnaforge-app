import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDestructiveFilePreToolUseHook } from './destructive-file-guard';
import { createApprovalMemory } from './approval-memory';

describe('createDestructiveFilePreToolUseHook', () => {
  let root: string;
  let scratchRoot: string;
  let userRoot: string;
  let existingUserFile: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fixture-guard-'));
    scratchRoot = join(root, 'cli-scratch', 'session-1');
    userRoot = join(root, 'workspace');
    mkdirSync(scratchRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    existingUserFile = join(userRoot, 'design.gb');
    writeFileSync(existingUserFile, 'ORIGIN');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const makeHook = (
    confirm: (req: unknown, signal?: AbortSignal) => Promise<string>,
    shellSupervision: 'auto' | 'destructive-only' | 'always' = 'destructive-only',
    conversationId: string | null = null
  ) =>
    createDestructiveFilePreToolUseHook({
      cwd: scratchRoot,
      userRoots: [userRoot],
      scratchRoot,
      shellSupervision,
      conversationId,
      confirmDestructiveFile: confirm as never,
    });

  const preToolUse = (toolName: string, toolInput: unknown) => ({
    hook_event_name: 'PreToolUse' as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tu_1',
  });

  const isDeny = (out: { hookSpecificOutput?: { permissionDecision?: string } }) =>
    out?.hookSpecificOutput?.permissionDecision === 'deny';

  it('answers a repeat overwrite in the same chat from memory and labels the project', async () => {
    const memory = createApprovalMemory({ load: () => [], save: () => undefined });
    const confirm = vi.fn(async (_req: unknown) => 'chat' as const);
    const hook = createDestructiveFilePreToolUseHook({
      cwd: scratchRoot,
      userRoots: [userRoot],
      scratchRoot,
      shellSupervision: 'destructive-only',
      conversationId: 'conv-1',
      approvalMemory: memory,
      approvalRoots: [{ path: userRoot, name: 'My Project' }],
      confirmDestructiveFile: confirm,
    });
    const first = await hook(preToolUse('Write', { file_path: existingUserFile }) as never);
    const second = await hook(preToolUse('Write', { file_path: existingUserFile }) as never);
    expect(isDeny(first)).toBe(false);
    expect(isDeny(second)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      displayPath: 'My Project/design.gb',
      rule: { label: 'changes in My Project' },
    });
  });

  it('denies and stops the turn when the user chooses Stop turn', async () => {
    const onStop = vi.fn();
    const hook = createDestructiveFilePreToolUseHook({
      cwd: scratchRoot,
      userRoots: [userRoot],
      scratchRoot,
      shellSupervision: 'destructive-only',
      onStop,
      confirmDestructiveFile: async () => 'stop',
    });
    const out = await hook(preToolUse('Write', { file_path: existingUserFile }) as never);
    expect(isDeny(out)).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('does NOT call confirm and does NOT deny a safe (read-only) tool', async () => {
    const confirm = vi.fn(async (_req: unknown) => 'once' as const);
    const out = await makeHook(confirm)(
      preToolUse('Read', { file_path: existingUserFile }) as never,
      'tu_1',
      {
        signal: new AbortController().signal,
      }
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(isDeny(out as never)).toBe(false);
  });

  it('does NOT call confirm for a new-file Write (creation is not destructive)', async () => {
    const confirm = vi.fn(async (_req: unknown) => 'once' as const);
    const out = await makeHook(confirm)(
      preToolUse('Write', { file_path: join(userRoot, 'new.gb') }) as never,
      'tu_1',
      { signal: new AbortController().signal }
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(isDeny(out as never)).toBe(false);
  });

  it('routes an overwrite of an existing user file to confirm, and ALLOWS when confirmed', async () => {
    const confirm = vi.fn(async (_req: unknown, _signal?: AbortSignal) => 'once' as const);
    const controller = new AbortController();
    const out = await makeHook(confirm, 'destructive-only', 'conversation-1')(
      preToolUse('Write', { file_path: existingUserFile }) as never,
      'tu_1',
      { signal: controller.signal }
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    const req = confirm.mock.calls[0][0] as {
      resolvedPath: string;
      operation: string;
      toolName: string;
      conversationId: string;
    };
    expect(req.toolName).toBe('Write');
    expect(req.resolvedPath).toContain('design.gb');
    expect(req.operation).toMatch(/overwrite|write|edit/i);
    expect(req.conversationId).toBe('conversation-1');
    expect(confirm.mock.calls[0][1]).toBe(controller.signal);
    expect(isDeny(out as never)).toBe(false);
  });

  it('DENIES the destructive op when the user declines the confirm', async () => {
    const confirm = vi.fn(async (_req: unknown) => 'deny' as const);
    const out = await makeHook(confirm)(
      preToolUse('Edit', { file_path: existingUserFile }) as never,
      'tu_1',
      { signal: new AbortController().signal }
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(isDeny(out as never)).toBe(true);
  });

  it('FAIL-CLOSED: denies when the confirm IPC throws', async () => {
    const confirm = vi.fn(async (_req: unknown) => {
      throw new Error('renderer gone');
    });
    const out = await makeHook(confirm)(
      preToolUse('Write', { file_path: existingUserFile }) as never,
      'tu_1',
      { signal: new AbortController().signal }
    );
    expect(isDeny(out as never)).toBe(true);
  });

  it('does not ask for a read-only workspace command under destructive-only', async () => {
    const confirm = vi.fn(async (_req: unknown) => 'once' as const);
    const hook = createDestructiveFilePreToolUseHook({
      cwd: userRoot,
      userRoots: [userRoot],
      scratchRoot,
      shellSupervision: 'destructive-only',
      confirmDestructiveFile: confirm as never,
    });
    const out = await hook(
      preToolUse('Bash', { command: 'curl -s https://example.test' }) as never,
      'tu_1',
      { signal: new AbortController().signal }
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(isDeny(out as never)).toBe(false);
  });

  it('auto accepts even a destructive shell command without opening the dialog', async () => {
    const confirm = vi.fn(async (_req: unknown) => 'deny' as const);
    const out = await makeHook(confirm, 'auto')(
      preToolUse('Bash', { command: 'rm -rf build' }) as never,
      'tu_1',
      { signal: new AbortController().signal }
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(isDeny(out as never)).toBe(false);
  });

  it('destructive-only asks for a destructive Bash command with honest risk metadata', async () => {
    const confirm = vi.fn(async (_req: unknown) => 'deny' as const);
    const hook = createDestructiveFilePreToolUseHook({
      cwd: userRoot,
      userRoots: [userRoot],
      scratchRoot,
      shellSupervision: 'destructive-only',
      confirmDestructiveFile: confirm as never,
    });
    const out = await hook(preToolUse('Bash', { command: 'rm -rf build' }) as never, 'tu_1', {
      signal: new AbortController().signal,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    const req = confirm.mock.calls[0][0] as {
      command?: string;
      resolvedPath: string;
      operation: string;
      risk: string;
      riskSummary: string;
    };
    expect(req).toMatchObject({
      command: 'rm -rf build',
      operation: 'Delete files',
      risk: 'destructive',
    });
    expect(req.riskSummary).toMatch(/delete/i);
    expect(isDeny(out as never)).toBe(true);
  });

  it('applies the same command policy and cancellation signal to ProcessStart', async () => {
    const confirm = vi.fn(async (_req: unknown, _signal?: AbortSignal) => 'deny' as const);
    const controller = new AbortController();
    const out = await makeHook(confirm, 'destructive-only')(
      preToolUse('ProcessStart', { command: 'rm -rf build' }) as never,
      'tu_1',
      { signal: controller.signal }
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'ProcessStart',
        command: 'rm -rf build',
        operation: 'Delete files',
        risk: 'destructive',
      }),
      controller.signal
    );
    expect(isDeny(out as never)).toBe(true);
  });

  it('destructive-only asks before an inert command it cannot classify safely', async () => {
    const confirm = vi.fn(async (_req: unknown) => 'deny' as const);
    const out = await makeHook(confirm, 'destructive-only')(
      preToolUse('Bash', { command: 'dnaforge-test-wrapper --opaque-mode' }) as never,
      'tu_1',
      { signal: new AbortController().signal }
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'dnaforge-test-wrapper --opaque-mode',
        operation: 'Run shell command',
        risk: 'unknown',
        riskSummary: expect.stringMatching(/could not prove/i),
      }),
      expect.any(AbortSignal)
    );
    expect(isDeny(out as never)).toBe(true);
  });

  it('always asks for a read-only command and labels it read-only', async () => {
    const confirm = vi.fn(async (_req: unknown) => 'once' as const);
    await makeHook(confirm, 'always')(preToolUse('Bash', { command: 'ls -la' }) as never, 'tu_1', {
      signal: new AbortController().signal,
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'Run read-only shell command',
        risk: 'read-only',
        riskSummary: expect.stringMatching(/does not modify files/i),
      }),
      expect.any(AbortSignal)
    );
  });
});
