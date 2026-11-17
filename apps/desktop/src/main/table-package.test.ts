// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readTablePackageInMain,
  readTableSnapshotInMain,
  publishTablePackageInMain,
} from './table-package';
import {
  parseTablePackageHead,
  parseTableSnapshot,
  serializeTablePackageHead,
  serializeTableSnapshot,
  tablePackagePaths,
  tablePackageRevisionPath,
  type TablePackageHead,
} from '../shared/table-package';
import {
  writeWorkspaceTextFileAtomicInMain,
  WorkspaceFilePublicationUncertainError,
} from './primer-artifact-files';
import { syncDirectory } from './fs-durability';

const documentId = '8b42f5f1-635e-4cda-a07b-8fc2531fc97e';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function head(value: string, previous?: TablePackageHead): TablePackageHead {
  const snapshot = parseTableSnapshot(
    JSON.stringify({
      ...(previous?.snapshot ?? {}),
      schema: 'dnaforge.table-snapshot.v1',
      documentId,
      title: 'Samples',
      data: {
        rows: 1,
        cols: 1,
        cells: [[{ value, type: 'text' }]],
        retained: { exact: [42, 'original'] },
      },
    })
  );
  const parsedSnapshot = serializeTableSnapshot(snapshot);
  return parseTablePackageHead(
    JSON.stringify({
      ...(previous ?? {}),
      schema: 'dnaforge.table.v1',
      id: documentId,
      snapshotSha256: hash(parsedSnapshot),
      snapshot,
      aliases: [],
      status: 'active',
    })
  );
}

async function fixture() {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'table-publication-')));
  roots.push(workspaceRoot);
  const packageRoot = join(workspaceRoot, 'Samples');
  const original = head('original');
  const published = await publishTablePackageInMain(
    { workspaceRoot, packageRoot, head: original, mode: 'create' },
    { assertCurrent() {} }
  );
  return { workspaceRoot, packageRoot, original, published, paths: tablePackagePaths(packageRoot) };
}

