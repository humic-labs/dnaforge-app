import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSequencePackageDocument } from '../../../db/sequence-package';
import { ManagedSequenceRegistrationBadge } from './ManagedSequenceRegistrationBadge';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock('../managed-sequence-repository', () => ({
  managedSequenceRepository: { resolve: mocks.resolve },
}));

describe('ManagedSequenceRegistrationBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the package-owned Registry status instead of the loose-file Register action', async () => {
    const ref = {
      kind: 'managed-sequence' as const,
      packageId: 'package-1',
      packageRoot: '/workspace/package-1',
    };
    const base = buildSequencePackageDocument({
      id: ref.packageId,
      name: 'Package one',
      product: { file: 'package-1.gb' },
    });
    const document = {
      ...base,
      entity: {
        ...base.entity,
        registrationStatus: 'registered' as const,
        registryId: 'p000004',
      },
    };
    mocks.resolve.mockResolvedValue({
      ref,
      document,
      productPath: '/workspace/package-1/package-1.gb',
    });

    render(<ManagedSequenceRegistrationBadge documentRef={ref} />);

    const badge = await screen.findByText('registered');
    expect(badge).toHaveAttribute('title', 'Registry ID p000004');
    expect(screen.queryByTestId('lims-register-current-sequence')).not.toBeInTheDocument();
  });

  it('does not present tracked as a meaningful Registry status', async () => {
    const ref = {
      kind: 'managed-sequence' as const,
      packageId: 'package-1',
      packageRoot: '/workspace/package-1',
    };
    const document = buildSequencePackageDocument({
      id: ref.packageId,
      name: 'Package one',
      product: { file: 'package-1.gb' },
    });
    expect(document.entity.registrationStatus).toBe('tracked');
    mocks.resolve.mockResolvedValue({
      ref,
      document,
      productPath: '/workspace/package-1/package-1.gb',
    });
    render(<ManagedSequenceRegistrationBadge documentRef={ref} />);
    await waitFor(() => expect(screen.queryByText('checking')).not.toBeInTheDocument());
    expect(screen.queryByTestId('lims-registration-badge')).not.toBeInTheDocument();
    expect(document.entity.registrationStatus).toBe('tracked');
  });
});
