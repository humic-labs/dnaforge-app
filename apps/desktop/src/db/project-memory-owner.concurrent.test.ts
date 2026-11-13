// @vitest-environment node
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createArtifactCreatedProjectMemoryEvent,
  createProjectMemoryOwner,
  type ProjectMemoryFiles,
} from './project-memory-owner';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('orders journal and projection mutations across owners of the same real project directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixture-memory-'));
  roots.push(root);
  const memory = join(root, '.waypoint/project-memory');
  await mkdir(memory, { recursive: true });
  await writeFile(join(memory, 'events.jsonl'), '');
  const entered = deferred();
  const release = deferred();
  let eventReads = 0;
  const writes = new Map<string, Promise<void>>();
  const fs: ProjectMemoryFiles = {
    exists: (path) =>
      access(path).then(
        () => true,
        () => false
      ),
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    readTextFile: async (path) => {
      const snapshot = await readFile(path, 'utf8');
      if (path.endsWith('events.jsonl') && ++eventReads === 1) {
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    },
    writeTextFile: async (path, content) => {
      const writing = (writes.get(path) ?? Promise.resolve()).then(() =>
        writeFile(path, content, 'utf8')
      );
      writes.set(path, writing);
      await writing;
    },
  };
  const firstOwner = createProjectMemoryOwner(() => fs);
  const secondOwner = createProjectMemoryOwner(() => fs);
  const event = (id: string) =>
    createArtifactCreatedProjectMemoryEvent({
      workspaceRoot: root,
      entityId: id,
      entityKind: 'structure',
      displayName: id,
      filePath: join(root, 'Structures', `${id}.pdb`),
      fileKind: 'structure',
      artifactSchema: 'structure-coordinates.pdb.v1',
    });
  const first = firstOwner.appendProjectMemoryEvent({
    workspaceRoot: root,
    event: event('structure-a'),
  });
  await entered.promise;
  const second = secondOwner.appendProjectMemoryEvent({
    workspaceRoot: `${root}/`,
    event: event('structure-b'),
  });
  await new Promise<void>((done) => setTimeout(done, 25));
  release.resolve();
  await Promise.all([first, second]);
  const final = await firstOwner.readProjectMemory(root);
  expect(final.events.map((record) => record.entityIds[0]).sort()).toEqual([
    'structure-a',
    'structure-b',
  ]);
  for (const name of ['entities', 'files']) {
    const projection = (await readFile(join(memory, `${name}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(projection.map((record) => record.id ?? record.entityId).sort()).toEqual([
      'structure-a',
      'structure-b',
    ]);
  }
  expect(final.manifest?.projectId).toBeTruthy();
});
