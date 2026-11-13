// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { formatCloudSurfaceError } from './cloud-surface-error';

describe('formatCloudSurfaceError', () => {
  it('maps the Electron IPC missing_token wrapper to sign-in-again copy', () => {
    expect(
      formatCloudSurfaceError(
        new Error(
          "Error invoking remote method 'cloudSync:listSyncedProjects': DesktopSyncClientError: missing_token"
        ),
        'failure.could-not-load-cloud-projects'
      )
    ).toBe('Could not load cloud projects. Sign out and sign in again.');
  });

  it('maps a bare missing_token code', () => {
    expect(
      formatCloudSurfaceError(new Error('missing_token'), 'failure.could-not-load-cloud-projects')
    ).toBe('Could not load cloud projects. Sign out and sign in again.');
  });

  it('uses approved task wording for unknown server text', () => {
    expect(
      formatCloudSurfaceError(new Error('list boom'), 'failure.could-not-load-cloud-projects')
    ).toBe('Could not load cloud projects.');
  });

  it('uses the fallback when the value is empty', () => {
    expect(formatCloudSurfaceError(null, 'failure.could-not-load-cloud-projects')).toBe(
      'Could not load cloud projects.'
    );
  });
});
