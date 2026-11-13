// @vitest-environment node
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { appendProjectMemoryEventInMain } from './project-memory';
import { createArtifactCreatedProjectMemoryEvent } from '../db/project-memory-owner';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const event = (root: string, id: string) =>
  createArtifactCreatedProjectMemoryEvent({
    workspaceRoot: root,
    entityId: id,
    entityKind: 'structure',
    displayName: id,
    filePath: join(root, 'Structures', `${id}.pdb`),
    fileKind: 'structure',
    artifactSchema: 'structure-coordinates.pdb.v1',
  });

it('serializes canonical project identity across native callers and keeps all disk projections', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fixture-native-memory-')));
  const aliases = await realpath(await mkdtemp(join(tmpdir(), 'fixture-memory-alias-')));
  roots.push(root, aliases);
  const alias = join(aliases, 'project');
  await symlink(root, alias);
  const saves = await Promise.all(
    ['structure-a', 'structure-b'].map((id, index) =>
      appendProjectMemoryEventInMain(
        { workspaceRoot: index ? alias : root, event: event(root, id) },
        () => {}
      )
    )
  );
  expect(saves[0].manifest?.projectId).toBe(saves[1].manifest?.projectId);
  for (const name of ['events', 'entities', 'files']) {
    const content = await readFile(join(root, '.waypoint/project-memory', `${name}.jsonl`), 'utf8');
    const records = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      records.map((record) => record.entityIds?.[0] ?? record.entityId ?? record.id).sort()
    ).toEqual(['structure-a', 'structure-b']);
  }
});

it('releases a rejected event so a later valid operation can publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixture-native-memory-retry-'));
  roots.push(root);
  const invalid = event(root, 'invalid');
  invalid.paths = [{ current: '../outside' }];
  const rejected = appendProjectMemoryEventInMain(
    { workspaceRoot: root, event: invalid },
    () => {}
  );
  const accepted = appendProjectMemoryEventInMain(
    { workspaceRoot: root, event: event(root, 'valid') },
    () => {}
  );
  await expect(rejected).rejects.toThrow(/parent/);
  expect((await accepted).events.map((record) => record.entityIds[0])).toEqual(['valid']);
});
