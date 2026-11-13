import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECT_SETTING_SQL, UPSERT_SETTING_SQL } from '../shared/settings-sql';
import { createHostedMemoryDb } from '../hosted/memory-db';
import { withDurableBrowserSettings } from './durable-browser-settings';
import type { PlatformBridge } from './types';

function memoryBridge(): PlatformBridge['db'] {
  const db = createHostedMemoryDb();
  return {
    execute: (sql, params) => db.execute(sql, params as never),
    select: (sql, params) => db.select(sql, params as never),
    allocatePrimerCatalogNumber: vi.fn(),
    replacePrimerProjection: vi.fn(),
  };
}

async function readSetting(bridge: PlatformBridge['db'], key: string): Promise<string | null> {
  const rows = await bridge.select<Array<{ value: string }>>(SELECT_SETTING_SQL, [key]);
  return rows[0]?.value ?? null;
}

describe('durable browser settings ', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps the assistant route across a reload of the in-memory database', async () => {
    const before = withDurableBrowserSettings(memoryBridge());
    await before.execute(UPSERT_SETTING_SQL, ['ai_assistant_route', '{"version":1}', 1]);

    const after = withDurableBrowserSettings(memoryBridge());
    await expect(readSetting(after, 'ai_assistant_route')).resolves.toBe('{"version":1}');
  });

  it('keeps the explicit "Automatic" empty value', async () => {
    const before = withDurableBrowserSettings(memoryBridge());
    await before.execute(UPSERT_SETTING_SQL, ['ai_assistant_route', '', 1]);
    const after = withDurableBrowserSettings(memoryBridge());
    await expect(readSetting(after, 'ai_assistant_route')).resolves.toBe('');
  });

  it('leaves every other setting in the in-memory database only', async () => {
    const before = withDurableBrowserSettings(memoryBridge());
    await before.execute(UPSERT_SETTING_SQL, ['theme', 'dark', 1]);
    await expect(readSetting(before, 'theme')).resolves.toBe('dark');

    const after = withDurableBrowserSettings(memoryBridge());
    await expect(readSetting(after, 'theme')).resolves.toBeNull();
  });
});
