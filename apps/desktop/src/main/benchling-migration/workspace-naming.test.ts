import { describe, expect, it } from 'vitest';

import { benchlingWorkspaceName } from './staging-workspace';

describe('naming a workspace a Benchling import created', () => {
  it('uses the export the user chose', () => {
    expect(
      benchlingWorkspaceName({
        localExportArtifact: { logicalFilename: 'sundew_export_2.zip' },
      })
    ).toBe('sundew_export_2');
  });

  it('keeps an explicit workspace name instead of replacing it with the export name', () => {
    expect(
      benchlingWorkspaceName({
        displayName: 'Sundew localization',
        localExportArtifact: { logicalFilename: 'sundew_export_2.zip' },
      })
    ).toBe('Sundew localization');
  });

  it('drops only the extension, keeping a name that contains dots', () => {
    expect(
      benchlingWorkspaceName({
        localExportArtifact: { logicalFilename: 'Sundew localization v1.2.zip' },
      })
    ).toBe('Sundew localization v1.2');
  });

  it('falls back to the run display name when there is no export', () => {
    expect(benchlingWorkspaceName({ displayName: 'Screening assemblies' })).toBe(
      'Screening assemblies'
    );
  });

  it('refuses the managed container directory name from either source', () => {
    expect(
      benchlingWorkspaceName({
        displayName: 'repo',
        localExportArtifact: { logicalFilename: 'repo' },
      })
    ).toBe('Benchling import');
  });

  it('prefers a usable display name over a useless export name', () => {
    expect(
      benchlingWorkspaceName({
        displayName: 'Sundew localization',
        localExportArtifact: { logicalFilename: 'repo' },
      })
    ).toBe('Sundew localization');
  });

  it('never returns an empty name', () => {
    expect(benchlingWorkspaceName({})).toBe('Benchling import');
    expect(benchlingWorkspaceName({ displayName: '   ' })).toBe('Benchling import');
    expect(benchlingWorkspaceName({ localExportArtifact: { logicalFilename: '.zip' } })).toBe(
      'Benchling import'
    );
  });

  it('strips path separators rather than letting a name imply a directory', () => {
    expect(
      benchlingWorkspaceName({ localExportArtifact: { logicalFilename: 'a/b/sundew.zip' } })
    ).toBe('a b sundew');
  });
});
