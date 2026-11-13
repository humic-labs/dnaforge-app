import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishNativeCatalogBytes,
  readNativeCatalogPublicationBase,
  pruneCompletedNativeCatalogPublication,
} from './native-catalog-publication';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
  return { ...wrapped, default: wrapped };
});

describe('checked native catalog publication', () => {
  let workspacePath: string;
  let destination: string;
  const operationId = 'catalog-test-operation';
  const beforeBytes = Buffer.from('{"value":"before"}');
  const afterBytes = Buffer.from('{"value":"after"}');
  const userBytes = Buffer.from('{"value":"later user edit"}');
  const privateFile = (name: string) =>
    join(
      workspacePath,
      '.dnaforge',
      'migration',
      'catalog-publications',
      createHash('sha256').update(operationId).digest('hex'),
      name
    );
  const input = () => ({ workspacePath, operationId, beforeBytes, afterBytes });
  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(join(tmpdir(), 'native-catalog-publication-'));
    destination = join(workspacePath, '.forge', 'catalog.json');
    await fs.mkdir(join(workspacePath, '.forge'));
    await fs.writeFile(destination, beforeBytes);
  });
  afterEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    vi.mocked(fs.link).mockImplementation(actual.link);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('publishes once, retains separate before/after evidence, and retries without writing another edit', async () => {
    await publishNativeCatalogBytes(input());
    expect(await fs.readFile(destination)).toEqual(afterBytes);
    expect(await fs.readFile(privateFile('before.json'))).toEqual(beforeBytes);
    expect(await fs.readFile(privateFile('after.json'))).toEqual(afterBytes);
    const stat = await fs.stat(destination);
    await publishNativeCatalogBytes(input());
    expect((await fs.stat(destination)).ino).toBe(stat.ino);
    await fs.writeFile(destination, userBytes);
    expect(await fs.readFile(privateFile('after.json'))).toEqual(afterBytes);
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(/changed after completed/);
    expect(await fs.readFile(destination)).toEqual(userBytes);
  });

  it('binds a generic artifact publication to its exact destination', async () => {
    const relativePath = 'records/specimen.entity.json';
    await fs.mkdir(join(workspacePath, 'records'));
    await fs.writeFile(join(workspacePath, relativePath), beforeBytes);
    await publishNativeCatalogBytes({ ...input(), relativePath });
    expect(await fs.readFile(join(workspacePath, relativePath))).toEqual(afterBytes);
    expect(await fs.readFile(destination)).toEqual(beforeBytes);
    await expect(
      publishNativeCatalogBytes({ ...input(), relativePath: 'records/other.entity.json' })
    ).rejects.toThrow(/different destination/);
    await expect(
      publishNativeCatalogBytes({ ...input(), relativePath: '../outside.json' })
    ).rejects.toThrow(/safe workspace-relative/);
  });

  it('creates a missing catalog but never adopts an unowned matching file', async () => {
    await fs.rm(destination);
    await publishNativeCatalogBytes({ ...input(), beforeBytes: null });
    expect(await fs.readFile(destination)).toEqual(afterBytes);
    await expect(
      publishNativeCatalogBytes({
        ...input(),
        beforeBytes: null,
        operationId: 'different-operation',
      })
    ).rejects.toThrow(/ownership/);
  });

  it('prunes completed recovery copies without losing retry protection or later edits', async () => {
    await publishNativeCatalogBytes(input());
    await pruneCompletedNativeCatalogPublication(input());
    await pruneCompletedNativeCatalogPublication(input());
    for (const name of ['before.json', 'after.json', 'install.json'])
      await expect(fs.stat(privateFile(name))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(destination)).toEqual(afterBytes);
    await publishNativeCatalogBytes(input());
    await fs.writeFile(destination, userBytes);
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(/changed after completed/);
    await pruneCompletedNativeCatalogPublication(input());
    expect(await fs.readFile(destination)).toEqual(userBytes);
  });

  it('does not prune the only preimage of an interrupted publication', async () => {
    const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      await rename(from, to);
      if (from === destination) throw new Error('Interrupted');
    });
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow('Interrupted');
    await expect(pruneCompletedNativeCatalogPublication(input())).rejects.toThrow(/incomplete/);
    expect(await fs.readFile(privateFile('before.json'))).toEqual(beforeBytes);
    expect(await fs.readFile(privateFile('after.json'))).toEqual(afterBytes);
  });

  it.each(['before-install', 'after-install', 'before-complete', 'after-complete'] as const)(
    'resumes first catalog creation after interruption %s',
    async (boundary) => {
      await fs.rm(destination);
      const { link } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(fs.link).mockImplementation(async (from, to) => {
        const relevant =
          (to === destination && boundary.includes('install')) ||
          (to === privateFile('complete') && boundary.includes('complete'));
        if (relevant && boundary.startsWith('before-')) throw new Error('Creation interrupted');
        await link(from, to);
        if (relevant && boundary.startsWith('after-')) throw new Error('Creation interrupted');
      });
      const create = { ...input(), beforeBytes: null };
      await expect(publishNativeCatalogBytes(create)).rejects.toThrow('Creation interrupted');
      vi.mocked(fs.link).mockImplementation(link);
      expect(await readNativeCatalogPublicationBase(create)).toEqual(
        boundary === 'before-install' ? null : afterBytes
      );
      await publishNativeCatalogBytes(create);
      expect(await fs.readFile(destination)).toEqual(afterBytes);
    }
  );

  it.each([
    'before-displacement',
    'after-displacement',
    'before-install',
    'after-install',
    'before-complete',
    'after-complete',
  ] as const)('resumes after interruption at %s', async (boundary) => {
    const { rename, link } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let interrupted = false;
    const fail = () => {
      interrupted = true;
      throw new Error('Simulated process interruption');
    };
    const fault = boundary.includes('displacement')
      ? vi.mocked(fs.rename).mockImplementation(async (from, to) => {
          if (from === destination && boundary === 'before-displacement') fail();
          await rename(from, to);
          if (from === destination && boundary === 'after-displacement') fail();
        })
      : vi.mocked(fs.link).mockImplementation(async (from, to) => {
          const relevant =
            (to === destination && boundary.includes('install')) ||
            (to === privateFile('complete') && boundary.includes('complete'));
          if (relevant && boundary.startsWith('before-')) fail();
          await link(from, to);
          if (relevant && boundary.startsWith('after-')) fail();
        });
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(
      'Simulated process interruption'
    );
    expect(interrupted).toBe(true);
    fault.mockReset();
    vi.mocked(fs.rename).mockImplementation(rename);
    vi.mocked(fs.link).mockImplementation(link);
    expect(await readNativeCatalogPublicationBase(input())).toEqual(
      boundary === 'after-install' || boundary.includes('complete') ? afterBytes : beforeBytes
    );
    await publishNativeCatalogBytes(input());
    expect(await fs.readFile(destination)).toEqual(afterBytes);
    expect(await fs.readFile(privateFile('before.json'))).toEqual(beforeBytes);
  });

  it('preserves a user edit that wins the displacement race', async () => {
    const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (from === destination) await fs.writeFile(destination, userBytes);
      await rename(from, to);
    });
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(/changed during displacement/);
    expect(await fs.readFile(destination)).toEqual(userBytes);
    expect(await fs.readFile(privateFile('before.json'))).toEqual(userBytes);
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(/changed during displacement/);
  });

  it('never overwrites a file created after displacement and before installation', async () => {
    const { link } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.link).mockImplementation(async (from, to) => {
      if (to === destination) await fs.writeFile(destination, userBytes);
      await link(from, to);
    });
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(/EEXIST/);
    expect(await fs.readFile(destination)).toEqual(userBytes);
    expect(await fs.readFile(privateFile('before.json'))).toEqual(beforeBytes);
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(/another writer/);
  });

  it('does not recreate a catalog deleted after completed publication', async () => {
    await publishNativeCatalogBytes(input());
    await fs.rm(destination);
    await expect(readNativeCatalogPublicationBase(input())).rejects.toThrow(
      /changed after completed/
    );
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(/changed after completed/);
    await expect(fs.stat(destination)).rejects.toThrow(/ENOENT/);
  });

  it('rejects operation reuse and changed staging evidence', async () => {
    await publishNativeCatalogBytes(input());
    await expect(publishNativeCatalogBytes({ ...input(), afterBytes: userBytes })).rejects.toThrow(
      /different content/
    );
    await fs.writeFile(privateFile('after.json'), userBytes);
    await expect(publishNativeCatalogBytes(input())).rejects.toThrow(/staged bytes changed/);
    expect(await fs.readFile(destination)).toEqual(afterBytes);
  });
});
