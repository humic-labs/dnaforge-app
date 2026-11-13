import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { contentHashInMain } from '../content-hash';

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fixture-hash-'));
  workspace = join(root, 'workspace');
  outside = join(root, 'outside');
  mkdirSync(join(workspace, 'sequences'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, 'sequences', 'pUC19.gb'), 'LOCUS pUC19 2686 bp\n');
  writeFileSync(join(outside, 'secret.txt'), 'private\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sha256Of = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

describe('contentHashInMain — the happy path', () => {
  it('hashes a file inside the workspace and returns a sha256: prefixed value', async () => {
    const hash = await contentHashInMain({
      workspaceRoot: workspace,
      workspaceRelativePath: 'sequences/pUC19.gb',
    });
    expect(hash).toBe(sha256Of('LOCUS pUC19 2686 bp\n'));
  });

  it('always returns the fully-prefixed namespace, never bare hex', async () => {
    const hash = await contentHashInMain({
      workspaceRoot: workspace,
      workspaceRelativePath: 'sequences/pUC19.gb',
    });
    expect(hash.startsWith('sha256:')).toBe(true);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across calls and changes when the bytes change', async () => {
    const input = { workspaceRoot: workspace, workspaceRelativePath: 'sequences/pUC19.gb' };
    const first = await contentHashInMain(input);
    expect(await contentHashInMain(input)).toBe(first);

    writeFileSync(join(workspace, 'sequences', 'pUC19.gb'), 'LOCUS pUC19 2687 bp\n');
    expect(await contentHashInMain(input)).not.toBe(first);
  });
});

describe('contentHashInMain — the boundary', () => {
  it('rejects a traversal escape', async () => {
    await expect(
      contentHashInMain({
        workspaceRoot: workspace,
        workspaceRelativePath: '../outside/secret.txt',
      })
    ).rejects.toThrow(/outside the workspace/i);
  });

  it('rejects a deep traversal escape', async () => {
    await expect(
      contentHashInMain({
        workspaceRoot: workspace,
        workspaceRelativePath: 'sequences/../../outside/secret.txt',
      })
    ).rejects.toThrow(/outside the workspace/i);
  });

  it('rejects an ABSOLUTE relative-path argument', async () => {
    await expect(
      contentHashInMain({
        workspaceRoot: workspace,
        workspaceRelativePath: join(outside, 'secret.txt'),
      })
    ).rejects.toThrow(/must be workspace-relative/i);
  });

  it('🟥 rejects a SYMLINK escaping the workspace — lexical checks cannot catch this', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'sequences', 'link.gb'));
    await expect(
      contentHashInMain({
        workspaceRoot: workspace,
        workspaceRelativePath: 'sequences/link.gb',
      })
    ).rejects.toThrow(/outside the workspace/i);
  });

  it('🟥 rejects a symlinked DIRECTORY escaping the workspace', async () => {
    symlinkSync(outside, join(workspace, 'escape'));
    await expect(
      contentHashInMain({
        workspaceRoot: workspace,
        workspaceRelativePath: 'escape/secret.txt',
      })
    ).rejects.toThrow(/outside the workspace/i);
  });

  it('allows a symlink that stays INSIDE the workspace', async () => {
    symlinkSync(join(workspace, 'sequences', 'pUC19.gb'), join(workspace, 'alias.gb'));
    const hash = await contentHashInMain({
      workspaceRoot: workspace,
      workspaceRelativePath: 'alias.gb',
    });
    expect(hash).toBe(sha256Of('LOCUS pUC19 2686 bp\n'));
  });

  it('rejects a path in a DIFFERENT workspace root', async () => {
    const otherWorkspace = join(root, 'other-workspace');
    mkdirSync(join(otherWorkspace, 'sequences'), { recursive: true });
    writeFileSync(join(otherWorkspace, 'sequences', 'other.gb'), 'x\n');
    await expect(
      contentHashInMain({
        workspaceRoot: workspace,
        workspaceRelativePath: '../other-workspace/sequences/other.gb',
      })
    ).rejects.toThrow(/outside the workspace/i);
  });

  it('rejects an empty relative path rather than hashing the root directory', async () => {
    await expect(
      contentHashInMain({ workspaceRoot: workspace, workspaceRelativePath: '' })
    ).rejects.toThrow(/must be workspace-relative/i);
  });

  it('surfaces a missing file as a distinct, non-boundary failure', async () => {
    await expect(
      contentHashInMain({
        workspaceRoot: workspace,
        workspaceRelativePath: 'sequences/nope.gb',
      })
    ).rejects.toThrow(/not found/i);
  });

  it('refuses a directory target', async () => {
    await expect(
      contentHashInMain({ workspaceRoot: workspace, workspaceRelativePath: 'sequences' })
    ).rejects.toThrow(/not a file/i);
  });
});
