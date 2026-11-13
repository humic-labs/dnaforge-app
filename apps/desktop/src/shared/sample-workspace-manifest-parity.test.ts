// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STANDARD_SAMPLE_WORKSPACE_MANIFEST } from './sample-workspace-ipc';

const MANIFEST_PATH = join(
  __dirname,
  '../../resources/sample-workspaces/standard-samples/manifest.json'
);

describe('sample workspace manifest parity', () => {
  const onDisk = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

  it('matches the hardcoded copy field for field', () => {
    expect(STANDARD_SAMPLE_WORKSPACE_MANIFEST).toEqual(onDisk);
  });

  it('keeps the version in lockstep', () => {
    expect(STANDARD_SAMPLE_WORKSPACE_MANIFEST.version).toBe(onDisk.version);
  });

  it('points every advertised sequence at a managed package that actually ships', () => {
    const workspaceRoot = join(
      __dirname,
      '../../resources/sample-workspaces/standard-samples/workspace'
    );
    for (const asset of onDisk.assets as Array<{ id: string; path: string }>) {
      const packageRoot = join(workspaceRoot, asset.path);
      expect(statSync(packageRoot).isDirectory(), `${asset.id} → ${asset.path}`).toBe(true);
      const metadata = JSON.parse(readFileSync(join(packageRoot, '.forge/plasmid.json'), 'utf8'));
      expect(metadata).toMatchObject({ schema: 'waypoint.sequence.v1', kind: 'sequence' });
      expect(asset.path, `${asset.id} points through a private product member`).not.toMatch(
        /\.(?:gb|gbk|gbff|genbank)$/i
      );
    }
  });

  it('files every sequence under a folder named for WHAT it is', () => {
    for (const asset of onDisk.assets as Array<{ id: string; path: string }>) {
      expect(asset.path, `${asset.id} is filed by topology, not by kind`).not.toContain(
        'sequences/circular/'
      );
    }
  });
});
