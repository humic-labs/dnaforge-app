/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { RegistryClassificationReview } from './RegistryClassificationReview';
import type { OligoClassificationReview } from '../../../../shared/oligo-classification';
const mocks = vi.hoisted(() => ({ review: vi.fn(), apply: vi.fn() }));
vi.mock('../../../../platform', () => ({
  platform: () => ({
    lims: { reviewClassification: mocks.review, applyClassification: mocks.apply },
  }),
}));
const review: Extract<OligoClassificationReview, { status: 'review' }> = {
  status: 'review',
  entityId: 'same-entity',
  entityName: 'Candidate',
  targetSourceId: 'seq_OLIGO001',
  currentKind: 'dna_sequence',
  reviewToken: `sha256:${'a'.repeat(64)}`,
  evidenceLimited: false,
  evidence: [
    {
      channel: 'authored_role',
      value: 'primer',
      excerpt: 'Forward primer',
      sourceObjectId: 'etr_NOTEBOOK01',
      sourceEntryPath: 'Experiment.html',
      sourceEntrySha256: `sha256:${'b'.repeat(64)}`,
      targetSourceId: 'seq_OLIGO001',
      occurrence: 0,
    },
  ],
  sequence: { length: 24, molecule: 'dna', topology: 'linear' },
  assessment: { status: 'suggested', kind: 'oligo', use: 'primer' },
};
describe('explicit Registry classification review', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.review.mockResolvedValue(review);
    mocks.apply.mockResolvedValue({
      status: 'applied',
      entityId: 'same-entity',
      requestId: 'receipt',
      kind: 'oligo',
      use: 'primer',
    });
  });
  afterEach(cleanup);
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review classification' }));
    await screen.findByText('Source suggests DNA oligo, used as primer.');
  };
  it('does not classify until the user chooses and applies', async () => {
    const saved = vi.fn();
    render(
      <RegistryClassificationReview entityId="same-entity" disabled={false} onApplied={saved} />
    );
    expect(mocks.review).not.toHaveBeenCalled();
    await open();
    expect(screen.getByRole('button', { name: 'Save choice' })).toBeDisabled();
    expect(mocks.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Classify as DNA oligo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'same-entity',
        reviewToken: review.reviewToken,
        choice: { kind: 'classify', use: 'primer' },
      })
    );
  });
  it('can explicitly keep a sequence generic', async () => {
    render(
      <RegistryClassificationReview entityId="same-entity" disabled={false} onApplied={vi.fn()} />
    );
    await open();
    fireEvent.click(screen.getByRole('radio', { name: 'Keep as DNA sequence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith(
        expect.objectContaining({ choice: { kind: 'keep_generic' } })
      )
    );
  });
  it('shows stale evidence and requires a new explicit choice', async () => {
    mocks.apply.mockResolvedValue({
      status: 'stale',
      review: {
        ...review,
        reviewToken: `sha256:${'c'.repeat(64)}`,
        assessment: { status: 'needs_review', reason: 'disputed_role' },
      },
    });
    render(
      <RegistryClassificationReview entityId="same-entity" disabled={false} onApplied={vi.fn()} />
    );
    await open();
    fireEvent.click(screen.getByRole('radio', { name: 'Classify as DNA oligo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await screen.findByText(
      'The record or evidence changed. Review the current information and choose again.'
    );
    expect(screen.getByRole('button', { name: 'Save choice' })).toBeDisabled();
    expect(screen.getByText('Source statements question or contradict the role.')).toBeVisible();
  });
  it('retries the exact request after an uncertain save outcome', async () => {
    mocks.apply.mockRejectedValueOnce(new Error('Save confirmation interrupted'));
    render(
      <RegistryClassificationReview entityId="same-entity" disabled={false} onApplied={vi.fn()} />
    );
    await open();
    fireEvent.click(screen.getByRole('radio', { name: 'Classify as DNA oligo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await screen.findByRole('button', { name: 'Retry saved choice' });
    const request = mocks.apply.mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved choice' }));
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
    expect(mocks.apply.mock.calls[1][0]).toEqual(request);
  });
  it('shows unavailable data without offering an apply action', async () => {
    mocks.review.mockResolvedValue({ status: 'unavailable', reason: 'circular_sequence' });
    render(
      <RegistryClassificationReview entityId="same-entity" disabled={false} onApplied={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review classification' }));
    expect(
      await screen.findByText(
        'This sequence is circular. Oligo classification requires a linear sequence.'
      )
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save choice' })).toBeNull();
  });
});
