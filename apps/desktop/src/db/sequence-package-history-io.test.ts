import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  fromPackageRelative,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from './sequence-package';
import { prepareSequencePackageRevision } from './sequence-package-versioning';
import {
  readSequencePackageHistoryIndex,
  readSequencePackageRevision,
  readSequencePackageUserAttachment,
  type SequencePackageHistoryFs,
  type SequencePackageHistoryIndex,
} from './sequence-package-history-io';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../shared/workspace-file-atomic';

it('reads a copied package without a database and reports missing snapshots honestly', async () => {
  const packageRoot = '/copied/project/entity';
  const workspaceRoot = '/copied/project';
  const base = buildSequencePackageDocument({
    id: 'entity-one',
    name: 'Entity one',
    product: { file: 'entity.gb', topology: 'linear' },
  });
  const prepared = await prepareSequencePackageRevision({
    current: base,
    currentProductContent: 'first product',
    next: base,
    nextProductContent: 'second product',
    kind: 'sequence-save',
    operationId: 'save-one',
    revisionId: 'revision-two',
    adoptedRevisionId: 'revision-one',
  });
  const paths = sequencePackagePaths(packageRoot, { productFile: 'entity.gb' });
  const files = new Map<string, string>([
    [paths.metaPath, serializeSequencePackageDocument(prepared.document)],
    [paths.productPath, 'second product'],
    ...prepared.snapshots.map(
      (snapshot) =>
        [fromPackageRelative(snapshot.path, packageRoot), snapshot.content] as [string, string]
    ),
  ]);
  let writes = 0;
  const fs = {
    exists: async (path: string) => files.has(path),
    readTextFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    },
    validateWorkspacePath: async ({ path }: { workspaceRoot: string; path: string }) =>
      path.startsWith(`${workspaceRoot}/`),
    writeTextFile: async () => {
      writes += 1;
    },
  };
  const index = await readSequencePackageHistoryIndex({
    packageRoot,
    workspaceRoot,
    expectedPackageId: 'entity-one',
    fs,
  });
  expect(index.document.versionHistory.revisions).toHaveLength(2);
  expect(index.currentProductStatus).toBe('verified');
  expect(
    await readSequencePackageRevision({ index, revisionId: 'revision-one', workspaceRoot, fs })
  ).toMatchObject({ status: 'available', content: 'first product' });
  files.set(paths.productPath, 'externally changed product');
  expect(
    (await readSequencePackageHistoryIndex({ packageRoot, workspaceRoot, fs })).currentProductStatus
  ).toBe('drifted');
  files.delete(fromPackageRelative(prepared.snapshots[0].path, packageRoot));
  expect(
    await readSequencePackageRevision({ index, revisionId: 'revision-one', workspaceRoot, fs })
  ).toMatchObject({ status: 'unavailable', reason: 'Snapshot file is missing.' });
  expect(writes).toBe(0);
});

describe('historical user attachment reader', () => {
  it('checks bounded immutable bytes and distinguishes saved absence from unavailable data', async () => {
    const bytes = Uint8Array.from([0, 255, 71]);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const member = {
      id: 'user-member',
      role: 'user' as const,
      path: 'contents/trace.bin',
      replaceable: false,
      createdAt: '2026-09-30T00:00:00Z',
    };
    const product = serializeSequenceForInPlaceSave(
      {
        id: 'record',
        name: 'Record',
        sequence: 'AACC',
        length: 4,
        annotations: [],
      },
      'record.gb'
    );
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: buildSequencePackageDocument({
        id: 'record',
        name: 'Record',
        product: { file: 'record.gb' },
        members: [member],
        userAttachments: { trace: { memberId: member.id, sha256: digest } },
      }),
      nextProductContent: product,
      kind: 'member-update',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: product,
      next: { ...first.document, userAttachments: {} },
      nextProductContent: product,
      kind: 'member-update',
      operationId: 'second',
      revisionId: 'second',
    });
    const index: SequencePackageHistoryIndex = {
      document: second.document,
      packageRoot: '/workspace/record.wpseq',
      markerPath: '/workspace/record.wpseq/.forge/plasmid.json',
      productPath: '/workspace/record.wpseq/record.gb',
      legacyCurrentHasNoSnapshot: false,
      currentProductStatus: 'verified',
    };
    const readFileBounded = vi.fn().mockResolvedValue(bytes);
    const fs: SequencePackageHistoryFs = {
      exists: vi.fn(),
      readTextFile: vi.fn(),
      readFileBounded,
      validateWorkspacePath: vi.fn().mockResolvedValue(true),
    };
    const request = {
      index,
      revisionId: 'first',
      attachmentId: 'trace',
      workspaceRoot: '/workspace',
      fs,
    };
    expect(await readSequencePackageUserAttachment(request)).toEqual({
      status: 'available',
      present: true,
      sha256: digest,
      sizeBytes: bytes.length,
    });
    expect(readFileBounded).toHaveBeenCalledWith(
      '/workspace/record.wpseq/contents/trace.bin',
      MAX_WORKSPACE_BINARY_WRITE_BYTES
    );
    expect(await readSequencePackageUserAttachment({ ...request, revisionId: 'second' })).toEqual({
      status: 'available',
      present: false,
    });
    readFileBounded.mockResolvedValue(Uint8Array.from([0, 255, 72]));
    expect(await readSequencePackageUserAttachment(request)).toMatchObject({
      status: 'unavailable',
    });
    expect(
      await readSequencePackageUserAttachment({
        ...request,
        fs: { ...fs, readFileBounded: undefined },
      })
    ).toMatchObject({ status: 'unavailable' });
  });
});
