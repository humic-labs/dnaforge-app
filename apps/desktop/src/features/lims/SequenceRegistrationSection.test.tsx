import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceRegistrationSection } from './SequenceRegistrationSection';
import { useToastStore } from '../../stores/toast-store';

const mocks = vi.hoisted(() => ({
  useBadge: vi.fn(),
  register: vi.fn(),
}));

vi.mock('./registration-badge', () => ({ useLimsRegistrationBadge: mocks.useBadge }));
vi.mock('./register-open-sequence', () => ({ registerOpenSequenceFile: mocks.register }));

describe('sequence metadata registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useBadge.mockReturnValue({ status: 'not_registered', entity: null });
    mocks.register.mockResolvedValue({ alreadyRegistered: false });
    useToastStore.setState({ toasts: [] });
  });

  it('runs registration from the metadata drawer and reports success', async () => {
    const user = userEvent.setup();
    render(
      <SequenceRegistrationSection
        documentId="document-1"
        sourcePath="/workspace/linear.gb"
        topology="linear"
        length={78000}
      />
    );
    await user.click(screen.getByTestId('sequence-metadata-register'));
    expect(screen.getByTestId('lims-registration-kind-picker')).toBeVisible();
    expect(screen.queryByTestId('lims-registration-kind-plasmid')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('lims-registration-kind-sequence'));
    await waitFor(() =>
      expect(mocks.register).toHaveBeenCalledWith({
        documentId: 'document-1',
        sourcePath: '/workspace/linear.gb',
        kind: 'sequence',
      })
    );
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(
      'Registered open sequence'
    );
  });

  it('does not offer Register after registration', () => {
    mocks.useBadge.mockReturnValue({ status: 'registered', entity: {} });
    render(
      <SequenceRegistrationSection
        documentId="document-1"
        sourcePath="/workspace/linear.gb"
        topology="linear"
        length={78000}
      />
    );
    expect(screen.getByTestId('sequence-registration-status')).toHaveTextContent('registered');
    expect(screen.queryByTestId('sequence-metadata-register')).not.toBeInTheDocument();
  });
});
