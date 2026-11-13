import { expect, it, vi } from 'vitest';
import { subscribeOrganizationRegistryPublicationWake } from '../org-registry-publication-wake';
import { acquireWorkspaceMutationShared } from '../workspace-sync-mutation-lease';
import { createTestDb } from './test-db';

it('wakes only settled current-account publications for the released home and detaches on shutdown', async () => {
  const db = createTestDb();
  const home = `/tmp/dnaforge-wake-home-${crypto.randomUUID()}`;
  const other = `/tmp/dnaforge-wake-other-${crypto.randomUUID()}`;
  db.exec(`
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY, path TEXT);
    CREATE TABLE org_registry_local_records(org_id TEXT, account_id TEXT, entity_id TEXT, workspace_id INTEGER);
    CREATE TABLE org_registry_record_publications(mutation_id TEXT, org_id TEXT, account_id TEXT, entity_id TEXT, status TEXT);
    CREATE TABLE org_registry_record_publication_supersessions(mutation_id TEXT);
  `);
  db.prepare('INSERT INTO workspaces VALUES(1, ?)').run(home);
  db.prepare("INSERT INTO org_registry_local_records VALUES('org','owner','record',1)").run();
  db.prepare(
    "INSERT INTO org_registry_record_publications VALUES('save','org','owner','record','publication_pending')"
  ).run();
  db.exec(
    "INSERT INTO workspaces VALUES(2,NULL); INSERT INTO org_registry_local_records VALUES('org','owner','unavailable',2); INSERT INTO org_registry_record_publications VALUES('unknown-home','org','owner','unavailable','ready');"
  );
  let accountId: string | null = 'owner';
  const wake = vi.fn();
  const warn = vi.fn();
  const unsubscribe = subscribeOrganizationRegistryPublicationWake(db, {
    currentAccountId: () => accountId,
    wake,
    warn,
  });
  const releaseMutation = async (root: string) => {
    const release = await acquireWorkspaceMutationShared(root);
    release();
  };
  try {
    await releaseMutation(home);
    expect(wake).not.toHaveBeenCalled();
    db.prepare("UPDATE org_registry_record_publications SET status='ready'").run();
    accountId = 'other-account';
    await releaseMutation(home);
    accountId = null;
    await releaseMutation(home);
    accountId = 'owner';
    await releaseMutation(other);
    expect(wake).not.toHaveBeenCalled();
    const release = await acquireWorkspaceMutationShared(home);
    expect(wake).not.toHaveBeenCalled();
    release();
    expect(wake).toHaveBeenCalledTimes(1);
    db.prepare("INSERT INTO org_registry_record_publication_supersessions VALUES('save')").run();
    await releaseMutation(home);
    expect(wake).toHaveBeenCalledTimes(1);
    db.prepare('DELETE FROM org_registry_record_publication_supersessions').run();
    db.prepare("UPDATE org_registry_record_publications SET status='queued'").run();
    await releaseMutation(home);
    expect(wake).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE org_registry_record_publications SET status='ready'").run();
    unsubscribe();
    await releaseMutation(home);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    db.close();
  }
});
