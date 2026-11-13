import { userMessage } from '@waypoint/user-messages';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SequenceTabStatus } from '../features/sequence/components/SequenceTabStatus';
import { StatusOverridePopover } from '../features/alignment-manager/panel/StatusOverridePopover';
import type { VerificationTrack } from '../features/alignment-manager/public';

const track: VerificationTrack = {
  id: 'saved-review-track',
  label: 'saved read',
  queryPath: '/project/read.fasta',
  alignment: {
    alignedReference: 'ACGT',
    alignedQuery: 'ACGT',
    identity: 100,
    coverageStart: 1,
    coverageEnd: 4,
    algorithm: 'MAFFT',
  },
  mutations: [],
  status: 'pass',
  alignedAt: '2026-11-02T00:00:00Z',
};
const override = vi.fn();

beforeEach(() => {
  override.mockReset();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    bottom: 120,
    left: 100,
    right: 120,
    width: 20,
    height: 20,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
});
afterEach(() => vi.restoreAllMocks());

function Review() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} onClick={() => setOpen(true)}>
        Review saved alignment
      </button>
      {open && (
        <StatusOverridePopover
          track={track}
          anchorRef={anchor}
          onOverride={override}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Surface({
  loading,
  cached = true,
  error = null,
}: {
  loading: boolean;
  cached?: boolean;
  error?: string | null;
}) {
  return (
    <SequenceTabStatus
      isLoading={loading}
      error={error}
      sequence={cached ? track : null}
      displaySequence={cached ? track : null}
      parsedPlasmid={cached ? track : null}
      ready={() => <Review />}
    />
  );
}

it('keeps the live alignment review and typed reason through a background sequence refresh', () => {
  const view = render(<Surface loading={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review saved alignment' }));
  const reason = screen.getByPlaceholderText('Reason (optional)');
  fireEvent.change(reason, { target: { value: 'Checked against the saved reference' } });
  view.rerender(<Surface loading />);
  expect(screen.getByPlaceholderText('Reason (optional)')).toBe(reason);
  expect(reason).toHaveValue('Checked against the saved reference');
  view.rerender(<Surface loading={false} />);
  expect(screen.getByPlaceholderText('Reason (optional)')).toBe(reason);
  fireEvent.click(screen.getByRole('button', { name: 'Pass' }));
  expect(override).toHaveBeenCalledExactlyOnceWith('pass', 'Checked against the saved reference');
});

it('retains the initial loading surface until sequence data is available', () => {
  render(<Surface loading cached={false} />);
  expect(screen.getByTestId('sequence-loading')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Review saved alignment' })).toBeNull();
});

it('still reports a real sequence load error during a background refresh', () => {
  render(<Surface loading={false} error="The saved source is invalid." />);
  expect(screen.getByTestId('sequence-error')).toHaveTextContent(
    userMessage('sequence.loadFailed')
  );
  expect(screen.queryByRole('button', { name: 'Review saved alignment' })).toBeNull();
});
