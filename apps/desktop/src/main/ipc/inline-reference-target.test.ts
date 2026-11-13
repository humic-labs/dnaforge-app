import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResolveInlineReferenceTargetRequest } from '../../shared/inline-reference-ipc';
import { resolveInlineReferenceTarget } from './inline-reference-target';

let fixtureRoot: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'fixture-inline-target-'));
  workspace = join(fixtureRoot, 'Research Workspace');
  outside = join(fixtureRoot, 'outside');
  await mkdir(join(workspace, 'constructs'), { recursive: true });
  await mkdir(join(workspace, 'structures'), { recursive: true });
  await mkdir(join(workspace, 'notes'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, 'constructs', 'pUC19.gb'), 'LOCUS pUC19 2686 bp\n');
  await writeFile(join(workspace, 'constructs', 'yield-100%2e.gb'), 'LOCUS YIELD 100 bp\n');
  await writeFile(join(workspace, 'structures', 'mioC.pdb'), 'HEADER MIOC\n');
  await writeFile(join(workspace, 'notes', 'README.md'), '# Notes\n');
  await writeFile(join(outside, 'secret.gb'), 'LOCUS SECRET\n');

  const packageRoot = join(workspace, 'constructs', 'managed-pUC19');
  await mkdir(join(packageRoot, '.forge'), { recursive: true });
  await writeFile(join(packageRoot, '.forge', 'plasmid.json'), '{}\n');
  await writeFile(join(packageRoot, 'managed-pUC19.gb'), 'LOCUS MANAGED\n');
});
afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function request(
  segments: string[],
  targetKind: ResolveInlineReferenceTargetRequest['targetKind'] = 'workspace'
): ResolveInlineReferenceTargetRequest {
  return {
    roots: [{ name: 'Research Workspace', path: workspace }],
    root: 'Research Workspace',
    segments,
    targetKind,
  };
}

describe('resolveInlineReferenceTarget', () => {
  it.each([
    ['workspace file', ['notes', 'README.md'], 'workspace', 'file'],
    ['workspace directory', ['notes'], 'workspace', 'directory'],
    [
      'workspace sequence package',
      ['constructs', 'managed-pUC19'],
      'workspace',
      'sequence-package',
    ],
    ['sequence file', ['constructs', 'pUC19.gb'], 'sequence', 'file'],
    ['structure file', ['structures', 'mioC.pdb'], 'structure', 'file'],
    ['sequence package', ['constructs', 'managed-pUC19'], 'sequence', 'sequence-package'],
  ] as const)('resolves a %s', async (_name, segments, targetKind, targetType) => {
    const result = await resolveInlineReferenceTarget(request([...segments], targetKind));
    expect(result).toMatchObject({
      ok: true,
      path: join(workspace, ...segments),
      rootPath: workspace,
      relativePath: segments.join('/'),
      targetType,
    });
  });

  it.each([
    [['..', 'outside', 'secret.gb']],
    [['constructs', '..', '..', 'outside', 'secret.gb']],
    [['/etc', 'passwd']],
    [['escape\\secret.gb']],
  ])('rejects a malformed or traversal-shaped segment list: %j', async (segments) => {
    await expect(resolveInlineReferenceTarget(request(segments))).resolves.toEqual({
      ok: false,
      code: 'invalid-input',
    });
  });

  it('rejects a symlinked file that escapes the mounted root', async () => {
    await symlink(join(outside, 'secret.gb'), join(workspace, 'constructs', 'escape.gb'));
    await expect(
      resolveInlineReferenceTarget(request(['constructs', 'escape.gb'], 'sequence'))
    ).resolves.toEqual({ ok: false, code: 'outside-root' });
  });

  it('accepts percent-escape-looking text as literal workspace filename bytes', async () => {
    await expect(
      resolveInlineReferenceTarget(request(['constructs', 'yield-100%2e.gb'], 'sequence'))
    ).resolves.toMatchObject({
      ok: true,
      path: join(workspace, 'constructs', 'yield-100%2e.gb'),
      relativePath: 'constructs/yield-100%2e.gb',
    });
  });

  it('rejects a symlinked directory that escapes the mounted root', async () => {
    await symlink(outside, join(workspace, 'escape'));
    await expect(
      resolveInlineReferenceTarget(request(['escape', 'secret.gb'], 'sequence'))
    ).resolves.toEqual({ ok: false, code: 'outside-root' });
  });

  it('allows a mounted root that is itself reached through a symlink', async () => {
    const linkedRoot = join(fixtureRoot, 'linked-workspace');
    await symlink(workspace, linkedRoot);
    const result = await resolveInlineReferenceTarget({
      roots: [{ name: 'Linked', path: linkedRoot }],
      root: 'Linked',
      segments: ['constructs', 'pUC19.gb'],
      targetKind: 'sequence',
    });
    expect(result).toMatchObject({
      ok: true,
      path: join(linkedRoot, 'constructs', 'pUC19.gb'),
      rootPath: linkedRoot,
    });
  });

  it('rejects duplicate and missing root names deterministically', async () => {
    await expect(
      resolveInlineReferenceTarget({
        ...request(['notes']),
        roots: [
          { name: 'Research Workspace', path: workspace },
          { name: 'Research Workspace', path: outside },
        ],
      })
    ).resolves.toEqual({ ok: false, code: 'root-ambiguous' });
    await expect(
      resolveInlineReferenceTarget({ ...request(['notes']), root: 'Missing' })
    ).resolves.toEqual({ ok: false, code: 'root-not-found' });
  });

  it('distinguishes a missing target from a wrong target kind', async () => {
    await expect(
      resolveInlineReferenceTarget(request(['constructs', 'missing.gb'], 'sequence'))
    ).resolves.toEqual({ ok: false, code: 'target-not-found' });
    await expect(
      resolveInlineReferenceTarget(request(['notes', 'README.md'], 'structure'))
    ).resolves.toEqual({ ok: false, code: 'wrong-kind' });
    await expect(resolveInlineReferenceTarget(request(['notes'], 'sequence'))).resolves.toEqual({
      ok: false,
      code: 'wrong-kind',
    });
  });

  it('fails closed when the target disappears between streaming and activation', async () => {
    const first = await resolveInlineReferenceTarget(
      request(['constructs', 'pUC19.gb'], 'sequence')
    );
    expect(first.ok).toBe(true);
    await rm(join(workspace, 'constructs', 'pUC19.gb'));
    await expect(
      resolveInlineReferenceTarget(request(['constructs', 'pUC19.gb'], 'sequence'))
    ).resolves.toEqual({ ok: false, code: 'target-not-found' });
  });
});
