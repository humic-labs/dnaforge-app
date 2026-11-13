import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeTextFileAtomicInMain } from './text-file-atomic';
import { assertTextFileAtomicWriteInput } from '../shared/text-file-atomic';

describe('general atomic text-file writer', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dnaforge-atomic-text-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('atomically replaces an existing destination with complete UTF-8 content', async () => {
    const destination = join(root, 'saved-view.json');
    writeFileSync(destination, 'old-content', 'utf8');

    await writeTextFileAtomicInMain({ path: destination, content: 'new-content' });

    expect(readFileSync(destination, 'utf8')).toBe('new-content');
    expect(readdirSync(root)).toEqual(['saved-view.json']);
  });

  it('atomically creates a destination that does not exist yet', async () => {
    const destination = join(root, 'new-view.json');

    await writeTextFileAtomicInMain({ path: destination, content: 'new-content' });

    expect(readFileSync(destination, 'utf8')).toBe('new-content');
    expect(readdirSync(root)).toEqual(['new-view.json']);
  });

  it('preserves an external edit when the saved baseline no longer matches', async () => {
    const destination = join(root, 'shared.txt');
    writeFileSync(destination, 'external edit');
    const input = {
      path: destination,
      content: 'agent draft',
      expectedContentHash: `sha256:${createHash('sha256').update('original').digest('hex')}`,
    };
    await expect(writeTextFileAtomicInMain(input)).rejects.toThrow('FILE_CHANGED');
    expect(readFileSync(destination, 'utf8')).toBe('external edit');
    expect(readdirSync(root)).toEqual(['shared.txt']);
  });

  it('publishes only one of competing saves against the same disk revision', async () => {
    const destination = join(root, 'competing.txt');
    writeFileSync(destination, 'original');
    const expectedContentHash = `sha256:${createHash('sha256').update('original').digest('hex')}`;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        writeTextFileAtomicInMain({
          path: destination,
          content: `draft ${index}`,
          expectedContentHash,
        })
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    expect(readFileSync(destination, 'utf8')).toBe(`draft ${winner}`);
    for (const result of results) {
      if (result.status === 'rejected') expect(String(result.reason)).toContain('FILE_CHANGED');
    }
    expect(readdirSync(root)).toEqual(['competing.txt']);
  });

  it('rejects renderer attempts to widen the operation beyond path and content', () => {
    expect(() =>
      assertTextFileAtomicWriteInput({
        path: join(root, 'saved-view.json'),
        content: 'inert-content',
        workspaceRoot: root,
      })
    ).toThrow('must contain only path and content');
  });

  it('syncs and closes the sibling temporary file before the atomic rename', async () => {
    const destination = join(root, 'saved-view.json');
    const events: string[] = [];

    await writeTextFileAtomicInMain(
      { path: destination, content: 'complete-content' },
      {
        temporaryId: () => 'INERT_CANARY',
        openFile: async (path) => {
          expect(dirname(path)).toBe(root);
          expect(path).not.toBe(destination);
          events.push('open');
          return {
            writeFile: async (content, encoding) => {
              expect(content).toBe('complete-content');
              expect(encoding).toBe('utf8');
              events.push('write');
            },
            sync: async () => {
              events.push('sync');
            },
            close: async () => {
              events.push('close');
            },
          };
        },
        renameFile: async (temporaryPath, finalPath) => {
          expect(dirname(temporaryPath)).toBe(root);
          expect(finalPath).toBe(destination);
          events.push('rename');
        },
        removeFile: vi.fn(),
      }
    );

    expect(events).toEqual(['open', 'write', 'sync', 'close', 'rename']);
  });

  it('removes the sibling temporary file when atomic replacement fails', async () => {
    const destination = join(root, 'saved-view.json');
    writeFileSync(destination, 'preserved-content', 'utf8');

    await expect(
      writeTextFileAtomicInMain(
        { path: destination, content: 'uncommitted-content' },
        {
          temporaryId: () => 'INERT_CANARY',
          renameFile: async () => {
            throw new Error('simulated atomic replace outage');
          },
        }
      )
    ).rejects.toThrow('simulated atomic replace outage');

    expect(readFileSync(destination, 'utf8')).toBe('preserved-content');
    expect(existsSync(join(root, '.saved-view.json.dnaforge-tmp-INERT_CANARY'))).toBe(false);
    expect(readdirSync(root)).toEqual(['saved-view.json']);
  });
});

describe('atomic text publication authority', () => {
  it('keeps original bytes and cleans the temporary file when current authority refuses publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-atomic-authority-'));
    const destination = join(root, 'saved.txt');
    writeFileSync(destination, 'original');
    try {
      await expect(
        writeTextFileAtomicInMain(
          { path: destination, content: 'new' },
          {
            beforePublish: () => {
              throw new Error('access changed');
            },
          }
        )
      ).rejects.toThrow('access changed');
      expect(readFileSync(destination, 'utf8')).toBe('original');
      expect(readdirSync(root)).toEqual(['saved.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
