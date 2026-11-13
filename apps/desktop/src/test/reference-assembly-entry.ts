import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '@waypoint/genome-renderer/pure';
import type { ReferenceAssemblyEntry } from '../features/sequence/reference-catalog';
import { platform } from '../platform';

export async function referenceAssemblyEntryForTest(
  entry: ReferenceAssemblyEntry
): Promise<ReferenceAssemblyEntry> {
  const assets = platform().referenceAssets;
  const hosted = (await assets.listHosted()).some((candidate) => candidate.id === entry.id);
  if (!hosted) return entry;
  const result = await assets.installHosted({
    catalogId: entry.id,
    themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
    intent: 'open-view',
  });
  return result.entry;
}
