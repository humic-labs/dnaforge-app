import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearTelemetrySuppressionFence,
  writeTelemetrySuppressionFence,
} from '@waypoint/analytics-policy/telemetry-suppression-fence';

const state = vi.hoisted(() => ({ userDataPath: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => state.userDataPath },
}));

import {
  isTelemetryEgressSuppressed,
  resolvePublicTelemetryActorRequestContext,
} from './telemetry-actor-context';

describe('shared desktop telemetry authority', () => {
  beforeEach(() => {
    state.userDataPath = mkdtempSync(join(tmpdir(), 'dna4225-actor-'));
    vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', 'closed_beta');
    vi.stubGlobal(
      '__DNAFORGE_BUILD_TAG__',
      'DNAFORGE_BUILD_TAG=v1.0.0-beta.1::TELEMETRY_PROVENANCE_V1::END'
    );
    vi.stubEnv('DNAFORGE_TELEMETRY_ACTOR', '');
    vi.stubEnv('DNAFORGE_TELEMETRY_ACTOR_ASSERTION', '');
  });

  afterEach(() => {
    rmSync(state.userDataPath, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('derives release identity without loading install identity or IPC', () => {
    expect(resolvePublicTelemetryActorRequestContext()).toMatchObject({
      appVersion: '1.0.0',
      buildTag: 'v1.0.0-beta.1',
      releaseChannel: 'closed_beta',
      telemetryActor: 'user',
    });
    expect(isTelemetryEgressSuppressed()).toBe(false);
  });

  it('honors a real validation fence at startup and after creation', () => {
    expect(isTelemetryEgressSuppressed()).toBe(false);
    const { leaseId } = writeTelemetrySuppressionFence({
      userDataPath: state.userDataPath,
      reason: 'packaged_validation_test',
      expiresAtMs: Date.now() + 60_000,
    });
    expect(isTelemetryEgressSuppressed()).toBe(true);
    expect(resolvePublicTelemetryActorRequestContext().telemetrySuppressed).toBe(true);
    expect(clearTelemetrySuppressionFence({ userDataPath: state.userDataPath, leaseId })).toBe(
      true
    );
    expect(isTelemetryEgressSuppressed()).toBe(false);
  });

  it('suppresses an invalid packaged internal assertion', () => {
    vi.stubEnv('DNAFORGE_TELEMETRY_ACTOR', 'maintainer');
    vi.stubEnv('DNAFORGE_TELEMETRY_ACTOR_ASSERTION', 'invalid');
    expect(isTelemetryEgressSuppressed()).toBe(true);
  });
});
