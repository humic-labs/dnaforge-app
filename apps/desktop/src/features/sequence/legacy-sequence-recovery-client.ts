import { platform } from '../../platform';
import { legacySequenceDraftSchema } from '../../shared/sequence-document';
import {
  readAllUnsavedSequenceEntries,
  deleteUnsavedSequenceEntry,
} from './unsaved-sequence-recovery';
let migration: Promise<void> = Promise.resolve();
export function migrateLegacySequenceDrafts(): Promise<void> {
  const run = migration.then(async () => {
    const entries = await readAllUnsavedSequenceEntries(),
      pending: string[] = [];
    for (const entry of entries) {
      try {
        const draft = legacySequenceDraftSchema.parse({
          documentId: entry.documentId,
          version: entry.version,
          baseline: entry.baseline,
          name: entry.name,
          content: entry.content,
        });
        const receipt = await platform().fs.retainLegacySequenceDraft(draft);
        if (!receipt.retained || receipt.documentId !== entry.documentId || !receipt.recoveryId)
          throw new Error('The native owner did not acknowledge this retained sequence draft.');
        await deleteUnsavedSequenceEntry(entry.documentId);
      } catch (error) {
        pending.push(entry.documentId);
        console.warn(
          '[Native sequence recovery] The earlier draft remains in its original store:',
          error
        );
      }
    }
    await platform().fs.completeLegacySequenceDraftMigration([...new Set(pending)]);
  });
  migration = run.catch(() => {});
  return run;
}
