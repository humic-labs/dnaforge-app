import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILD_DISTRIBUTION_SCHEMA,
  communityRendererEnvDefaults,
  resolveBuildDistribution,
} from './build-distribution';

const file = (distribution: string) =>
  JSON.stringify({ schema: BUILD_DISTRIBUTION_SCHEMA, distribution });

describe('build distribution', () => {
  it('keeps the checked-in distribution official here and community in the public export', () => {
    const checkedIn = readFileSync(resolve(__dirname, '../../distribution.json'), 'utf8');
    if (existsSync(resolve(__dirname, '../../../../.dnaforge-public-export'))) {
      expect(resolveBuildDistribution({ file: checkedIn, releaseBuild: false })).toBe('community');
    } else {
      expect(resolveBuildDistribution({ file: checkedIn, releaseBuild: true })).toBe('official');
    }
  });

  it('reads the file and lets DNAFORGE_DISTRIBUTION override it', () => {
    expect(resolveBuildDistribution({ file: file('community'), releaseBuild: false })).toBe(
      'community'
    );
    expect(
      resolveBuildDistribution({
        file: file('community'),
        override: 'official',
        releaseBuild: false,
      })
    ).toBe('official');
    expect(
      resolveBuildDistribution({
        file: file('official'),
        override: ' community ',
        releaseBuild: false,
      })
    ).toBe('community');
    expect(
      resolveBuildDistribution({ file: file('official'), override: '', releaseBuild: false })
    ).toBe('official');
  });

  it('refuses unknown values and a community release build', () => {
    expect(() => resolveBuildDistribution({ file: file('fork'), releaseBuild: false })).toThrow(
      /official" or "community/u
    );
    expect(() =>
      resolveBuildDistribution({
        file: JSON.stringify({ distribution: 'official' }),
        releaseBuild: false,
      })
    ).toThrow(/dnaforge\.build-distribution\.v1/u);
    expect(() =>
      resolveBuildDistribution({ file: file('official'), override: 'beta', releaseBuild: false })
    ).toThrow(/DNAFORGE_DISTRIBUTION/u);
    expect(() => resolveBuildDistribution({ file: file('community'), releaseBuild: true })).toThrow(
      /Release builds must use the official distribution/u
    );
    expect(() =>
      resolveBuildDistribution({
        file: file('official'),
        override: 'community',
        releaseBuild: true,
      })
    ).toThrow(/Release builds/u);
  });

  it('turns off the sign-in and cloud sync interface only in community builds', () => {
    expect(communityRendererEnvDefaults('official')).toEqual({});
    expect(communityRendererEnvDefaults('community')).toEqual({
      VITE_ENABLE_DESKTOP_SIGNIN: 'false',
      VITE_ENABLE_WORKSPACE_CLOUD_SYNC: 'false',
    });
  });
});
