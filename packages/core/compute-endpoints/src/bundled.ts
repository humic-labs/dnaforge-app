import tamarind from '../manifests/tamarind.json';
import boltz from '../manifests/boltz.json';
import nvidiaNim from '../manifests/nvidia-nim.json';
import replicate from '../manifests/replicate.json';
import subseq from '../manifests/subseq.json';

import { parseProviderManifest, type ProviderManifest } from './manifest';

export const BUNDLED_MANIFESTS: readonly unknown[] = [
  tamarind,
  boltz,
  nvidiaNim,
  subseq,
  replicate,
];

export function loadBundledManifests(): ProviderManifest[] {
  const parsed: ProviderManifest[] = [];
  const errors: string[] = [];
  for (const raw of BUNDLED_MANIFESTS) {
    const result = parseProviderManifest(raw);
    if (result.ok) {
      parsed.push(result.manifest);
    } else {
      const id =
        typeof raw === 'object' && raw && 'id' in raw
          ? String((raw as { id: unknown }).id)
          : '<unknown>';
      errors.push(...result.errors.map((error) => `${id}: ${error}`));
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid bundled compute provider manifest(s):\n${errors.join('\n')}`);
  }
  const ids = new Set<string>();
  for (const manifest of parsed) {
    if (ids.has(manifest.id)) {
      throw new Error(`Duplicate compute provider id: ${manifest.id}`);
    }
    ids.add(manifest.id);
  }
  return parsed;
}
