import { platform } from '../../platform';
import { legacyFileDraftSchema } from '../../shared/file-document-legacy-recovery';
import { readAllUnsavedDrafts, deleteUnsavedDraft } from '../../shared/unsaved-draft-recovery';
import { isAbsolutePathLike } from '../../shared/path-boundary';

let migration: Promise<void> = Promise.resolve();

export function migrateLegacyFileDrafts(): Promise<void> {
  const run = migration.then(async () => {
    const entries = await readAllUnsavedDrafts();
    const pending: string[] = [];
    for (const entry of entries) {
      const kind = entry.key.startsWith('text:')
        ? 'text'
        : entry.key.startsWith('table:')
          ? 'table'
          : null;
      if (!kind) continue;
      const path = entry.key.slice(kind === 'text' ? 5 : 6);
      if (!isAbsolutePathLike(path))
        throw new Error(
          'A legacy file draft has no unambiguous native path; its original recovery entry is retained.'
        );
      try {
        if (entry.version !== 1)
          throw new Error('The earlier file draft uses an unsupported recovery version.');
        const draft = legacyFileDraftSchema.parse({
          kind,
          path,
          baseline: entry.baseline,
          payload: entry.payload,
        });
        const receipt = await platform().fs.retainLegacyFileDraft(draft);
        if (receipt.retained !== true || !receipt.documentId || !receipt.recoveryId)
          throw new Error('The native owner did not acknowledge the retained draft.');
        await deleteUnsavedDraft(entry.key);
      } catch (error) {
        pending.push(path);
        console.warn(
          '[Native file recovery] The earlier draft remains in its original store:',
          error
        );
      }
    }
    await platform().fs.completeLegacyFileDraftMigration([...new Set(pending)]);
  });
  migration = run.catch(() => {});
  return run;
}
