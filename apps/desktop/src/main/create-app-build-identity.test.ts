// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createAppBuildIdentity } from './create-app-build-identity';
import { createRendererDefines, testRendererDefineValues } from '../shared/renderer-build-defines';

const source = {
  version: '0.9.3',
  sourceCommit: '535acc37d41f1794b20563a2f20a9e0d9051f420',
  sourceModified: false,
  sourceDescription: 'v0.9.8-4-g535acc37d41f1794b20563a2f20a9e0d9051f420',
  releaseBuild: undefined,
  buildTag: undefined,
};

describe('desktop artifact identity', () => {
  it('uses the source release tag instead of a stale checked-in package version', () => {
    const build = createAppBuildIdentity({
      ...source,
      command: 'serve',
      mode: 'development',
      sourceDescription: 'v0.9.8-4-g535acc37d41f1794b20563a2f20a9e0d9051f420',
    });
    expect(build.version).toBe('0.9.8+dev.4.g535acc37d41f');
    expect(build.version).not.toContain('0.9.3');
  });
  it.each([
    ['serve', 'development', 'development'],
    ['build', 'production', 'local'],
    ['build', 'development', 'local'],
    ['build', 'test', 'test'],
  ])('identifies %s/%s as %s without release authority', (command, mode, kind) => {
    expect(createAppBuildIdentity({ ...source, command, mode })).toEqual({
      kind,
      version: `0.9.8+${kind === 'development' ? 'dev' : kind}.4.g535acc37d41f`,
      sourceReleaseVersion: '0.9.8',
      sourceCommit: source.sourceCommit,
      sourceModified: false,
    });
  });

  it('retains uncommitted source state without inventing a release version', () => {
    const build = createAppBuildIdentity({
      ...source,
      command: 'serve',
      mode: 'development',
      sourceModified: true,
      buildTag: 'v99.0.0',
    });
    expect(build).toMatchObject({
      kind: 'development',
      version: '0.9.8+dev.4.g535acc37d41f.dirty',
      sourceModified: true,
    });
    expect(Object.isFrozen(build)).toBe(true);
  });

  it('identifies a release only with existing authority and a matching tag', () => {
    expect(
      createAppBuildIdentity({
        ...source,
        command: 'build',
        mode: 'production',
        releaseBuild: '1',
        buildTag: 'v0.9.3',
      })
    ).toMatchObject({ kind: 'release', version: '0.9.3', sourceCommit: source.sourceCommit });
  });

  it.each([undefined, '', 'v0.9.8', '0.9.3', 'v0.9.3-extra'])(
    'rejects an absent/mismatched release tag %s',
    (buildTag) => {
      expect(() =>
        createAppBuildIdentity({
          ...source,
          command: 'build',
          mode: 'production',
          releaseBuild: '1',
          buildTag,
        })
      ).toThrow('DNAFORGE_BUILD_TAG must match');
    }
  );

  it.each([
    ['serve', 'production'],
    ['build', 'test'],
    ['serve', 'development'],
  ])('refuses to promote %s/%s to release', (command, mode) => {
    expect(() =>
      createAppBuildIdentity({
        ...source,
        command,
        mode,
        releaseBuild: '1',
        buildTag: 'v0.9.3',
      })
    ).toThrow('requires a production build');
  });

  it('rejects malformed release authority and source identity', () => {
    expect(() =>
      createAppBuildIdentity({
        ...source,
        command: 'build',
        mode: 'production',
        releaseBuild: 'true',
      })
    ).toThrow('Invalid DNAFORGE_RELEASE_BUILD');
    expect(() =>
      createAppBuildIdentity({
        ...source,
        command: 'build',
        mode: 'production',
        sourceCommit: 'unknown',
      })
    ).toThrow('full lowercase Git SHA');
  });

  it('injects the same version and identity through the canonical renderer defines', () => {
    const build = createAppBuildIdentity({ ...source, command: 'serve', mode: 'development' });
    const values = testRendererDefineValues({
      appVersion: build.version ?? 'unknown',
      appBuildIdentity: build,
    });
    const defines = createRendererDefines(values);
    expect(JSON.parse(defines.__DNAFORGE_APP_BUILD__)).toEqual(build);
    expect(JSON.parse(defines.__APP_VERSION__)).toEqual(build.version);
    expect(() => createRendererDefines({ ...values, appVersion: '0.9.8' })).toThrow('disagrees');
  });
});
