// @vitest-environment node

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  refresh: vi.fn(),
  flush: vi.fn(),
  load: vi.fn(),
  readFile: vi.fn(),
  publish: vi.fn(),
  prepare: vi.fn(),
  getResult: vi.fn(),
  release: vi.fn(),
  index: vi.fn(),
  manifest: vi.fn(),
  download: vi.fn(),
}));

vi.mock('./controller', () => ({
  hostedWorkspaceSessionController: {
    getState: () => mocks.state,
    refreshActiveWorkspace: mocks.refresh,
    commit: vi.fn(),
  },
  hostedDurableSync: {
    flush: mocks.flush,
    store: { load: mocks.load },
    runtime: { readFile: mocks.readFile },
  },
}));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  publishHostedWorkspaceFiles: mocks.publish,
  prepareHostedWorkspaceFiles: mocks.prepare,
  loadHostedWorkspaceIndex: mocks.index,
  loadHostedManifest: mocks.manifest,
  downloadHostedFile: mocks.download,
}));
vi.mock('../services/managed-operations', () => ({
  managedOperations: { getResult: mocks.getResult, releaseResult: mocks.release },
}));

import {
  acceptHostedGenomeResult,
  hostedGenomeObjectPath,
  listHostedGenomes,
  parseHostedGenomeResult,
} from './reference-genome-jobs';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const ASSEMBLY = `local-${'a'.repeat(24)}`;

function object(payload: string, contentType = 'application/octet-stream') {
  const sha256 = createHash('sha256').update(payload).digest('hex');
  return {
    objectKey: `objects/sha256/${sha256.slice(0, 2)}/${sha256}`,
    sha256,
    byteLength: payload.length,
    contentType,
  };
}

const bundle = object('{"contract":"bundle"}', 'application/json');
const fasta = object('fasta-bytes');
const RESULT = {
  contract: 'dnaforge-user-genome-publication.v1',
  sourcePath: 'genomes/NC_002506.1.gb',
  sourceSha256: 'b'.repeat(64),
  assembly: {
    id: ASSEMBLY,
    name: 'NC_002506.1',
    organism: 'Imported reference',
    description: 'Custom reference.',
    lengthBp: 1_072_311,
    contigs: [
      { chrom: 'NC_002506', displayName: 'NC_002506', lengthBp: 1_072_311, circular: false },
    ],
  },
  publicationFingerprint: 'c'.repeat(64),
  bundle: { ...bundle, bundleFingerprint: 'd'.repeat(64) },
  objects: [bundle, fasta],
};
const SOURCE_FILE = {
  resourceId: '55555555-5555-4555-8555-555555555555',
  path: 'genomes/NC_002506.1.gb',
  contentRevision: `sha256:${'b'.repeat(64)}`,
  contentSha256: 'b'.repeat(64),
  sizeBytes: 2_335_179,
  contentType: 'application/genbank',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = {
    principal: { id: ACCOUNT },
    activeWorkspaceId: WORKSPACE,
    snapshot: {
      workspaceId: WORKSPACE,
      revisionId: VERSION,
      revisionNumber: 3,
      files: [SOURCE_FILE],
    },
  };
  mocks.load.mockResolvedValue({ operations: [] });
  mocks.getResult.mockResolvedValue({
    operation_id: OPERATION,
    kind: 'reference-genome-preparation',
    status: 'available',
    result: RESULT,
  });
  mocks.release.mockResolvedValue({});
  mocks.publish.mockResolvedValue({ id: VERSION });
  mocks.prepare.mockResolvedValue(['prepared-manifest']);
});

