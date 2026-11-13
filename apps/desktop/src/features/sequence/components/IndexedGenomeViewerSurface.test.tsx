import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  AlignedReadRepairNotice,
  IndexedGenomeAnnotationOwnerPendingNotice,
} from './IndexedGenomeViewerSurface';
import type { BamTrackImportController } from './useBamTrackImport';

function bamImport(overrides: Partial<BamTrackImportController> = {}): BamTrackImportController {
  return {
    busy: null,
    progress: null,
    notice: null,
    lastOperation: null,
    clearNotice: vi.fn(),
    recentRemoteEndpoints: [],
    refreshRemoteEndpoints: vi.fn(async () => undefined),
    addRemote: vi.fn(async () => undefined),
    addFiles: vi.fn(async () => undefined),
    reconnectRemoteTrack: vi.fn(async () => true),
    repairTrack: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('AlignedReadRepairNotice', () => {
  it('renders the error repair notice with the existing testid', () => {
    render(
      <AlignedReadRepairNotice
        bamImport={bamImport({
          lastOperation: 'repair',
          notice: { kind: 'error', text: 'index missing' },
        })}
      />
    );
    const notice = screen.getByTestId('aligned-read-repair-notice');
    expect(notice).toHaveAttribute('data-notice-kind', 'error');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent('index missing');
  });

  it('stays unmounted unless the last operation is a repair', () => {
    render(
      <AlignedReadRepairNotice
        bamImport={bamImport({
          lastOperation: 'add',
          busy: 'Adding…',
        })}
      />
    );
    expect(screen.queryByTestId('aligned-read-repair-notice')).not.toBeInTheDocument();
  });
});

describe('IndexedGenomeAnnotationOwnerPendingNotice', () => {
  it('renders the pending owner status testid', () => {
    render(<IndexedGenomeAnnotationOwnerPendingNotice pending />);
    expect(screen.getByTestId('indexed-genome-annotation-owner-pending')).toBeInTheDocument();
  });

  it('renders nothing when the owner is ready', () => {
    const { container } = render(<IndexedGenomeAnnotationOwnerPendingNotice pending={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
