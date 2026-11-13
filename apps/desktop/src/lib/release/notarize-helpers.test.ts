// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helpers = require('../../../scripts/lib/notarize-helpers.cjs') as {
  REQUIRED_ENV: string[];
  validateAppleEnv: (env: NodeJS.ProcessEnv) => {
    appleId: string;
    appleIdPassword: string;
    teamId: string;
  };
  decideAfterSignNotarize: (
    context: { electronPlatformName?: string } | null,
    env: NodeJS.ProcessEnv
  ) => { skip: true; reason: string } | { skip: false };
  isStaplerNetworkFailure: (output: string) => boolean;
};

type SpawnResult = { status: number; stdout: string; stderr: string };
const { restapleAfterNetworkFailure } = require('../../../scripts/notarize-app.cjs') as {
  restapleAfterNetworkFailure: (
    appPath: string,
    opts: {
      attempts?: number;
      delayMs?: number;
      spawn: (command: string, args: string[], options: { cwd: string }) => SpawnResult;
      sleep: (ms: number) => void;
    }
  ) => void;
};

const DROPPED =
  'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." The staple and validate action failed! Error 68.';

const FULL_CREDS: NodeJS.ProcessEnv = {
  APPLE_ID: 'dev@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'TEAM123456',
};

describe('validateAppleEnv', () => {
  it('returns the credential tuple when all three vars are present', () => {
    expect(helpers.validateAppleEnv(FULL_CREDS)).toEqual({
      appleId: 'dev@example.com',
      appleIdPassword: 'abcd-efgh-ijkl-mnop',
      teamId: 'TEAM123456',
    });
  });

  it('throws naming every missing var', () => {
    expect(() => helpers.validateAppleEnv({})).toThrowError(
      /APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/
    );
  });

  it('throws naming only the missing var', () => {
    const env = { ...FULL_CREDS };
    delete env.APPLE_TEAM_ID;
    expect(() => helpers.validateAppleEnv(env)).toThrowError(/APPLE_TEAM_ID/);
    expect(() => helpers.validateAppleEnv(env)).not.toThrowError(/APPLE_ID,/);
  });

  it('treats an empty-string var as missing (not just undefined)', () => {
    expect(() => helpers.validateAppleEnv({ ...FULL_CREDS, APPLE_ID: '' })).toThrowError(
      /APPLE_ID/
    );
  });
});

describe('decideAfterSignNotarize', () => {
  const darwin = { electronPlatformName: 'darwin' };

  it('notarizes (skip:false) on darwin with APPLE_ID and no skip flag', () => {
    expect(helpers.decideAfterSignNotarize(darwin, { APPLE_ID: 'x' })).toEqual({ skip: false });
  });

  it('skips when not macOS', () => {
    const d = helpers.decideAfterSignNotarize({ electronPlatformName: 'win32' }, FULL_CREDS);
    expect(d).toMatchObject({ skip: true });
    if (d.skip) expect(d.reason).toMatch(/not macOS/);
  });

  it('skips a null context', () => {
    expect(helpers.decideAfterSignNotarize(null, FULL_CREDS)).toMatchObject({ skip: true });
  });

  it('skips when WAYPOINT_SKIP_NOTARIZE=1 EVEN with full creds (the --dir guard)', () => {
    const d = helpers.decideAfterSignNotarize(darwin, {
      ...FULL_CREDS,
      WAYPOINT_SKIP_NOTARIZE: '1',
    });
    expect(d).toMatchObject({ skip: true });
    if (d.skip) expect(d.reason).toMatch(/WAYPOINT_SKIP_NOTARIZE/);
  });

  it('does NOT skip when WAYPOINT_SKIP_NOTARIZE is set to something other than "1"', () => {
    expect(
      helpers.decideAfterSignNotarize(darwin, { APPLE_ID: 'x', WAYPOINT_SKIP_NOTARIZE: '0' })
    ).toEqual({ skip: false });
  });

  it('skips when no APPLE_ID (unsigned local build)', () => {
    const d = helpers.decideAfterSignNotarize(darwin, {});
    expect(d).toMatchObject({ skip: true });
    if (d.skip) expect(d.reason).toMatch(/no APPLE_ID/);
  });

  it('WAYPOINT_SKIP_NOTARIZE takes precedence over the APPLE_ID check', () => {
    // exported by the dev shell (Doppler/.envrc).
    const d = helpers.decideAfterSignNotarize(darwin, {
      APPLE_ID: 'dev@example.com',
      WAYPOINT_SKIP_NOTARIZE: '1',
    });
    expect(d).toMatchObject({ skip: true });
    if (d.skip) expect(d.reason).toMatch(/WAYPOINT_SKIP_NOTARIZE/);
  });
});

describe('stapling after a dropped connection ', () => {
  it('recognizes only network failures', () => {
    expect(helpers.isStaplerNetworkFailure(DROPPED)).toBe(true);
    expect(
      helpers.isStaplerNetworkFailure(
        'CloudKit query for DNAForge.app failed due to "Record not found". Error 65.'
      )
    ).toBe(false);
  });

  it('re-staples the app in its folder until Apple answers', () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const sleeps: number[] = [];
    restapleAfterNetworkFailure('/build/mac/DNAForge.app', {
      delayMs: 10,
      sleep: (ms) => sleeps.push(ms),
      spawn: (_command, args, options) => {
        calls.push({ args, cwd: options.cwd });
        return calls.length < 2
          ? { status: 68, stdout: '', stderr: DROPPED }
          : { status: 0, stdout: 'The staple and validate action worked!', stderr: '' };
      },
    });
    expect(calls).toEqual([
      { args: ['stapler', 'staple', '-v', 'DNAForge.app'], cwd: '/build/mac' },
      { args: ['stapler', 'staple', '-v', 'DNAForge.app'], cwd: '/build/mac' },
    ]);
    expect(sleeps).toEqual([10, 20]);
  });

  it('stops at a non-network failure', () => {
    let calls = 0;
    expect(() =>
      restapleAfterNetworkFailure('/build/mac/DNAForge.app', {
        sleep: () => {},
        spawn: () => {
          calls += 1;
          return { status: 65, stdout: '', stderr: 'Record not found. Error 65.' };
        },
      })
    ).toThrow(/code: 65/);
    expect(calls).toBe(1);
  });
});
