import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { onTestFinished } from 'vitest';
import { rememberOriginalDefaultProject } from '../original-default-project';

export interface OriginalProjectFixture {
  workspaceId: number;
  repoUuid: string;
  rootPath: string;
}

export function seedOriginalProjectFixture(
  db: Database.Database,
  existing?: OriginalProjectFixture
): OriginalProjectFixture {
  const project = existing ?? {
    workspaceId: 900_000_000,
    repoUuid: randomUUID(),
    rootPath: mkdtempSync(join(tmpdir(), 'dnaforge-original-project-test-')),
  };
  if (!existing) onTestFinished(() => rmSync(project.rootPath, { recursive: true, force: true }));
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, access_mode, created_at)
    VALUES (?, 'My Project', ?, ?, 'writable', 1)`
  ).run(project.workspaceId, project.rootPath, project.repoUuid);
  rememberOriginalDefaultProject(db, project.workspaceId);
  return project;
}
