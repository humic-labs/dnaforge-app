import { describe, expect, it } from 'vitest';

import { createTestDb } from './__tests__/test-db';
import {
  findRemoteEndpointProfileById,
  findRemoteEndpointProfileByTarget,
  listRemoteEndpointProfiles,
  renameRemoteEndpointProfile,
  forgetRemoteEndpointProfile,
  recordRemoteEndpointFailure,
  recordRemoteEndpointSuccess,
  saveRemoteEndpointProfile,
} from './remote-endpoint-registry';
import { ensureSchema } from './schema';

describe('remote endpoint profile registry', () => {
  it('saves a never-connected host without inventing connection history and preserves it after a failed login', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const profile = saveRemoteEndpointProfile(
      db,
      { target: 'lab-hpc', displayName: 'Lab cluster' },
      100
    );
    expect(profile.lastConnectedAt).toBeNull();
    recordRemoteEndpointFailure(db, 'lab-hpc', {
      code: 'authentication-required',
      message: 'Sign in through Terminal.',
    });
    const again = saveRemoteEndpointProfile(
      db,
      { target: 'lab-hpc', displayName: 'Renamed cluster' },
      200
    );
    expect(again.endpointId).toBe(profile.endpointId);
    expect(again.lastConnectedAt).toBeNull();
    expect(again.lastFailure?.code).toBe('authentication-required');
    expect(listRemoteEndpointProfiles(db)).toHaveLength(1);
    expect(() =>
      saveRemoteEndpointProfile(db, { target: '-oProxyCommand=evil', displayName: 'Invalid' })
    ).toThrow();
  });
  it('renames only the selected profile while preserving its trusted identity and connection history', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    for (const target of ['lab-hpc', 'other-hpc']) {
      recordRemoteEndpointSuccess(db, {
        endpointId: target + '-id',
        displayName: target,
        target,
        lastConnectedAt: 200,
        observedPlatform: 'linux',
        lastFailure: null,
      });
    }
    recordRemoteEndpointFailure(db, 'lab-hpc', {
      code: 'host-unreachable',
      message: 'Endpoint unavailable.',
    });
    expect(renameRemoteEndpointProfile(db, 'lab-hpc-id', '  Lab reads µ  ', 300)).toMatchObject({
      endpointId: 'lab-hpc-id',
      target: 'lab-hpc',
      displayName: 'Lab reads µ',
      lastConnectedAt: 200,
      lastFailure: { code: 'host-unreachable', message: 'Endpoint unavailable.' },
    });
    expect(findRemoteEndpointProfileByTarget(db, 'other-hpc')?.displayName).toBe('other-hpc');
    for (const name of ['', '  ', 'x'.repeat(201), 'new\nname', 'new\0name']) {
      expect(() => renameRemoteEndpointProfile(db, 'lab-hpc-id', name)).toThrow('Connection name');
    }
    expect(findRemoteEndpointProfileByTarget(db, 'lab-hpc')?.displayName).toBe('Lab reads µ');
    expect(renameRemoteEndpointProfile(db, 'unknown-profile', 'Unknown')).toBeNull();
    expect(listRemoteEndpointProfiles(db)).toHaveLength(2);
  });

  it('forgets only the requested recent profile and does not recreate a missing one', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    for (const target of ['lab-hpc', 'other-hpc']) {
      recordRemoteEndpointSuccess(db, {
        endpointId: target + '-id',
        displayName: target,
        target,
        lastConnectedAt: 200,
        observedPlatform: 'linux',
        lastFailure: null,
      });
    }
    expect(forgetRemoteEndpointProfile(db, 'lab-hpc-id')).toBe(true);
    expect(forgetRemoteEndpointProfile(db, 'lab-hpc-id')).toBe(false);
    expect(listRemoteEndpointProfiles(db).map((profile) => profile.target)).toEqual(['other-hpc']);
    expect(() => forgetRemoteEndpointProfile(db, '')).toThrow('Endpoint ID');
    expect(() => forgetRemoteEndpointProfile(db, 'x\0id')).toThrow('Endpoint ID');
  });

  it('persists only secret-free endpoint metadata after a successful connection', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    recordRemoteEndpointSuccess(
      db,
      {
        endpointId: 'endpoint-1',
        displayName: 'Lab HPC',
        target: 'lab-hpc',
        lastConnectedAt: 200,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      201
    );

    expect(listRemoteEndpointProfiles(db)).toEqual([
      {
        endpointId: 'endpoint-1',
        displayName: 'Lab HPC',
        target: 'lab-hpc',
        lastConnectedAt: 200,
        observedPlatform: 'linux',
        lastFailure: null,
      },
    ]);
    expect(JSON.stringify(listRemoteEndpointProfiles(db))).not.toMatch(
      /token|password|private.?key|127\.0\.0\.1/iu
    );
    expect(findRemoteEndpointProfileById(db, 'endpoint-1')?.target).toBe('lab-hpc');
  });

  it('records a sanitized failure only for an already trusted profile', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    recordRemoteEndpointFailure(db, 'unknown', {
      code: 'host-unreachable',
      message: 'Endpoint unavailable.',
    });
    expect(listRemoteEndpointProfiles(db)).toEqual([]);

    recordRemoteEndpointSuccess(db, {
      endpointId: 'endpoint-1',
      displayName: 'Lab HPC',
      target: 'lab-hpc',
      lastConnectedAt: 200,
      observedPlatform: 'linux',
      lastFailure: null,
    });
    recordRemoteEndpointFailure(db, 'lab-hpc', {
      code: 'authentication-required',
      message: 'Interactive authentication is required.',
    });
    expect(findRemoteEndpointProfileByTarget(db, 'lab-hpc')?.lastFailure).toEqual({
      code: 'authentication-required',
      message: 'Interactive authentication is required.',
    });
  });

  it('does not rotate a trusted target identity when a stale locator reconnects', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    recordRemoteEndpointSuccess(db, {
      endpointId: 'endpoint-current',
      displayName: 'Lab HPC',
      target: 'lab-hpc',
      lastConnectedAt: 200,
      observedPlatform: 'linux',
      lastFailure: null,
    });

    recordRemoteEndpointSuccess(db, {
      endpointId: 'endpoint-stale',
      displayName: 'Lab HPC renamed',
      target: 'lab-hpc',
      lastConnectedAt: 300,
      observedPlatform: 'linux',
      lastFailure: null,
    });

    expect(findRemoteEndpointProfileByTarget(db, 'lab-hpc')).toMatchObject({
      endpointId: 'endpoint-current',
      displayName: 'Lab HPC renamed',
      lastConnectedAt: 300,
    });
    expect(findRemoteEndpointProfileById(db, 'endpoint-stale')).toBeNull();
  });
});
