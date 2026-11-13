import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import type { PlatformBridge } from './types';
import { SELECT_SETTING_SQL, UPSERT_SETTING_SQL } from '../shared/settings-sql';

export const BROWSER_DURABLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'ai_assistant_route',
  'ai_agent_transport',
  'ai_provider',
  'ai_model',
]);

const STORAGE_PREFIX = 'dnaforge-browser-setting:';

type DatabaseBridge = PlatformBridge['db'];

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function durableKey(params: readonly SqliteIpcValue[] | undefined): string | null {
  const key = params?.[0];
  return typeof key === 'string' && BROWSER_DURABLE_SETTING_KEYS.has(key) ? key : null;
}

export function readDurableBrowserSetting(key: string): string | null {
  try {
    return browserStorage()?.getItem(STORAGE_PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

function writeDurableBrowserSetting(key: string, value: SqliteIpcValue | undefined): void {
  try {
    browserStorage()?.setItem(STORAGE_PREFIX + key, value == null ? '' : String(value));
  } catch {}
}

export function withDurableBrowserSettings(bridge: DatabaseBridge): DatabaseBridge {
  return {
    ...bridge,
    execute: async (sql, params) => {
      const result = await bridge.execute(sql, params);
      const key = sql === UPSERT_SETTING_SQL ? durableKey(params) : null;
      if (key) writeDurableBrowserSetting(key, params?.[1]);
      return result;
    },
    select: async <T>(sql: string, params?: SqliteIpcValue[]): Promise<T> => {
      const key = sql === SELECT_SETTING_SQL ? durableKey(params) : null;
      const stored = key ? readDurableBrowserSetting(key) : null;
      if (stored !== null) return [{ value: stored }] as T;
      return bridge.select<T>(sql, params);
    },
  };
}
