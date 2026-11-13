import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CloudBackupModal } from './CloudBackupModal';

beforeEach(() => cleanup());

describe('CloudBackupModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <CloudBackupModal open={false} onClose={vi.fn()}>
        <p>body</p>
      </CloudBackupModal>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the dialog and closes from the header button', () => {
    const onClose = vi.fn();
    render(
      <CloudBackupModal open onClose={onClose}>
        <p>body</p>
      </CloudBackupModal>
    );
    expect(screen.getByTestId('account-cloud-backup-modal')).toBeTruthy();
    expect(screen.getByText('body')).toBeTruthy();
    fireEvent.click(screen.getByTestId('account-cloud-backup-modal-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <CloudBackupModal open onClose={onClose}>
        <p>body</p>
      </CloudBackupModal>
    );
    fireEvent.click(screen.getByTestId('account-cloud-backup-modal'));
    expect(onClose).toHaveBeenCalled();
  });
});
