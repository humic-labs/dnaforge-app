import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSequencePackageDocument } from '../db/sequence-package';
import { prepareSequenceUserAttachmentMutation } from '../db/sequence-package-user-attachment-mutation';
import { stagePreparedUserAttachmentAssetInMain } from './sequence-package-user-attachment-asset';

const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sequence-user-asset-'));
  temporaryRoots.push(workspaceRoot);
  const packageRoot = join(workspaceRoot, 'owned-package');
  await mkdir(packageRoot);
  const document = buildSequencePackageDocument({
    id: 'package-one',
    name: 'Package one',
    product: { file: 'package.gb' },
  });
  const prepared = await prepareSequenceUserAttachmentMutation(document, {
    kind: 'attach',
    attachmentId: 'binary-note',
    memberId: MEMBER_ID,
    fileName: 'note.bin',
    content: new Uint8Array([0, 255, 17]),
    createdAt: CREATED_AT,
  });
  if (!prepared.asset) throw new Error('Attachment preparation returned no asset.');
  return { workspaceRoot, packageRoot, asset: prepared.asset };
}

describe('main-owned user attachment asset staging', () => {
  it('stages exact bytes inside the package and accepts an identical retry', async () => {
    const input = await fixture();
    const path = await stagePreparedUserAttachmentAssetInMain(input);
    expect(path).toBe(join(await realpath(input.packageRoot), input.asset.path));
    expect(new Uint8Array(await readFile(path))).toEqual(input.asset.content);
    await expect(stagePreparedUserAttachmentAssetInMain(input)).resolves.toBe(path);
  });

  it('refuses a preexisting different file without replacing its bytes', async () => {
    const input = await fixture();
    const path = join(input.packageRoot, input.asset.path);
    await mkdir(join(input.packageRoot, 'contents'));
    await writeFile(path, new Uint8Array([7, 7, 7]));
    await expect(stagePreparedUserAttachmentAssetInMain(input)).rejects.toThrow(/conflicts/);
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([7, 7, 7]));
  });

  it('rejects a symlinked contents directory before writing outside the workspace', async () => {
    if (process.platform === 'win32') return;
    const input = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'sequence-user-asset-outside-'));
    temporaryRoots.push(outside);
    await symlink(outside, join(input.packageRoot, 'contents'));
    await expect(stagePreparedUserAttachmentAssetInMain(input)).rejects.toThrow(/workspace/);
    await expect(readFile(join(outside, input.asset.path.split('/').pop()!))).rejects.toThrow();
  });
});
