import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { link } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sha256Text,
  writeWorkspaceBinaryFileAtomicInMain,
  writeWorkspaceTextFileAtomicInMain,
  WorkspaceFilePublicationUncertainError,
} from './primer-artifact-files';

describe('main-process workspace artifact writes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'primer-atomic-artifact-'));
    mkdirSync(join(root, 'primers'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flushes a durable replacement before reporting completion', async () => {
    const path = join(root, 'document.gb');
    const original = await writeWorkspaceTextFileAtomicInMain({
      workspaceRoot: root,
      path,
      mode: 'create',
      content: 'before',
    });
    const syncDirectory = vi.fn(async () => {
      expect(readFileSync(path, 'utf8')).toBe('after');
    });
    await writeWorkspaceTextFileAtomicInMain(
      {
        workspaceRoot: root,
        path,
        mode: 'replace',
        content: 'after',
        expectedContentHash: original.contentHash,
      },
      { durable: true, syncDirectory }
    );
    expect(syncDirectory).toHaveBeenCalledWith(realpathSync(root));
  });

  it('refuses an asynchronous publication check instead of treating its Promise as authority', async () => {
    const path = join(root, 'document.gb');
    const original = await writeWorkspaceTextFileAtomicInMain({
      workspaceRoot: root,
      path,
      mode: 'create',
      content: 'before',
    });
    await expect(
      writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot: root,
          path,
          mode: 'replace',
          content: 'after',
          expectedContentHash: original.contentHash,
        },
        { durable: true, beforePublish: async () => undefined }
      )
    ).rejects.toThrow(/synchronous/i);
    expect(readFileSync(path, 'utf8')).toBe('before');
  });

  it('flushes a durable creation only after publishing its destination', async () => {
    const path = join(root, 'created.gb');
    const syncDirectory = vi.fn(async () => {
      expect(readFileSync(path, 'utf8')).toBe('created');
    });
    await writeWorkspaceTextFileAtomicInMain(
      {
        workspaceRoot: root,
        path,
        mode: 'create',
        content: 'created',
      },
      { durable: true, syncDirectory }
    );
    expect(syncDirectory).toHaveBeenCalledOnce();
  });

  it('does not disguise a directory flush failure as an unchanged file', async () => {
    const path = join(root, 'document.gb');
    const original = await writeWorkspaceTextFileAtomicInMain({
      workspaceRoot: root,
      path,
      mode: 'create',
      content: 'before',
    });
    await expect(
      writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot: root,
          path,
          mode: 'replace',
          content: 'after',
          expectedContentHash: original.contentHash,
        },
        {
          durable: true,
          syncDirectory: async () => {
            throw new Error('flush failed');
          },
        }
      )
    ).rejects.toBeInstanceOf(WorkspaceFilePublicationUncertainError);
    expect(readFileSync(path, 'utf8')).toBe('after');
  });

  it('rejects dot-segment escape before writing', async () => {
    await expect(
      writeWorkspaceTextFileAtomicInMain({
        workspaceRoot: root,
        path: join(root, 'primers', '..', '..', 'escaped.primer.json'),
        content: 'escaped',
        mode: 'create',
      })
    ).rejects.toThrow(/inside the owning workspace/i);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a parent symlink that escapes the workspace',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'primer-symlink-target-'));
      symlinkSync(outside, join(root, 'linked'));
      try {
        await expect(
          writeWorkspaceTextFileAtomicInMain({
            workspaceRoot: root,
            path: join(root, 'linked', 'must-not-exist', 'escaped.primer.json'),
            content: 'escaped',
            mode: 'create',
          })
        ).rejects.toThrow(/inside the owning workspace/i);
        expect(existsSync(join(outside, 'must-not-exist'))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects an internal parent symlink whose lexical manifest path is not discoverable',
    async () => {
      const actualDirectory = join(root, 'actual');
      mkdirSync(actualDirectory);
      symlinkSync(actualDirectory, join(root, 'linked'));

      await expect(
        writeWorkspaceTextFileAtomicInMain({
          workspaceRoot: root,
          path: join(root, 'linked', 'internal.primer.json'),
          content: 'internal',
          mode: 'create',
        })
      ).rejects.toThrow(/symbolic links/i);
      expect(existsSync(join(actualDirectory, 'internal.primer.json'))).toBe(false);
    }
  );

  it('allows exactly one concurrent create for the same destination', async () => {
    const path = join(root, 'primers', 'race.primer.json');
    const results = await Promise.allSettled([
      writeWorkspaceTextFileAtomicInMain({
        workspaceRoot: root,
        path,
        content: 'first',
        mode: 'create',
      }),
      writeWorkspaceTextFileAtomicInMain({
        workspaceRoot: root,
        path,
        content: 'second',
        mode: 'create',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(readFileSync(path, 'utf8'));
  });

  it('atomically writes exact binary bytes and refuses to overwrite them', async () => {
    const path = join(root, 'papers', 'source.pdf');
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 255]);

    const result = await writeWorkspaceBinaryFileAtomicInMain({
      workspaceRoot: root,
      path,
      content: bytes,
      artifactNoun: 'paper source',
    });

    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      writeWorkspaceBinaryFileAtomicInMain({
        workspaceRoot: root,
        path,
        content: bytes,
        artifactNoun: 'paper source',
      })
    ).rejects.toThrow(/already exists/i);
  });

  it.each(['text', 'binary'])(
    'preserves the main-owned %s publication callback receiver',
    async (kind) => {
      const path = join(root, 'primers', `receiver-${kind}.artifact`);
      let checked = false;
      const fsOps = {
        marker: 'original callback receiver',
        beforePublish() {
          checked = true;
          expect(this.marker).toBe('original callback receiver');
        },
      };
      if (kind === 'text') {
        await writeWorkspaceTextFileAtomicInMain(
          { workspaceRoot: root, path, content: 'unchanged text contract', mode: 'create' },
          fsOps
        );
      } else {
        await writeWorkspaceBinaryFileAtomicInMain(
          { workspaceRoot: root, path, content: new Uint8Array([0, 255]) },
          fsOps
        );
      }
      expect(checked).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
  );

  it('checks binary publication authority after writing complete temporary bytes and cleans refusal', async () => {
    const path = join(root, 'primers', 'guarded.bin');
    const bytes = new Uint8Array([0, 128, 255]);
    const linkFile = vi.fn(link);
    const beforePublish = vi.fn(() => {
      const temporary = readdirSync(join(root, 'primers')).find((name) =>
        name.startsWith('guarded.bin.tmp-')
      );
      if (!temporary) throw new Error('Complete temporary binary is missing');
      expect(readFileSync(join(root, 'primers', temporary))).toEqual(Buffer.from(bytes));
      throw new Error('Current binary owner is view only');
    });
    await expect(
      writeWorkspaceBinaryFileAtomicInMain(
        { workspaceRoot: root, path, content: bytes },
        { link: linkFile, beforePublish }
      )
    ).rejects.toThrow('Current binary owner is view only');
    expect(beforePublish).toHaveBeenCalledOnce();
    expect(linkFile).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(root, 'primers'))).toEqual([]);
  });

  it('refuses an asynchronously rejected binary publication check without publishing', async () => {
    const path = join(root, 'primers', 'async-guard.bin');
    await expect(
      writeWorkspaceBinaryFileAtomicInMain(
        { workspaceRoot: root, path, content: new Uint8Array([0, 255]) },
        { beforePublish: () => Promise.reject(new Error('A Promise is not authority')) }
      )
    ).rejects.toThrow(/synchronous/i);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(root, 'primers'))).toEqual([]);
  });

  it('keeps binary success and cleanup warnings after the canonical link commits', async () => {
    const path = join(root, 'primers', 'committed.bin');
    const bytes = new Uint8Array([0, 128, 255]);
    let writable = true;
    const beforePublish = vi.fn(() => {
      if (!writable) throw new Error('Owner was demoted after commit');
    });
    const result = await writeWorkspaceBinaryFileAtomicInMain(
      { workspaceRoot: root, path, content: bytes },
      {
        beforePublish,
        link: async (...args: Parameters<typeof link>) => {
          await link(...args);
          writable = false;
        },
        unlink: async () => {
          throw new Error('Binary cleanup outage');
        },
      }
    );
    expect(beforePublish).toHaveBeenCalledOnce();
    expect(result).toEqual({
      path: realpathSync(path),
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      cleanupWarning: expect.stringContaining('Binary cleanup outage'),
    });
    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
  });

  it('reports retained temporary bytes when binary authority and cleanup both fail', async () => {
    const path = join(root, 'primers', 'refused.bin');
    const bytes = new Uint8Array([0, 128, 255]);
    let caught: unknown;
    try {
      await writeWorkspaceBinaryFileAtomicInMain(
        { workspaceRoot: root, path, content: bytes },
        {
          beforePublish: () => {
            throw new Error('Current binary owner is view only');
          },
          unlink: async () => {
            throw new Error('Binary cleanup outage');
          },
        }
      );
    } catch (error) {
      caught = error;
    }
    const temporaries = readdirSync(join(root, 'primers'));
    expect(temporaries).toHaveLength(1);
    const temporary = temporaries[0];
    if (!temporary) throw new Error('Retained temporary binary is missing');
    expect(caught).toMatchObject({
      name: 'WorkspaceFilePreconditionError',
      message: 'Current binary owner is view only',
      partialEffects: [
        {
          kind: 'temporary-workspace-file',
          path: join(realpathSync(root), 'primers', temporary),
          cleanupError: 'Binary cleanup outage',
        },
      ],
    });
    expect(readFileSync(join(root, 'primers', temporary))).toEqual(Buffer.from(bytes));
    expect(existsSync(path)).toBe(false);
  });

  it('rejects a binary parent symlink escape before creating directories', async () => {
    if (process.platform === 'win32') return;
    const outside = mkdtempSync(join(tmpdir(), 'fixture-binary-symlink-target-'));
    symlinkSync(outside, join(root, 'linked-binary'));
    try {
      await expect(
        writeWorkspaceBinaryFileAtomicInMain({
          workspaceRoot: root,
          path: join(root, 'linked-binary', 'nested', 'source.pdf'),
          content: new Uint8Array([1, 2, 3]),
          artifactNoun: 'paper source',
        })
      ).rejects.toThrow(/inside the owning workspace/i);
      expect(existsSync(join(outside, 'nested'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports create success with a cleanup warning after the canonical hard-link commits', async () => {
    const path = join(root, 'primers', 'cleanup-warning.primer.json');
    const result = await writeWorkspaceTextFileAtomicInMain(
      {
        workspaceRoot: root,
        path,
        content: 'committed-content',
        mode: 'create',
      },
      {
        unlink: async () => {
          throw new Error('simulated cleanup outage');
        },
      }
    );

    expect(readFileSync(path, 'utf8')).toBe('committed-content');
    expect(result).toMatchObject({
      path: realpathSync(path),
      cleanupWarning: expect.stringContaining('simulated cleanup outage'),
    });
  });

  it('reports an orphan temporary file when commit and cleanup both fail', async () => {
    const path = join(root, 'primers', 'failed-commit.primer.json');
    let caught: unknown;
    try {
      await writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot: root,
          path,
          content: 'uncommitted-content',
          mode: 'create',
        },
        {
          link: async () => {
            throw new Error('simulated commit outage');
          },
          unlink: async () => {
            throw new Error('simulated cleanup outage');
          },
        }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      message: 'simulated commit outage',
      partialEffects: [
        {
          kind: 'temporary-workspace-file',
          path: expect.stringContaining('failed-commit.primer.json.tmp-'),
          cleanupError: 'simulated cleanup outage',
        },
      ],
    });
    const temporaryPath = (caught as { partialEffects: Array<{ path: string }> }).partialEffects[0]
      .path;
    expect(existsSync(temporaryPath)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('uses the caller-supplied artifactNoun in error copy, instead of a hardcoded "Primer" for a non-primer write', async () => {
    await expect(
      writeWorkspaceTextFileAtomicInMain({
        workspaceRoot: root,
        path: join(root, 'primers', '..', '..', 'escaped.faa'),
        content: 'escaped',
        mode: 'create',
        artifactNoun: 'protein',
      })
    ).rejects.toThrow(/protein files must be saved inside the owning workspace/i);
  });

  it('still defaults to "primer" error copy when artifactNoun is omitted (backward compatible)', async () => {
    await expect(
      writeWorkspaceTextFileAtomicInMain({
        workspaceRoot: root,
        path: join(root, 'primers', '..', '..', 'escaped.primer.json'),
        content: 'escaped',
        mode: 'create',
      })
    ).rejects.toThrow(/^Primer files must be saved inside the owning workspace\.$/);
  });

  it('rejects a stale optimistic replacement without changing the file', async () => {
    const path = join(root, 'primers', 'replace.primer.json');
    await writeWorkspaceTextFileAtomicInMain({
      workspaceRoot: root,
      path,
      content: 'revision-one',
      mode: 'create',
    });

    await expect(
      writeWorkspaceTextFileAtomicInMain({
        workspaceRoot: root,
        path,
        content: 'revision-two',
        mode: 'replace',
        expectedContentHash: await sha256Text('not-the-current-content'),
      })
    ).rejects.toThrow(/changed since it was opened/i);
    expect(readFileSync(path, 'utf8')).toBe('revision-one');
  });
});
