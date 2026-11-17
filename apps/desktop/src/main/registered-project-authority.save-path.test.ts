// @vitest-environment node

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  createRegisteredProjectAuthority,
  withAgentProjectScope,
} from './registered-project-authority';

const observed = vi.hoisted(() => ({ canonicalizations: 0, home: '', userData: '' }));
vi.mock('electron', () => ({ app: { getPath: (name: 'home' | 'userData') => observed[name] } }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const wrapped = Object.assign(
    (...args: Parameters<typeof fs.realpathSync>) => {
      observed.canonicalizations++;
      return fs.realpathSync(...args);
    },
    { native: fs.realpathSync.native }
  );
  return { ...fs, realpathSync: wrapped };
});
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-save-authority-')));
  observed.home = join(root, 'home');
  observed.userData = join(root, 'profile');
  mkdirSync(observed.home);
  mkdirSync(observed.userData);
  const managedRoot = join(observed.userData, 'managed-workspaces');
  mkdirSync(managedRoot);
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  const add = (name: string, path = join(observed.home, name)) => {
    mkdirSync(path, { recursive: true });
    db.prepare(
      "INSERT INTO workspaces(name,path,created_at,access_mode) VALUES(?,?,1,'writable')"
    ).run(name, path);
    return path;
  };
  const selected = add('Selected project');
  const authority = createRegisteredProjectAuthority({
    db: () => db,
    managedRootDir: () => managedRoot,
  });
  const f = { root, db, add, selected, authority };
  fixtures.push(f);
  return f;
}

it('keeps a captured save authority check linear as unrelated registered projects are added', () => {
  const f = fixture();
  const first = f.authority.resolve(f.selected)!;
  const check = f.authority.capture(first.projectId, true);
  observed.canonicalizations = 0;
  check();
  const oneProject = observed.canonicalizations;
  for (let i = 0; i < 15; i++) f.add(`Unrelated ${i}`);
  observed.canonicalizations = 0;
  check();
  const sixteenProjects = observed.canonicalizations;
  expect(oneProject).toBeGreaterThan(0);
  expect(sixteenProjects).toBeLessThanOrEqual(oneProject * 24);
  expect(f.authority.resolve(f.selected)?.projectId).toBe(first.projectId);
});

it('rechecks write revocation and archive state on every captured save boundary', () => {
  const f = fixture();
  const check = f.authority.capture(f.authority.resolve(f.selected)!.projectId, true);
  check();
  f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE path=?").run(f.selected);
  expect(check).toThrow();
  f.db
    .prepare("UPDATE workspaces SET access_mode='writable',archived_at=1 WHERE path=?")
    .run(f.selected);
  expect(check).toThrow();
  f.db.prepare('UPDATE workspaces SET archived_at=NULL WHERE path=?').run(f.selected);
  expect(check).not.toThrow();
});

it('refuses duplicate physical owners and a captured root replaced by a symbolic link', () => {
  const f = fixture();
  const id = f.authority.resolve(f.selected)!.projectId;
  const check = f.authority.capture(id, true);
  const alias = join(observed.home, 'Selected alias');
  symlinkSync(f.selected, alias);
  f.db
    .prepare("INSERT INTO workspaces(name,path,created_at,access_mode) VALUES(?,?,1,'writable')")
    .run('Alias', alias);
  expect(check).toThrow();
  f.db.prepare('DELETE FROM workspaces WHERE path=?').run(alias);
  rmSync(alias);
  rmSync(f.selected, { recursive: true });
  const replacement = f.add('Replacement');
  symlinkSync(replacement, f.selected);
  expect(check).toThrow();
});

it('retains the captured agent project scope after returning to the caller scope', () => {
  const f = fixture();
  const other = f.add('Other');
  const selectedId = f.authority.resolve(f.selected)!.projectId;
  const otherId = f.authority.resolve(other)!.projectId;
  const check = withAgentProjectScope({ kind: 'project-roots', roots: [f.selected] }, () => {
    expect(f.authority.resolve(otherId)).toBeNull();
    expect(() => f.authority.capture(otherId, true)).toThrow();
    return f.authority.capture(selectedId, true);
  });
  expect(check).not.toThrow();
  f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE path=?").run(f.selected);
  expect(check).toThrow();
});
