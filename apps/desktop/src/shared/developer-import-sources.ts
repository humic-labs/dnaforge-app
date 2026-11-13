import { isAbsolutePathLike, pathIsAtOrUnder, stripTrailingSep } from './path-boundary';

declare const __DEV_WP_ASSETS_PATH__: string;
declare const __DEV_TEST_FIXTURES_PATH__: string;
declare const __DEV_HUMAN_FIXTURES_PATH__: string;

export const DEVELOPER_IMPORT_SOURCE_ROOTS_SETTING_KEY = 'developer-import-source-roots';

let rememberedRendererRoots: readonly string[] = [];

export function normalizeDeveloperImportSourceRoots(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths
        .filter((path) => path && isAbsolutePathLike(path))
        .map((path) =>
          /^[A-Za-z]:[\\/]+$/u.test(path) ? `${path.slice(0, 2)}/` : stripTrailingSep(path)
        )
    ),
  ];
}

export function parseStoredDeveloperImportSourceRoots(value: string | undefined): string[] {
  if (value === undefined) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((path): path is string => typeof path === 'string')) {
    throw new Error('Developer import-source configuration is invalid.');
  }
  return normalizeDeveloperImportSourceRoots(parsed);
}

export function setRememberedDeveloperImportSourceRootsForRenderer(roots: readonly string[]): void {
  rememberedRendererRoots = normalizeDeveloperImportSourceRoots(roots);
}

export function configuredDeveloperImportSourceRoots(): string[] {
  return normalizeDeveloperImportSourceRoots([
    typeof __DEV_WP_ASSETS_PATH__ === 'undefined' ? '' : __DEV_WP_ASSETS_PATH__,
    typeof __DEV_TEST_FIXTURES_PATH__ === 'undefined' ? '' : __DEV_TEST_FIXTURES_PATH__,
    typeof __DEV_HUMAN_FIXTURES_PATH__ === 'undefined' ? '' : __DEV_HUMAN_FIXTURES_PATH__,
  ]);
}

export function isDeveloperImportSourcePath(
  path: string,
  roots: readonly string[] = [...configuredDeveloperImportSourceRoots(), ...rememberedRendererRoots]
): boolean {
  return roots.some((root) => pathIsAtOrUnder(path, root));
}
