import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';
import { platform } from '../platform';
import type { SqliteIpcRow, SqliteIpcValue } from '../shared/sqlite-ipc';
import { waitForWorkspaceSyncDatabase } from './workspace-sync-retry';

export const db = drizzle<typeof schema>(
  async (sql, params, method) => {
    const sqlite = platform().db;

    try {
      return await waitForWorkspaceSyncDatabase(async () => {
        if (method === 'run') {
          const result = await sqlite.execute(sql, params as SqliteIpcValue[]);
          return { rows: [], ...result };
        } else {
          const rows = await sqlite.select<SqliteIpcRow[]>(sql, params as SqliteIpcValue[]);
          const results = rows.map((row) => Object.values(row));
          return { rows: method === 'all' ? results : results[0] };
        }
      });
    } catch (error) {
      console.error('Database error:', error);
      console.error('Query:', sql);
      console.error('Params:', params);
      throw error;
    }
  },
  { schema, logger: import.meta.env.DEV }
);
