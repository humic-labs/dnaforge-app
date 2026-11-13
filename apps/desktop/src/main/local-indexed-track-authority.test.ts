import { createHmac } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  isAllowedDevScenarioIndexedTrackFixture,
  LocalIndexedTrackAuthorityRegistry,
} from './local-indexed-track-authority';

function registryHarness(sessionToken = 'session-one') {
  let stored: string | null = null;
  const files = new Set([
    '/analysis/signal.bigWig',
    '/analysis/run/outputs.dnaforge-tracks.json',
    '/analysis/run/coverage.bigWig',
    '/analysis/private.bigWig',
  ]);
  const create = (token = sessionToken, workspaceRoots: readonly string[] = []) =>
    new LocalIndexedTrackAuthorityRegistry({
      load: () => stored,
      save: (value) => {
        stored = value;
      },
      currentSessionToken: () => token,
      inspectPath: (path) => ({ canonicalPath: path, isFile: files.has(path) }),
      workspaceRootFor: (path) =>
        workspaceRoots.find((root) => path.startsWith(`${root}/`)) ?? null,
    });
  return { create, readStored: () => stored };
}

describe('LocalIndexedTrackAuthorityRegistry', () => {
  it('resolves only the exact recorded file and refuses a retargeted picker symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-picker-file-authority-'));
    try {
      const selected = join(root, 'selected.json');
      const sibling = join(root, 'sibling.json');
      const alias = join(root, 'picker-alias.json');
      writeFileSync(selected, '{}');
      writeFileSync(sibling, '{}');
      symlinkSync(selected, alias);
      const save = vi.fn();
      const registry = new LocalIndexedTrackAuthorityRegistry({
        load: () => null,
        save,
        currentSessionToken: () => 'unused-for-file-read',
      });
      expect(() => registry.resolveSelectedFilePath(selected)).toThrow('not granted');
      registry.registerSelectedPaths([alias]);
      expect(registry.resolveSelectedFilePath(alias)).toBe(realpathSync.native(selected));
      expect(() => registry.resolveSelectedFilePath(sibling)).toThrow('not granted');
      expect(() => registry.resolveSelectedFilePath(root)).toThrow('not granted');
      unlinkSync(alias);
      symlinkSync(sibling, alias);
      expect(() => registry.resolveSelectedFilePath(alias)).toThrow('not granted');
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('issues a session-bound proof only for a native-picker selection', () => {
    const harness = registryHarness();
    const registry = harness.create();

    expect(() => registry.issue({ path: '/analysis/signal.bigWig' })).toThrow(
      'Select this local indexed track through the DNAForge file picker first.'
    );

    registry.registerSelectedPaths(['/analysis/signal.bigWig']);
    const receipt = registry.issue({ path: '/analysis/signal.bigWig' });
    const expected = createHmac('sha256', 'session-one')
      .update('dnaforge.local-indexed-track-authority.v1\u0000/analysis/signal.bigWig')
      .digest('hex');

    expect(receipt).toEqual({
      canonicalPath: '/analysis/signal.bigWig',
      authority: expected,
    });
    expect(harness.readStored()).toContain('/analysis/signal.bigWig');
  });

  it('grants a workspace-grounded path under an active root for this process only', () => {
    const harness = registryHarness();
    const registry = harness.create('session-one', ['/analysis']);
    expect(() =>
      registry.issue({ path: '/analysis/private.bigWig', workspaceGrounded: true })
    ).not.toThrow();
    expect(harness.readStored()).toBeNull();
    const other = harness.create('session-one', ['/analysis']);
    expect(() => other.issue({ path: '/analysis/private.bigWig' })).toThrow(
      'Select this local indexed track through the DNAForge file picker first.'
    );
  });

  it('refuses a workspace-grounded path that no active root contains', () => {
    const harness = registryHarness();
    const registry = harness.create('session-one', ['/elsewhere']);
    expect(() =>
      registry.issue({ path: '/analysis/private.bigWig', workspaceGrounded: true })
    ).toThrow('outside every active project');
    expect(harness.readStored()).toBeNull();
  });

  it('restores selected paths across launches but rotates their proof with the sidecar session', () => {
    const harness = registryHarness();
    const first = harness.create('session-one');
    first.registerSelectedPaths(['/analysis/signal.bigWig']);
    const firstProof = first.issue({ path: '/analysis/signal.bigWig' }).authority;

    const restarted = harness.create('session-two');
    const restartedProof = restarted.issue({ path: '/analysis/signal.bigWig' }).authority;

    expect(restartedProof).not.toBe(firstProof);
  });

  it('authorizes only children of a selected workflow manifest', () => {
    const harness = registryHarness();
    const registry = harness.create();
    registry.registerSelectedPaths(['/analysis/run/outputs.dnaforge-tracks.json']);

    expect(
      registry.issue({
        path: '/analysis/run/coverage.bigWig',
        relatedManifestPath: '/analysis/run/outputs.dnaforge-tracks.json',
      })
    ).toMatchObject({ canonicalPath: '/analysis/run/coverage.bigWig' });
    expect(registry.issue({ path: '/analysis/run/coverage.bigWig' })).toMatchObject({
      canonicalPath: '/analysis/run/coverage.bigWig',
    });
    expect(() =>
      registry.issue({
        path: '/analysis/private.bigWig',
        relatedManifestPath: '/analysis/run/outputs.dnaforge-tracks.json',
      })
    ).toThrow('resolves outside the selected manifest directory');
  });
});

describe('dev-scenario indexed-track fixture authority', () => {
  it('can authorize a fixture for the current process without persisting picker authority', () => {
    const harness = registryHarness();
    const registry = harness.create();

    registry.registerEphemeralPaths(['/analysis/signal.bigWig']);

    expect(registry.issue({ path: '/analysis/signal.bigWig' })).toMatchObject({
      canonicalPath: '/analysis/signal.bigWig',
    });
    expect(harness.readStored()).toBeNull();
  });

  it('allows only the complete checked-in Figure 4N BigWigs in a mutable dev runtime', () => {
    const fixture = '/repo/test-fixtures/indexed/danRer11/pownall-figure-4n/AGS001841.bw';

    expect(
      isAllowedDevScenarioIndexedTrackFixture(fixture, {
        scenarioMutationAllowed: true,
        isPackaged: false,
      })
    ).toBe(true);
    expect(
      isAllowedDevScenarioIndexedTrackFixture('/repo/private/signal.bw', {
        scenarioMutationAllowed: true,
        isPackaged: false,
      })
    ).toBe(false);
    expect(
      isAllowedDevScenarioIndexedTrackFixture(fixture, {
        scenarioMutationAllowed: false,
        isPackaged: false,
      })
    ).toBe(false);
    expect(
      isAllowedDevScenarioIndexedTrackFixture(fixture, {
        scenarioMutationAllowed: true,
        isPackaged: true,
      })
    ).toBe(false);
  });
});
