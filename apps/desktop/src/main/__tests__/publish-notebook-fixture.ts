import type { SerializablePublishNotebookPackageInput } from '../../db/notebook-package-migration';
import { publishNotebookPackageV2InMain as publish } from '../notebook-package-authority';
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';

export async function publishNotebookPackageV2InMain(
  input: SerializablePublishNotebookPackageInput,
  assertCurrent?: () => void
) {
  const db = createTestDb();
  try {
    ensureSchema(db, ':memory:');
    db.prepare('INSERT INTO workspaces(name,path,created_at) VALUES(?,?,1)').run(
      'Fixture',
      input.workspaceRoot
    );
    return await publish(input, assertCurrent, db);
  } finally {
    db.close();
  }
}