describe('hosted reference genome jobs', () => {
  it('commits the uploaded objects by digest on the settled accepted revision', async () => {
    mocks.publish.mockResolvedValueOnce({ id: '88888888-8888-4888-8888-888888888888' });
    const location = await acceptHostedGenomeResult(OPERATION);

    expect(location.root).toBe(`.waypoint/reference-genomes/${ASSEMBLY}`);
    expect(location.versionId).toBe('88888888-8888-4888-8888-888888888888');
    const publication = mocks.prepare.mock.calls[0][0];
    expect(publication).toMatchObject({
      workspaceId: WORKSPACE,
      baseVersionId: VERSION,
      expectedAccountId: ACCOUNT,
      operationId: OPERATION,
    });
    expect(publication.files).toHaveLength(1);
    expect(publication.files[0].path).toBe(
      `.waypoint/reference-genomes/${ASSEMBLY}/reference-genome.json`
    );
    expect(JSON.parse(new TextDecoder().decode(publication.files[0].bytes))).toMatchObject({
      operationId: OPERATION,
      assembly: { id: ASSEMBLY },
    });
    const baseFiles = publication.baseFiles as Array<Record<string, unknown>>;
    expect(baseFiles).toContainEqual({
      resourceId: SOURCE_FILE.resourceId,
      path: SOURCE_FILE.path,
      contentSha256: SOURCE_FILE.contentSha256,
      sizeBytes: SOURCE_FILE.sizeBytes,
      contentType: SOURCE_FILE.contentType,
    });
    for (const item of RESULT.objects) {
      expect(baseFiles).toContainEqual(
        expect.objectContaining({
          path: hostedGenomeObjectPath(ASSEMBLY, item.objectKey),
          contentSha256: item.sha256,
          sizeBytes: item.byteLength,
        })
      );
    }
    expect(baseFiles.every((file) => !('bytes' in file))).toBe(true);
    expect(mocks.publish).toHaveBeenCalledWith(publication, ['prepared-manifest']);
    expect(mocks.release).toHaveBeenCalledWith(OPERATION);
  });

  it('refuses to attach while local edits are blocked', async () => {
    mocks.load.mockResolvedValue({ operations: [{ state: 'conflict' }] });
    await expect(acceptHostedGenomeResult(OPERATION)).rejects.toThrow(/Sync your saved edits/);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('refuses a result whose object keys do not name their digests', () => {
    expect(() =>
      parseHostedGenomeResult({
        ...RESULT,
        objects: [bundle, { ...fasta, sha256: 'e'.repeat(64) }],
      })
    ).toThrow(/invalid/);
    expect(() =>
      parseHostedGenomeResult({ ...RESULT, bundle: { ...RESULT.bundle, sha256: 'f'.repeat(64) } })
    ).toThrow(/invalid/);
  });

  it('keeps block digests that cover each object and refuses ones that do not', () => {
    const large = {
      ...fasta,
      byteLength: 600_000,
      blockSha256: ['e'.repeat(64), 'f'.repeat(64), 'a'.repeat(64)],
    };
    const parsed = parseHostedGenomeResult({
      ...RESULT,
      blockBytes: 262_144,
      objects: [bundle, large],
    });
    expect(parsed.objects[1].blockSha256).toEqual(large.blockSha256);
    expect(parsed.blockBytes).toBe(262_144);
    expect(parseHostedGenomeResult(RESULT).objects[1].blockSha256).toBeUndefined();
    expect(() =>
      parseHostedGenomeResult({
        ...RESULT,
        blockBytes: 262_144,
        objects: [bundle, { ...large, blockSha256: large.blockSha256.slice(1) }],
      })
    ).toThrow(/invalid/);
    expect(() => parseHostedGenomeResult({ ...RESULT, objects: [bundle, large] })).toThrow(
      /invalid/
    );
    expect(() =>
      parseHostedGenomeResult({ ...RESULT, blockBytes: 65_536, objects: [bundle, large] })
    ).toThrow(/invalid/);
  });

  it('lists only genomes whose every object is in the latest project version', async () => {
    const record = {
      resourceId: '66666666-6666-4666-8666-666666666666',
      path: `.waypoint/reference-genomes/${ASSEMBLY}/reference-genome.json`,
      contentSha256: '9'.repeat(64),
      sizeBytes: 100,
      contentType: 'application/json',
    };
    const placed = (item: typeof bundle) => ({
      path: hostedGenomeObjectPath(ASSEMBLY, item.objectKey),
      contentSha256: item.sha256,
      sizeBytes: item.byteLength,
      contentType: item.contentType,
    });
    const LATEST = '77777777-7777-4777-8777-777777777777';
    mocks.index.mockResolvedValue({
      workspaces: [{ workspaceId: WORKSPACE, latest: { versionId: LATEST } }],
    });
    mocks.download.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ ...RESULT, operationId: OPERATION }))
    );
    mocks.manifest.mockResolvedValue({ manifest: { files: [record, placed(bundle)] } });
    await expect(listHostedGenomes()).resolves.toEqual([]);
    mocks.manifest.mockResolvedValue({
      manifest: { files: [record, placed(bundle), placed(fasta)] },
    });
    const listed = await listHostedGenomes();
    expect(listed.map((genome) => genome.record.assembly.id)).toEqual([ASSEMBLY]);
    expect(listed[0]).toMatchObject({ workspaceId: WORKSPACE, versionId: LATEST });
    expect(listed[0].record.operationId).toBe(OPERATION);
    expect(mocks.manifest).toHaveBeenLastCalledWith(WORKSPACE, LATEST, ACCOUNT);
    expect(mocks.download).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE,
      versionId: LATEST,
      file: record,
    });
  });
});
