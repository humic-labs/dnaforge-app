// @vitest-environment node

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { AppBuildIdentity } from '../shared/app-build-identity';

const source = readFileSync(new URL('./app-build.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadAppBuild(
  defines: Partial<Record<'__DNAFORGE_APP_BUILD__', AppBuildIdentity | null | undefined>> = {}
) {
  const exports: { APP_BUILD?: AppBuildIdentity } = {};
  runInNewContext(javascript, { exports, ...defines }, { timeout: 1000 });
  return exports.APP_BUILD;
}

const unknownBuild = {
  kind: 'unknown',
  version: null,
  sourceReleaseVersion: null,
  sourceCommit: null,
  sourceModified: null,
} satisfies AppBuildIdentity;

describe('app build metadata boundary', () => {
  it('returns a frozen unknown identity when the build identifier is unbound', () => {
    const build = loadAppBuild();
    expect(build).toEqual(unknownBuild);
    expect(Object.isFrozen(build)).toBe(true);
  });

  it.each([null, undefined])('keeps the unknown fallback for bound %s metadata', (metadata) => {
    expect(loadAppBuild({ __DNAFORGE_APP_BUILD__: metadata })).toEqual(unknownBuild);
  });

  it('preserves the supplied identity and freezes the same object', () => {
    const supplied = {
      kind: 'release',
      version: '1.2.3',
      sourceReleaseVersion: '1.2.3',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      sourceModified: false,
    } satisfies AppBuildIdentity;
    const build = loadAppBuild({ __DNAFORGE_APP_BUILD__: supplied });
    expect(build).toBe(supplied);
    expect(build).toEqual({
      kind: 'release',
      version: '1.2.3',
      sourceReleaseVersion: '1.2.3',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      sourceModified: false,
    });
    expect(Object.isFrozen(supplied)).toBe(true);
  });
});
