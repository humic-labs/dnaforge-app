import { platform } from '../platform';
import { isDesktopRuntime } from '../utils/environment';
import { SELECT_SETTING_SQL, UPSERT_SETTING_SQL } from '../shared/settings-sql';
export async function getSetting(key: string): Promise<string | null> {
  if (
    isDesktopRuntime() &&
    (key === 'display_zoom' || key === 'sequence_webgl_performance_preference')
  ) {
    const { inspectAdministrationSettings } = await import('../lib/administration-client');
    const snapshot = await inspectAdministrationSettings();
    const field = key === 'display_zoom' ? 'displayZoom' : 'webglPerformance';
    return snapshot.adopted.includes(field) ? String(snapshot.values[field]) : null;
  }
  const sqlite = platform().db;
  const result = await sqlite.select<{ value: string }[]>(SELECT_SETTING_SQL, [key]);
  return result.length > 0 ? result[0].value : null;
}
export async function setSetting(key: string, value: string): Promise<void> {
  if (
    isDesktopRuntime() &&
    (key === 'display_zoom' || key === 'sequence_webgl_performance_preference')
  ) {
    const { changeAdministrationSettings } = await import('../lib/administration-client');
    const patch =
      key === 'display_zoom'
        ? { displayZoom: Number(value) }
        : { webglPerformance: value as 'auto' | 'quality' | 'stability' };
    const snapshot = await changeAdministrationSettings(patch);
    if (snapshot.unsavedKeys.includes(key === 'display_zoom' ? 'displayZoom' : 'webglPerformance'))
      throw new Error(snapshot.message ?? 'The native preference is accepted but not saved.');
    return;
  }
  const sqlite = platform().db;
  await sqlite.execute(UPSERT_SETTING_SQL, [key, value, Date.now()]);
}
