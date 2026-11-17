import { realpathSync } from 'node:fs';
import { afterEach, vi } from 'vitest';

const { databases } = vi.hoisted(() => ({
  databases: [] as Array<{ cleanup: () => void }>,
}));

vi.mock('../../../apps/desktop/src/main/__tests__/test-db', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../apps/desktop/src/main/__tests__/test-db')>();
  return {
    ...actual,
    createTestDb: () => {
      const file = actual.createFileTestDb('sync-transitions');
      databases.push(file);
      const main = file.db.pragma('database_list') as Array<{ name: string; file: string }>;
      if (
        !main.some(
          (entry) =>
            entry.name === 'main' &&
            entry.file &&
            realpathSync(entry.file) === realpathSync(file.dbPath)
        )
      ) {
        throw new Error('Sync verification requires an actual file-backed SQLite database.');
      }
      console.info('[sync verification] file-backed SQLite', file.dbPath);
      return file.db;
    },
  };
});

afterEach(() => {
  for (const file of databases.splice(0)) file.cleanup();
});