describe('native table package publication', () => {
  it('publishes and verifies a real current head and owned immutable snapshot', async () => {
    const f = await fixture();
    const read = await readTablePackageInMain({
      workspaceRoot: f.workspaceRoot,
      packageRoot: f.packageRoot,
      expectedDocumentId: documentId,
    });
    expect(read.head).toEqual(f.original);
    expect(read.snapshot).toEqual(f.original.snapshot);
    expect(read.headContentHash).toBe(hash(await readFile(f.paths.headPath, 'utf8')));
    expect(
      await readFile(tablePackageRevisionPath(f.packageRoot, f.original.snapshotSha256), 'utf8')
    ).toBe(serializeTableSnapshot(f.original.snapshot));
    expect(f.published.publication).toBe('committed');
  });

  it('retains old saved versions through a new head and package move', async () => {
    const f = await fixture();
    const originalBytes = await readFile(
      tablePackageRevisionPath(f.packageRoot, f.original.snapshotSha256),
      'utf8'
    );
    const next = head('new current', f.original);
    await publishTablePackageInMain(
      {
        workspaceRoot: f.workspaceRoot,
        packageRoot: f.packageRoot,
        head: next,
        mode: 'replace',
        expectedContentHash: f.published.headContentHash,
      },
      { assertCurrent() {} }
    );
    const moved = join(f.workspaceRoot, 'Renamed table');
    await rename(f.packageRoot, moved);
    const current = await readTablePackageInMain({
      workspaceRoot: f.workspaceRoot,
      packageRoot: moved,
      expectedDocumentId: documentId,
    });
    expect(current.head).toEqual(next);
    const pin = await readTableSnapshotInMain({
      workspaceRoot: f.workspaceRoot,
      packageRoot: moved,
      documentId,
      snapshotSha256: f.original.snapshotSha256,
    });
    expect(pin.snapshot).toEqual(f.original.snapshot);
    expect(pin.snapshotText).toBe(originalBytes);
  });

  it('refuses destination collision and stale replacement without changing accepted bytes', async () => {
    const f = await fixture();
    const before = await readFile(f.paths.headPath, 'utf8');
    const next = head('must not replace');
    await expect(
      publishTablePackageInMain(
        { workspaceRoot: f.workspaceRoot, packageRoot: f.packageRoot, head: next, mode: 'create' },
        { assertCurrent() {} }
      )
    ).rejects.toThrow();
    await expect(
      publishTablePackageInMain(
        {
          workspaceRoot: f.workspaceRoot,
          packageRoot: f.packageRoot,
          head: next,
          mode: 'replace',
          expectedContentHash: '0'.repeat(64),
        },
        { assertCurrent() {} }
      )
    ).rejects.toThrow();
    expect(await readFile(f.paths.headPath, 'utf8')).toBe(before);
  });

  it('retains the prior head when a new snapshot cannot be written and preserves the actual cause', async () => {
    const f = await fixture();
    const before = await readFile(f.paths.headPath, 'utf8');
    const denied = Object.assign(new Error('EACCES: controlled snapshot write refusal'), {
      code: 'EACCES',
    });
    const writeAtomic: typeof writeWorkspaceTextFileAtomicInMain = async () => {
      throw denied;
    };
    await expect(
      publishTablePackageInMain(
        {
          workspaceRoot: f.workspaceRoot,
          packageRoot: f.packageRoot,
          head: head('retained draft'),
          mode: 'replace',
          expectedContentHash: f.published.headContentHash,
        },
        { assertCurrent() {}, writeAtomic }
      )
    ).rejects.toBe(denied);
    expect(await readFile(f.paths.headPath, 'utf8')).toBe(before);
    expect(
      (await readTablePackageInMain({ workspaceRoot: f.workspaceRoot, packageRoot: f.packageRoot }))
        .head
    ).toEqual(f.original);
  });

  it('keeps a verified staged snapshot harmless when head publication fails', async () => {
    const f = await fixture();
    const before = await readFile(f.paths.headPath, 'utf8');
    const next = head('new staged version');
    const denied = new Error('Controlled head publication failure');
    const writeAtomic: typeof writeWorkspaceTextFileAtomicInMain = async (input, options) => {
      if (resolve(input.workspaceRoot, input.path) === f.paths.headPath) throw denied;
      return writeWorkspaceTextFileAtomicInMain(input, options);
    };
    await expect(
      publishTablePackageInMain(
        {
          workspaceRoot: f.workspaceRoot,
          packageRoot: f.packageRoot,
          head: next,
          mode: 'replace',
          expectedContentHash: f.published.headContentHash,
        },
        { assertCurrent() {}, writeAtomic }
      )
    ).rejects.toBe(denied);
    expect(await readFile(f.paths.headPath, 'utf8')).toBe(before);
    expect(
      (await readTablePackageInMain({ workspaceRoot: f.workspaceRoot, packageRoot: f.packageRoot }))
        .head.snapshotSha256
    ).toBe(f.original.snapshotSha256);
    expect(
      await readFile(tablePackageRevisionPath(f.packageRoot, next.snapshotSha256), 'utf8')
    ).toBe(serializeTableSnapshot(next.snapshot));
  });

  it('rechecks project ownership before publishing the head after the snapshot', async () => {
    const f = await fixture();
    const before = await readFile(f.paths.headPath, 'utf8');
    let revoked = false;
    const writeAtomic: typeof writeWorkspaceTextFileAtomicInMain = async (input, options) => {
      if (resolve(input.workspaceRoot, input.path) === f.paths.headPath) revoked = true;
      return writeWorkspaceTextFileAtomicInMain(input, options);
    };
    await expect(
      publishTablePackageInMain(
        {
          workspaceRoot: f.workspaceRoot,
          packageRoot: f.packageRoot,
          head: head('revoked edit'),
          mode: 'replace',
          expectedContentHash: f.published.headContentHash,
        },
        {
          assertCurrent() {
            if (revoked) throw new Error('Owner revoked before publication');
          },
          writeAtomic,
        }
      )
    ).rejects.toThrow(/revoked/);
    expect(await readFile(f.paths.headPath, 'utf8')).toBe(before);
  });

  it('reports uncertain publication and settles an exact retry without rewriting either version', async () => {
    const f = await fixture();
    const next = head('published but not acknowledged');
    let allowed = false;
    const directorySync: typeof syncDirectory = async (path) => {
      if (path === dirname(f.paths.headPath) && !allowed)
        throw new Error('Controlled head directory flush failure');
      await syncDirectory(path);
    };
    const request = {
      workspaceRoot: f.workspaceRoot,
      packageRoot: f.packageRoot,
      head: next,
      mode: 'replace' as const,
      expectedContentHash: f.published.headContentHash,
    };
    await expect(
      publishTablePackageInMain(request, { assertCurrent() {}, syncDirectory: directorySync })
    ).rejects.toBeInstanceOf(WorkspaceFilePublicationUncertainError);
    const actual = await readFile(f.paths.headPath, 'utf8');
    expect(actual).toBe(serializeTablePackageHead(next));
    const inode = (await stat(f.paths.headPath)).ino;
    allowed = true;
    const retry = await publishTablePackageInMain(request, {
      assertCurrent() {},
      syncDirectory: directorySync,
    });
    expect(retry.publication).toBe('already-committed');
    expect(retry.headContentHash).toBe(hash(actual));
    expect((await stat(f.paths.headPath)).ino).toBe(inode);
    expect(
      await readFile(tablePackageRevisionPath(f.packageRoot, f.original.snapshotSha256), 'utf8')
    ).toBe(serializeTableSnapshot(f.original.snapshot));
  });

  it('never acknowledges or overwrites a newer different head during uncertain retry', async () => {
    const f = await fixture();
    const next = head('first uncertain');
    const request = {
      workspaceRoot: f.workspaceRoot,
      packageRoot: f.packageRoot,
      head: next,
      mode: 'replace' as const,
      expectedContentHash: f.published.headContentHash,
    };
    const directorySync: typeof syncDirectory = async (path) => {
      if (path === dirname(f.paths.headPath)) throw new Error('Controlled directory flush failure');
      await syncDirectory(path);
    };
    await expect(
      publishTablePackageInMain(request, { assertCurrent() {}, syncDirectory: directorySync })
    ).rejects.toThrow();
    const newest = head('different later edit');
    await publishTablePackageInMain(
      {
        ...request,
        head: newest,
        expectedContentHash: hash(await readFile(f.paths.headPath, 'utf8')),
      },
      { assertCurrent() {} }
    );
    await expect(publishTablePackageInMain(request, { assertCurrent() {} })).rejects.toThrow();
    expect(await readFile(f.paths.headPath, 'utf8')).toBe(serializeTablePackageHead(newest));
  });

  it('rejects a corrupt existing immutable snapshot instead of replacing it', async () => {
    const f = await fixture();
    const next = head('collision snapshot');
    const path = tablePackageRevisionPath(f.packageRoot, next.snapshotSha256);
    await writeFile(path, 'Corrupt existing bytes');
    const before = await readFile(f.paths.headPath, 'utf8');
    await expect(
      publishTablePackageInMain(
        {
          workspaceRoot: f.workspaceRoot,
          packageRoot: f.packageRoot,
          head: next,
          mode: 'replace',
          expectedContentHash: f.published.headContentHash,
        },
        { assertCurrent() {} }
      )
    ).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('Corrupt existing bytes');
    expect(await readFile(f.paths.headPath, 'utf8')).toBe(before);
  });

  it('refuses missing, wrong-owner and future snapshots with no fallback rewrite', async () => {
    const f = await fixture();
    const before = await readFile(f.paths.headPath, 'utf8');
    await expect(
      readTableSnapshotInMain({
        workspaceRoot: f.workspaceRoot,
        packageRoot: f.packageRoot,
        documentId: '923e35de-7ecb-4613-9f85-530f271353c8',
        snapshotSha256: f.original.snapshotSha256,
      })
    ).rejects.toThrow();
    const path = tablePackageRevisionPath(f.packageRoot, f.original.snapshotSha256);
    await rm(path);
    await expect(
      readTablePackageInMain({ workspaceRoot: f.workspaceRoot, packageRoot: f.packageRoot })
    ).rejects.toThrow();
    expect(await readFile(f.paths.headPath, 'utf8')).toBe(before);
    await writeFile(path, JSON.stringify({ schema: 'dnaforge.table-snapshot.v999', documentId }));
    await expect(
      readTablePackageInMain({ workspaceRoot: f.workspaceRoot, packageRoot: f.packageRoot })
    ).rejects.toThrow();
    expect(await readFile(f.paths.headPath, 'utf8')).toBe(before);
  });

  it('rejects a linked metadata directory without reading or changing an outside target', async () => {
    const f = await fixture();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'table-outside-')));
    roots.push(root);
    const target = join(root, '.forge');
    await mkdir(target);
    const before = 'Outside identity must remain exact';
    await writeFile(join(target, 'table.json'), before);
    const linkedPackage = join(f.workspaceRoot, 'Linked');
    await mkdir(linkedPackage);
    await symlink(target, join(linkedPackage, '.forge'), 'dir');
    await expect(
      readTablePackageInMain({ workspaceRoot: f.workspaceRoot, packageRoot: linkedPackage })
    ).rejects.toThrow();
    await expect(
      publishTablePackageInMain(
        {
          workspaceRoot: f.workspaceRoot,
          packageRoot: linkedPackage,
          head: head('must not escape'),
          mode: 'create',
        },
        { assertCurrent() {} }
      )
    ).rejects.toThrow();
    expect(await readFile(join(target, 'table.json'), 'utf8')).toBe(before);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves the actual head during a real POSIX permission denial',
    async () => {
      const f = await fixture();
      const before = await readFile(f.paths.headPath, 'utf8');
      const revisionDir = f.paths.revisionsDirectory;
      await chmod(revisionDir, 0o555);
      try {
        await expect(
          publishTablePackageInMain(
            {
              workspaceRoot: f.workspaceRoot,
              packageRoot: f.packageRoot,
              head: head('retained after permission denial'),
              mode: 'replace',
              expectedContentHash: f.published.headContentHash,
            },
            { assertCurrent() {} }
          )
        ).rejects.toThrow();
        expect(await readFile(f.paths.headPath, 'utf8')).toBe(before);
      } finally {
        await chmod(revisionDir, 0o700);
      }
    }
  );
});
