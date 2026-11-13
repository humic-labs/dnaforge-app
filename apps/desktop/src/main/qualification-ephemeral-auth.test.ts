import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VALID_RELEASE_BUILD_STAMP,
  classifyReleaseBHostedAuthority,
  classifyReleaseBuildStamp,
  qualificationEphemeralAuthStampFromEnv,
  releaseBHostedAuthorityFromEnv,
} from './release-stamp';
import {
  qualifyEphemeralAuthLaunch,
  qualifyEphemeralAuthSource,
} from './qualification-ephemeral-auth';

const SOURCE = 'a'.repeat(40);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function input(overrides: Record<string, unknown> = {}) {
  const hosted = releaseBHostedAuthorityFromEnv('1', 'https://hosted.dnaforge.com');
  return {
    isPackaged: true,
    releaseBuildIdentity: classifyReleaseBuildStamp(VALID_RELEASE_BUILD_STAMP),
    releaseBHostedAuthority: classifyReleaseBHostedAuthority(hosted.stamp, hosted.gatewayOrigin),
    packagedSourceCommit: SOURCE,
    bakedAuthorityStamp: qualificationEphemeralAuthStampFromEnv('1', SOURCE, hosted),
    ...overrides,
  };
}

describe('qualification ephemeral auth', () => {
  it('admits an exact-source Release-B Hosted qualification package', () => {
    expect(qualifyEphemeralAuthSource(input())).toBe(SOURCE);
  });

  it('leaves ordinary production and development packages on persistent auth', () => {
    expect(qualifyEphemeralAuthSource(input({ bakedAuthorityStamp: '' }))).toBeNull();
  });

  it.each([
    ['unpackaged app', { isPackaged: false }],
    ['non-release build', { releaseBuildIdentity: classifyReleaseBuildStamp('') }],
    ['non-Hosted build', { releaseBHostedAuthority: classifyReleaseBHostedAuthority('', '') }],
    ['missing package source', { packagedSourceCommit: null }],
    ['different package source', { packagedSourceCommit: 'b'.repeat(40) }],
    ['malformed marker', { bakedAuthorityStamp: 'DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=1' }],
  ])('fails closed for %s', (_label, overrides) => {
    expect(() => qualifyEphemeralAuthSource(input(overrides))).toThrow(
      /qualification ephemeral auth/u
    );
  });

  it('binds the package to one fresh absolute profile and exact-source attempt marker', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-qualification-launch-')));
    temporaryRoots.push(root);
    const appDataPath = join(root, 'app-data');
    mkdirSync(appDataPath, { mode: 0o700 });
    const userDataPath = join(root, 'user-data');
    mkdirSync(userDataPath, { mode: 0o700 });
    const scenarioId = 'hosted-canary-plain-text';
    const attemptMarkerPath = join(
      userDataPath,
      `.dnaforge-hosted-qualification-attempt-${scenarioId}.json`
    );
    writeFileSync(
      attemptMarkerPath,
      JSON.stringify({
        schema: 'waypoint.hosted-codex-electron-attempt/v1',
        scenarioId,
        sourceCommit: SOURCE,
        packageTreeSha256: 'b'.repeat(64),
        createdAt: '2026-09-04T12:00:00.000Z',
      }),
      { mode: 0o600 }
    );
    const launch = qualifyEphemeralAuthLaunch({
      sourceCommit: SOURCE,
      platform: 'darwin',
      argv: [
        '/Applications/DNAForge.app/Contents/MacOS/DNAForge',
        `--user-data-dir=${userDataPath}`,
        `--dnaforge-qualification-attempt=${attemptMarkerPath}`,
      ],
      appDataPath,
      appName: 'DNAForge',
      now: Date.parse('2026-09-04T12:01:00.000Z'),
    });

    expect(launch).toEqual({
      sourceCommit: SOURCE,
      userDataPath,
      attemptMarkerPath,
      scenarioId,
      packageTreeSha256: 'b'.repeat(64),
    });
  });

  it.each([
    ['current shared profile', ['DNAForge']],
    ['legacy shared profile', ['@waypoint', 'desktop']],
    ['another installed app-data profile', ['DNAForge-qualification']],
  ])('refuses the %s before profile startup', (_label, profileSegments) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-shared-profile-')));
    temporaryRoots.push(root);
    const appDataPath = join(root, 'app-data');
    mkdirSync(appDataPath, { mode: 0o700 });
    const userDataPath = join(appDataPath, ...profileSegments);
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const scenarioId = 'hosted-canary-plain-text';
    const attemptMarkerPath = join(
      userDataPath,
      `.dnaforge-hosted-qualification-attempt-${scenarioId}.json`
    );
    writeFileSync(
      attemptMarkerPath,
      JSON.stringify({
        schema: 'waypoint.hosted-codex-electron-attempt/v1',
        scenarioId,
        sourceCommit: SOURCE,
        packageTreeSha256: 'b'.repeat(64),
        createdAt: '2026-09-04T12:00:00.000Z',
      }),
      { mode: 0o600 }
    );

    expect(() =>
      qualifyEphemeralAuthLaunch({
        sourceCommit: SOURCE,
        platform: 'darwin',
        argv: [
          '/Applications/DNAForge.app/Contents/MacOS/DNAForge',
          `--user-data-dir=${userDataPath}`,
          `--dnaforge-qualification-attempt=${attemptMarkerPath}`,
        ],
        appDataPath,
        appName: 'DNAForge',
        now: Date.parse('2026-09-04T12:01:00.000Z'),
      })
    ).toThrow(/refuses every installed app-data profile/u);
  });

  it.each([
    ['Finder launch', []],
    ['bare user-data argument', ['--user-data-dir']],
    ['relative user-data path', ['--user-data-dir=relative']],
    ['duplicate user-data path', ['--user-data-dir=/tmp/one', '--user-data-dir=/tmp/two']],
  ])('fails closed before profile startup for %s', (_label, extraArguments) => {
    expect(() =>
      qualifyEphemeralAuthLaunch({
        sourceCommit: SOURCE,
        platform: 'darwin',
        argv: ['/Applications/DNAForge.app/Contents/MacOS/DNAForge', ...extraArguments],
        appDataPath: '/Users/test/Library/Application Support',
        appName: 'DNAForge',
      })
    ).toThrow(/qualification ephemeral auth/u);
  });

  it('does not inspect launch arguments when the package has no baked authority', () => {
    expect(
      qualifyEphemeralAuthLaunch({
        sourceCommit: null,
        platform: 'win32',
        argv: ['DNAForge.exe', '--user-data-dir'],
        appDataPath: 'C:\\Users\\test\\AppData\\Roaming',
        appName: 'DNAForge',
      })
    ).toBeNull();
  });
});
