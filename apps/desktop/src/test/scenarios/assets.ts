import type { AppScenario } from './types';
import { isSupportedSequencePath } from '../../shared/scientific-file-types';
import { WP_ASSETS } from './wp-assets';

export async function loadScenarioAssets(
  scenario: AppScenario,
  readTextFile: (path: string) => Promise<string>,
  assetsRoot = WP_ASSETS
): Promise<AppScenario & { files: NonNullable<AppScenario['files']> }> {
  const files = { ...scenario.files };
  const sequenceSources = { ...scenario.sequenceSources };
  for (const asset of scenario.assets ?? []) {
    let content: string;
    try {
      const absolute = /^(?:\/|[a-z]:[\\/])/i.test(asset.wpAssetsPath);
      if (!absolute && !assetsRoot) throw new Error('Local fixture assets are unavailable');
      const sourcePath = absolute
        ? asset.wpAssetsPath
        : `${assetsRoot.replace(/[\\/]+$/, '')}/${asset.wpAssetsPath}`;
      content = await readTextFile(sourcePath);
    } catch (error) {
      if (asset.optional) continue;
      throw error;
    }
    files[asset.mountPath] = content;
    if (
      isSupportedSequencePath(asset.mountPath) &&
      !Object.values(sequenceSources).some((source) => source.sourcePath === asset.mountPath)
    ) {
      sequenceSources[`fixture:sequence:asset:${asset.mountPath}`] = {
        sourcePath: asset.mountPath,
        name: asset.mountPath.split(/[\\/]/).at(-1),
      };
    }
  }
  return { ...scenario, files, sequenceSources };
}

export function withAsset(
  scenario: AppScenario,
  wpAssetsPath: string,
  mountPath: string
): AppScenario {
  return {
    ...scenario,
    assets: [...(scenario.assets ?? []), { wpAssetsPath, mountPath }],
  };
}

export function withAssets(
  scenario: AppScenario,
  assets: NonNullable<AppScenario['assets']>
): AppScenario {
  return {
    ...scenario,
    assets: [...(scenario.assets ?? []), ...assets],
  };
}
