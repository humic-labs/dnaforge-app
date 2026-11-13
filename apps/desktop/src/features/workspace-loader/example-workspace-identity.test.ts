// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  isExampleWorkspaceEntry,
  selectExampleWorkspaceMount,
  consolidateExampleWorkspaceVersions,
  shouldMountExampleWorkspace,
} from './example-workspace-identity';
import { STANDARD_SAMPLE_WORKSPACE_MANIFEST } from '../../shared/sample-workspace-ipc';

const currentVersion = STANDARD_SAMPLE_WORKSPACE_MANIFEST.version;

describe('isExampleWorkspaceEntry', () => {
  it('matches the materialized example origin (the sample template copy)', () => {
    expect(
      isExampleWorkspaceEntry({
        originPath:
          '/Users/x/Library/Application Support/DNAForge/Sample Workspaces/standard-samples/v2/workspace',
      })
    ).toBe(true);
  });

  it('matches on Windows-style backslash separators', () => {
    expect(
      isExampleWorkspaceEntry({
        originPath:
          'C:\\Users\\x\\AppData\\Roaming\\DNAForge\\Sample Workspaces\\standard-samples\\v2\\workspace',
      })
    ).toBe(true);
  });

  it('does NOT match a user workspace whose name merely contains the id as a substring', () => {
    expect(
      isExampleWorkspaceEntry({ originPath: '/Users/x/projects/my-standard-samples-notes' })
    ).toBe(false);
  });

  it('does NOT match a genuine user folder literally named standard-samples (not under Sample Workspaces)', () => {
    expect(isExampleWorkspaceEntry({ originPath: '/Users/x/projects/standard-samples/repo' })).toBe(
      false
    );
  });

  it('does NOT match an unrelated user folder', () => {
    expect(isExampleWorkspaceEntry({ originPath: '/Users/x/lab-data' })).toBe(false);
  });

  it('returns false for a null origin (in-place / non-managed entries)', () => {
    expect(isExampleWorkspaceEntry({ originPath: null })).toBe(false);
  });
});

describe('shouldMountExampleWorkspace', () => {
  it('mounts on a genuine first run (never materialized, not in the library)', () => {
    expect(
      shouldMountExampleWorkspace({ materialized: false, active: false, dismissed: false })
    ).toBe(true);
  });

  it('re-mounts an active example every launch (managed workspaces are not auto-restored)', () => {
    expect(
      shouldMountExampleWorkspace({ materialized: true, active: true, dismissed: false })
    ).toBe(true);
  });

  it('re-mounts the active example even when a superseded version is archived', () => {
    expect(shouldMountExampleWorkspace({ materialized: true, active: true, dismissed: true })).toBe(
      true
    );
  });

  it('does NOT mount an archived/trashed (dismissed) example', () => {
    expect(
      shouldMountExampleWorkspace({ materialized: true, active: false, dismissed: true })
    ).toBe(false);
  });

  it('does NOT resurrect an example that was dismissed then PURGED (materialized, no longer active)', () => {
    expect(
      shouldMountExampleWorkspace({ materialized: true, active: false, dismissed: false })
    ).toBe(false);
  });
});

describe('selectExampleWorkspaceMount', () => {
  it('selects the current bundled version and returns older active copies for archival', () => {
    const v2 = {
      repoUuid: 'uuid-v2',
      repoPath: '/managed/v2/repo',
      originPath:
        '/Users/x/Library/Application Support/DNAForge/Sample Workspaces/standard-samples/v2/workspace',
      lastOpenedAt: 1_787_000_100_000,
    };
    const current = {
      repoUuid: `uuid-${currentVersion}`,
      repoPath: `/managed/${currentVersion}/repo`,
      originPath: `/Users/x/Library/Application Support/DNAForge/Sample Workspaces/standard-samples/${currentVersion}/workspace`,
      lastOpenedAt: 1_787_000_000_000,
    };

    expect(selectExampleWorkspaceMount([v2, current])).toEqual({
      selected: current,
      superseded: [v2],
    });
  });

  it('retires an older active version when no current copy exists so the bundled version is materialized', () => {
    const v2 = {
      repoUuid: 'uuid-v2',
      repoPath: '/managed/v2/repo',
      originPath:
        '/Users/x/Library/Application Support/DNAForge/Sample Workspaces/standard-samples/v2/workspace',
      lastOpenedAt: 1_787_000_100_000,
    };

    expect(selectExampleWorkspaceMount([v2])).toEqual({ selected: null, superseded: [v2] });
  });

  it('keeps only the newest copy when the current version itself was duplicated', () => {
    const older = {
      repoUuid: `uuid-${currentVersion}-old`,
      repoPath: `/managed/${currentVersion}-old/repo`,
      originPath: `/Users/x/Library/Application Support/DNAForge/Sample Workspaces/standard-samples/${currentVersion}/workspace`,
      lastOpenedAt: 1_787_000_000_000,
    };
    const newer = {
      ...older,
      repoUuid: `uuid-${currentVersion}-new`,
      repoPath: `/managed/${currentVersion}-new/repo`,
      lastOpenedAt: 1_787_000_100_000,
    };

    expect(selectExampleWorkspaceMount([older, newer])).toEqual({
      selected: newer,
      superseded: [older],
    });
  });
});

describe('consolidateExampleWorkspaceVersions', () => {
  it('opens the current version before archiving superseded projects', async () => {
    const events: string[] = [];
    const old = { repoUuid: 'old' };
    const result = await consolidateExampleWorkspaceVersions({
      superseded: [old],
      openCurrent: async () => {
        events.push('open-current');
        return true;
      },
      archive: async (repoUuid) => {
        events.push(`archive-${repoUuid}`);
      },
      loadLibrary: async () => {
        events.push('load-library');
        return { active: [{ repoUuid: 'current' }] };
      },
    });

    expect(events).toEqual(['open-current', 'archive-old', 'load-library']);
    expect(result).toEqual({ opened: true, library: { active: [{ repoUuid: 'current' }] } });
  });

  it('leaves every old project untouched when the current version cannot open', async () => {
    const archive = vi.fn();
    const loadLibrary = vi.fn();
    await expect(
      consolidateExampleWorkspaceVersions({
        superseded: [{ repoUuid: 'old' }],
        openCurrent: async () => false,
        archive,
        loadLibrary,
      })
    ).resolves.toEqual({ opened: false, library: null });
    expect(archive).not.toHaveBeenCalled();
    expect(loadLibrary).not.toHaveBeenCalled();
  });
});
