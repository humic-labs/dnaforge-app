import type Database from 'better-sqlite3';
import {
  administrationSettingsSchema,
  type AdministrationAction,
  type AdministrationSettings,
} from '../shared/administration';
import type { AdministrationStorage } from './administration-owner';

const keys: Record<keyof AdministrationSettings, string> = {
  theme: 'native_theme_mode',
  displayZoom: 'display_zoom',
  assemblyColorScheme: 'native_assembly_color_scheme',
  webglPerformance: 'sequence_webgl_performance_preference',
  molecularAgentInstructions: 'ai_molecular_agent_instructions',
  rememberedAgentPreferences: 'ai_remembered_agent_preferences',
};

export function createAdministrationStorage(getDb: () => Database.Database): AdministrationStorage {
  return {
    readSettings() {
      const db = getDb();
      const output: Partial<AdministrationSettings> = {};
      for (const key of Object.keys(keys) as Array<keyof AdministrationSettings>) {
        const row = (db
          .prepare('SELECT value FROM administration_preferences WHERE key = ?')
          .get(key) ?? db.prepare('SELECT value FROM settings WHERE key = ?').get(keys[key])) as
          | { value: string }
          | undefined;
        if (!row) continue;
        const parsed = administrationSettingsSchema.shape[key].safeParse(
          key === 'displayZoom' ? Number(row.value) : row.value
        );
        if (!parsed.success)
          throw new Error(`ADMINISTRATION_SETTING_INVALID: ${key} cannot be restored.`);
        Object.assign(output, { [key]: parsed.data });
      }
      return output;
    },
    writeSettings(values, adopted) {
      const db = getDb();
      db.transaction(() => {
        const nativeStatement = db.prepare(
          'INSERT INTO administration_preferences (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        );
        const statement = db.prepare(
          'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        );
        for (const key of adopted) {
          nativeStatement.run(key, String(values[key]), Date.now());
          statement.run(keys[key], String(values[key]), Date.now());
        }
      })();
    },
    readAction(id) {
      const row = getDb()
        .prepare('SELECT payload FROM administration_actions WHERE id = ?')
        .get(id) as { payload: string } | undefined;
      if (!row) return null;
      const action = JSON.parse(row.payload) as AdministrationAction;
      if (action.id !== id)
        throw new Error(
          'ADMINISTRATION_ACTION_INVALID: The retained action identity does not match.'
        );
      return action;
    },
    writeAction(action) {
      getDb()
        .prepare(
          'INSERT INTO administration_actions (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at'
        )
        .run(action.id, JSON.stringify(action), Date.now());
    },
  };
}
