import { userMessage } from '@waypoint/user-messages';
/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalProviderSourceResult } from '../../../../shared/benchling-migration-raw-source';
import { OriginalProviderSourceDialog } from './OriginalProviderSourceDialog';

const platformMocks = vi.hoisted(() => ({
  viewExternalSource: vi.fn(),
}));

vi.mock('../../../../platform', () => ({
  platform: () => ({
    benchlingMigration: { viewExternalSource: platformMocks.viewExternalSource },
  }),
}));

const request = { workspaceId: 1, entityId: 'strain-1', sourceRecordId: 'bfi_STRAINAA' };

describe('OriginalProviderSourceDialog', () => {
  beforeEach(() => platformMocks.viewExternalSource.mockReset());

  it('marks a bounded preview as truncated', async () => {
    renderResult({
      status: 'ready',
      originalPath: '/imports/export.zip',
      sourceDisplayName: 'export.zip',
      message: 'Preview truncated.',
      entryPath: 'Registry/strain.csv',
      displayFilename: 'strain.csv',
      mediaType: 'text/csv',
      text: 'name,Strain A',
      sizeBytes: 2_000_000,
      truncated: true,
    });

    expect(await screen.findByText('Preview truncated')).toBeVisible();
    expect(screen.getByText('/imports/export.zip')).toBeVisible();
  });

  it('shows a typed unsupported format without trying to render bytes', async () => {
    renderResult({
      status: 'unsupported',
      originalPath: '/imports/export.zip',
      sourceDisplayName: 'export.zip',
      message: 'DNAForge does not preview this original source format.',
      entryPath: 'Registry/image.png',
      displayFilename: 'image.png',
      mediaType: 'image/png',
      sizeBytes: 24,
    });

    expect(await screen.findByTestId('original-provider-source-unsupported')).toHaveTextContent(
      'image.png'
    );
    expect(screen.queryByTestId('original-provider-source-text')).not.toBeInTheDocument();
  });

  it.each(['source_unavailable', 'source_changed', 'source_integrity_error'] as const)(
    'keeps the entity and history explicit for %s',
    async (status) => {
      renderResult({
        status,
        originalPath: '/imports/export.zip',
        sourceDisplayName: 'export.zip',
        message: `State: ${status}`,
      });

      const state = await screen.findByTestId(`original-provider-source-${status}`);
      expect(state).toHaveTextContent(
        userMessage(
          status === 'source_changed'
            ? 'source.originalChanged'
            : status === 'source_integrity_error'
              ? 'source.originalUnverified'
              : 'source.originalUnavailable'
        )
      );
      expect(state).not.toHaveTextContent(`State: ${status}`);
      expect(state).toHaveTextContent(
        'The imported DNAForge record and migration history are unchanged.'
      );
      expect(screen.getByText('/imports/export.zip')).toBeVisible();
    }
  );
});

function renderResult(result: ExternalProviderSourceResult): void {
  platformMocks.viewExternalSource.mockResolvedValueOnce(result);
  render(<OriginalProviderSourceDialog request={request} label="Strain A" onClose={vi.fn()} />);
}
