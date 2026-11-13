import { basename, join, resolve } from 'path';

import { describe, expect, it } from 'vitest';

import { planMoveIntoDirectory } from '../move-path';

describe('planMoveIntoDirectory', () => {
  it('computes the destination as <destDir>/<basename(source)> for a file', () => {
    const plan = planMoveIntoDirectory('/ws/a/notes.txt', '/ws/b');
    expect(plan).toEqual({ ok: true, destPath: expectedDestPath('/ws/a/notes.txt', '/ws/b') });
  });

  it('computes the destination for a folder', () => {
    const plan = planMoveIntoDirectory('/ws/a/sub', '/ws/b');
    expect(plan).toEqual({ ok: true, destPath: expectedDestPath('/ws/a/sub', '/ws/b') });
  });

  it('rejects a no-op move (item already directly in the destination folder)', () => {
    const plan = planMoveIntoDirectory('/ws/a/notes.txt', '/ws/a');
    expect(plan).toEqual({ ok: false, reason: 'noop' });
  });

  it('rejects moving a folder into itself', () => {
    const plan = planMoveIntoDirectory('/ws/a/sub', '/ws/a/sub');
    expect(plan).toEqual({ ok: false, reason: 'into-self' });
  });

  it('rejects moving a folder into one of its own descendants', () => {
    const plan = planMoveIntoDirectory('/ws/a/sub', '/ws/a/sub/deep/nested');
    expect(plan).toEqual({ ok: false, reason: 'into-self' });
  });

  it('rejects moving a folder into a Windows backslash descendant', () => {
    const plan = planMoveIntoDirectory('C:\\ws\\a\\sub', 'C:\\ws\\a\\sub\\deep\\nested');
    expect(plan).toEqual({ ok: false, reason: 'into-self' });
  });

  it('allows moving a folder into a sibling whose name is a prefix (no false into-self)', () => {
    const plan = planMoveIntoDirectory('/ws/a/sub', '/ws/a/sub2');
    expect(plan).toEqual({ ok: true, destPath: expectedDestPath('/ws/a/sub', '/ws/a/sub2') });
  });

  it('normalizes . and .. segments before planning', () => {
    const plan = planMoveIntoDirectory('/ws/a/./notes.txt', '/ws/a/../b');
    expect(plan).toEqual({
      ok: true,
      destPath: expectedDestPath('/ws/a/./notes.txt', '/ws/a/../b'),
    });
  });
});

function expectedDestPath(sourcePath: string, destinationDir: string): string {
  const src = resolve(sourcePath);
  const destDir = resolve(destinationDir);
  return join(destDir, basename(src));
}
