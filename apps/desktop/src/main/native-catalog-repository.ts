import type Database from 'better-sqlite3';
import { realpath, stat } from 'node:fs/promises';
import {
  createCatalogRepository,
  type CatalogDatabase,
  type CatalogRepositoryDependencies,
} from '../db/catalog-repository';
import {
  bindCatalogEntityFileInDb,
  catalogFileBindingAdmissionWitnessInDb,
  resolveBindingSequenceFingerprint,
} from './catalog-file-binding';

import {
  registerCatalogEntityInDb,
  registerWorkspaceFileInDb,
  catalogWorkspaceFileAdmissionWitnessInDb,
  resolveWorkspaceFileSequenceFingerprintInDb,
} from './catalog-entity-registration';
import {
  ensureWorkspaceOwnerInDb,
  setCatalogFileStateInDb,
  refreshCatalogFileFingerprintsInDb,
  releaseMissingCatalogFilePathInDb,
  rebindCatalogFilesInDb,
  clearCatalogProjectionInDb,
  deleteCatalogEntityIfUnboundInDb,
  deleteCatalogEntityWithExactBindingInDb,
} from './catalog-projection-commands';
import {
  linkCatalogEntitiesInDb,
  recordCatalogEventInDb,
  updateCatalogEntityPresentationInDb,
} from './catalog-association-commands';
import {
  writeCatalogWorkspacePlacementInDb,
  removeCatalogWorkspacePlacementInDb,
} from './catalog-placement-commands';
import { ensureSequenceIndexInDb } from './sequence-index-command';
export function createNativeCatalogDatabase(
  db: Database.Database,
  options: { assertCurrent(): void }
) {
  const guarded =
    <A extends unknown[], R>(operation: (...args: A) => R | Promise<R>) =>
    async (...args: A): Promise<R> => {
      options.assertCurrent();
      const result = await operation(...args);
      options.assertCurrent();
      return result;
    };
  const select: CatalogDatabase['select'] = async <T>(
    sql: string,
    params: readonly unknown[] = []
  ) => db.prepare(sql).all(...params) as T;
  const commands: CatalogDatabase &
    Pick<
      import('../shared/ipc/contract').ClientOf<
        typeof import('../shared/ipc/db.contract').dbContract
      >,
      'ensureSequenceIndex'
    > = {
    select,
    execute: guarded((sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    }),
    bindCatalogEntityFile: guarded(async (request) => {
      const witness = catalogFileBindingAdmissionWitnessInDb(db, request);
      const fingerprint = await resolveBindingSequenceFingerprint(db, request);
      options.assertCurrent();
      return bindCatalogEntityFileInDb(db, request, undefined, witness, fingerprint);
    }),
    ensureWorkspaceOwner: guarded((...args) => ensureWorkspaceOwnerInDb(db, ...args)),
    ensureSequenceIndex: guarded((input) => ensureSequenceIndexInDb(db, input)),
    registerCatalogEntity: guarded((input) => registerCatalogEntityInDb(db, input)),
    registerWorkspaceFile: guarded(async (input) => {
      const witness = catalogWorkspaceFileAdmissionWitnessInDb(db, input);
      const fingerprint = await resolveWorkspaceFileSequenceFingerprintInDb(db, input);
      options.assertCurrent();
      return registerWorkspaceFileInDb(db, input, fingerprint, witness);
    }),
    setCatalogFileState: guarded((...args) => setCatalogFileStateInDb(db, ...args)),
    refreshCatalogFileFingerprints: guarded((input) =>
      refreshCatalogFileFingerprintsInDb(db, input)
    ),
    releaseMissingCatalogFilePath: guarded((...args) =>
      releaseMissingCatalogFilePathInDb(db, ...args)
    ),
    writeCatalogWorkspacePlacement: guarded((input) =>
      writeCatalogWorkspacePlacementInDb(db, input)
    ),
    removeCatalogWorkspacePlacement: guarded((...args) =>
      removeCatalogWorkspacePlacementInDb(db, ...args)
    ),
    linkCatalogEntities: guarded((input) => linkCatalogEntitiesInDb(db, input)),
    recordCatalogEvent: guarded((input) => recordCatalogEventInDb(db, input)),
    updateCatalogEntityPresentation: guarded((input) =>
      updateCatalogEntityPresentationInDb(db, input)
    ),
    rebindCatalogFiles: guarded((input) => rebindCatalogFilesInDb(db, input)),
    clearCatalogProjection: guarded((input) => clearCatalogProjectionInDb(db, input)),
    deleteCatalogEntityIfUnbound: guarded((input) => deleteCatalogEntityIfUnboundInDb(db, input)),
    deleteCatalogEntityWithExactBinding: guarded((input) =>
      deleteCatalogEntityWithExactBindingInDb(db, input)
    ),
  };
  return commands;
}
export function createNativeCatalogRepository(
  db: Database.Database,
  options: { assertCurrent(): void; withMutation: CatalogRepositoryDependencies['withMutation'] }
) {
  const commands = createNativeCatalogDatabase(db, options);
  return createCatalogRepository({
    db: () => commands,
    stat: nativeFilesystemStat,
    isHosted: () => false,
    withMutation: options.withMutation,
  });
}
export const nativeFilesystemStat: CatalogRepositoryDependencies['stat'] = async (path) => {
  const current = await stat(path, { bigint: true });
  return {
    canonicalPath: await realpath(path),
    size: Number(current.size),
    isFile: current.isFile(),
    isDirectory: current.isDirectory(),
    mtime: Number(current.mtimeMs),
    ctime: Number(current.ctimeMs),
    mtimeNs: String(current.mtimeNs),
    ctimeNs: String(current.ctimeNs),
    device: String(current.dev),
    inode: String(current.ino),
  };
};
