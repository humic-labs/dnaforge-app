/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BenchlingMigrationReportView } from '../../shared/benchling-migration-ipc';
import { NativeExceptions } from './WizardPrimitives';

describe('NativeExceptions', () => {
  it('keeps repeated conversion problems collapsed, grouped, and free of internal jargon', () => {
    const repeated = {
      code: 'projection_failed',
      message:
        'Native conversion exception: No native converter is available for source type "unsupported_object".',
      blocking: false,
    } as BenchlingMigrationReportView['issues'][number];

    render(<NativeExceptions issues={[repeated, repeated, repeated]} />);

    const details = screen.getByTestId('benchling-migration-native-exceptions');
    expect(details).not.toHaveAttribute('open');
    expect(
      screen.getByText('3 entities were preserved as files instead of editable records.')
    ).toBeVisible();
    expect(
      screen.getByText('DNAForge does not yet support this Benchling record type. (3 entities)')
    ).toBeInTheDocument();
    expect(screen.queryByText(/unsupported_object/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Native conversion exception/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/fallback files/u)).not.toBeInTheDocument();
  });
});
