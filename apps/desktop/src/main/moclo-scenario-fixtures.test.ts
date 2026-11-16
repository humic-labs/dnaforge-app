import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSequencePackageDocument } from '../db/sequence-package';
import type { MaterializeMocloScenarioKitRequest } from '../shared/internal-fixtures';
import { materializeMocloScenarioKit } from './moclo-scenario-fixtures';
import { admitRegisteredProjectRootInMain } from './project-root-admission';
import {
  assertProjectFilesystemMutationAllowed,
  resolveProjectRootInMain,
} from './project-filesystem-authority';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';

vi.mock('electron', () => ({ app: { getPath: () => '/unused-scenario-profile' } }));

const resources = resolve(import.meta.dirname, '../../resources/sample-workspaces');
const source = join(resources, 'standard-samples/workspace');

describe('native bundled MoClo scenario materialization', () => {
  let directory: string;
  let project: string;
  let managedRootDir: string;
  let db: Database.Database;
  let workspaceId: number;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'moclo-native-scenario-')));
    managedRootDir = join(directory, 'managed');
    project = join(directory, 'project');
    await mkdir(project);
    db = createTestDb();
    ensureSchema(db, ':memory:');
    workspaceId = (await resolveProjectRootInMain({ path: project }, { db, managedRootDir }))
      .workspaceId;
  });

  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const assertCurrent = () => {
    admitRegisteredProjectRootInMain(project, { db, managedRootDir });
    assertKnownWorkspaceContentWritable(db, project);
  };
  const materialize = (reuseExisting?: true) =>
    materializeMocloScenarioKit(
      {
        workspaceRoot: project,
        presetId: 'cidar-moclo-red-fluorescent-tu',
        ...(reuseExisting ? { reuseExisting } : {}),
      },
      resources,
      assertCurrent
    );

  it.each([
    ['cidar-moclo-red-fluorescent-tu', 'cidar', 91],
    ['cidar-moclo-mixed-route-red-fluorescent-tu', 'cidar', 91],
    ['ytk-moclo-factory-expression-cassette', 'ytk', 96],
  ] as const)(
    'copies only the bundled %s kit with independent identities and original product bytes',
    async (presetId, kitId, count) => {
      const result = await materializeMocloScenarioKit(
        { workspaceRoot: project, presetId },
        resources,
        assertCurrent
      );
      expect(result.packages).toHaveLength(count);
      expect(result.files).toHaveLength(count * 2 + 1);
      expect(new Set(result.packages.map((item) => item.packageId)).size).toBe(count);
      for (const item of result.packages) {
        expect(item.packageId).not.toBe(item.sourcePackageId);
        const meta = `${item.relativeRoot}/.forge/plasmid.json`;
        const original = parseSequencePackageDocument(await readFile(join(source, meta), 'utf8'));
        const copied = parseSequencePackageDocument(await readFile(join(project, meta), 'utf8'));
        expect(copied).toEqual({ ...original, id: item.packageId });
        expect(await readFile(join(project, item.productRelativePath))).toEqual(
          await readFile(join(source, item.productRelativePath))
        );
      }
      const kit = JSON.parse(
        await readFile(join(project, `.forge/moclo-kits/${kitId}.json`), 'utf8')
      );
      const identities = new Map(
        result.packages.map((item) => [item.sourcePackageId, item.packageId])
      );
      const originalKit = JSON.parse(
        await readFile(join(source, `.forge/moclo-kits/${kitId}.json`), 'utf8')
      );
      expect(kit).toEqual({
        ...originalKit,
        members: originalKit.members.map((member: { id: string; sequencePackageId: string }) => ({
          ...member,
          id: identities.get(member.id) ?? member.id,
          sequencePackageId: identities.get(member.sequencePackageId),
        })),
      });
      await expect(
        assertProjectFilesystemMutationAllowed(
          db,
          [join(project, `.forge/moclo-kits/${kitId}.json`)],
          managedRootDir
        )
      ).rejects.toThrow('PROJECT_FILESYSTEM_AUTHORITY_REQUIRED');
      expect(
        (await readdir(project)).filter((entry) => entry.startsWith('.dnaforge-moclo-scenario-'))
      ).toEqual([]);
    }
  );

  it('keeps copies in separate projects independent and reuses only unchanged fixture bytes', async () => {
    const first = await materialize();
    expect(await materialize(true)).toEqual(first);
    const originalProject = project;
    project = join(directory, 'another-project');
    await mkdir(project);
    await resolveProjectRootInMain({ path: project }, { db, managedRootDir });
    const second = await materialize();
    const firstIds = new Set(first.packages.map((item) => item.packageId));
    expect(second.packages.some((item) => firstIds.has(item.packageId))).toBe(false);
    project = originalProject;
    const changed = join(project, first.packages[0].productRelativePath);
    await writeFile(changed, 'User-edited source must survive');
    await expect(materialize(true)).rejects.toThrow('changed and was preserved');
    expect(await readFile(changed, 'utf8')).toBe('User-edited source must survive');
  });

  it('refuses existing destinations without changing their files', async () => {
    const occupied = join(project, 'sequences/kits/moclo-cidar');
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, 'unrelated.txt'), 'retained');
    await expect(materialize()).rejects.toThrow('destination already exists');
    expect(await readFile(join(occupied, 'unrelated.txt'), 'utf8')).toBe('retained');
    expect(await readdir(project)).toEqual(['sequences']);
  });

  it('refuses unknown preset identities and linked protected directories', async () => {
    await expect(
      materializeMocloScenarioKit(
        {
          workspaceRoot: project,
          presetId: '../arbitrary',
        } as unknown as MaterializeMocloScenarioKitRequest,
        resources,
        assertCurrent
      )
    ).rejects.toThrow('registered bundled scenario');
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'unrelated.txt'), 'retained');
    await symlink(outside, join(project, '.forge'), 'dir');
    await expect(materialize()).rejects.toThrow('physical directory');
    expect(await readdir(outside)).toEqual(['unrelated.txt']);
    expect(
      (await readdir(project)).filter((entry) => entry.startsWith('.dnaforge-moclo-scenario-'))
    ).toEqual([]);
  });

  it.each(['reference', 'archived', 'missing'] as const)(
    'refuses %s project authority before staging',
    async (state) => {
      if (state === 'reference')
        db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(workspaceId);
      if (state === 'archived')
        db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=?').run(workspaceId);
      if (state === 'missing') db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await expect(materialize()).rejects.toThrow(/writable|unavailable/);
      expect(await readdir(project)).toEqual([]);
    }
  );

  it('cleans only its unpublished stage if authority changes before publication', async () => {
    await writeFile(join(project, 'unrelated.txt'), 'retained');
    let calls = 0;
    await expect(
      materializeMocloScenarioKit(
        { workspaceRoot: project, presetId: 'cidar-moclo-red-fluorescent-tu' },
        resources,
        () => {
          assertCurrent();
          if (++calls === 2) throw new Error('authority changed');
        }
      )
    ).rejects.toThrow('authority changed');
    expect(await readdir(project)).toEqual(['unrelated.txt']);
    expect(await readFile(join(project, 'unrelated.txt'), 'utf8')).toBe('retained');
  });

  it('reports retained package files if the second publication fails', async () => {
    await writeFile(join(project, 'unrelated.txt'), 'retained');
    let calls = 0;
    const error = await materializeMocloScenarioKit(
      { workspaceRoot: project, presetId: 'cidar-moclo-red-fluorescent-tu' },
      resources,
      () => {
        assertCurrent();
        if (++calls === 3) throw new Error('definition publication unavailable');
      }
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'MOCLO_SCENARIO_PUBLICATION_INCOMPLETE',
      stateMayHaveChanged: true,
      publishedPaths: [join(project, 'sequences/kits/moclo-cidar')],
    });
    expect(String(error)).toContain('definition publication unavailable');
    expect(await readdir(join(project, 'sequences/kits/moclo-cidar'))).toHaveLength(91);
    await expect(readFile(join(project, '.forge/moclo-kits/cidar.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(project, 'unrelated.txt'), 'utf8')).toBe('retained');
    expect(
      (await readdir(project)).filter((entry) => entry.startsWith('.dnaforge-moclo-scenario-'))
    ).toEqual([]);
  });

  it('preserves a competing definition created after the destination check', async () => {
    const definition = join(project, '.forge/moclo-kits/cidar.json');
    let calls = 0;
    const error = await materializeMocloScenarioKit(
      { workspaceRoot: project, presetId: 'cidar-moclo-red-fluorescent-tu' },
      resources,
      () => {
        assertCurrent();
        if (++calls === 3) writeFileSync(definition, 'competing definition bytes', { flag: 'wx' });
      }
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'MOCLO_SCENARIO_PUBLICATION_INCOMPLETE',
      stateMayHaveChanged: true,
      publishedPaths: [join(project, 'sequences/kits/moclo-cidar')],
    });
    expect(await readFile(definition, 'utf8')).toBe('competing definition bytes');
    expect(await readdir(join(project, '.forge/moclo-kits'))).toEqual(['cidar.json']);
    expect(await readdir(join(project, 'sequences/kits/moclo-cidar'))).toHaveLength(91);
    expect(
      (await readdir(project)).filter((entry) => entry.startsWith('.dnaforge-moclo-scenario-'))
    ).toEqual([]);
  });
});
