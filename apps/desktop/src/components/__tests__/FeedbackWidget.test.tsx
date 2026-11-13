import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FeedbackWidget } from '../FeedbackWidget';
import type { FeedbackResult } from '../../shared/feedback';

const mockSend = vi.fn();
const mockCancel = vi.fn();

vi.mock('../../platform', () => ({
  platform: () => ({
    feedback: {
      send: (...args: unknown[]) => mockSend(...args),
      cancel: (...args: unknown[]) => mockCancel(...args),
    },
  }),
}));

describe('FeedbackWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ success: true });
    mockCancel.mockResolvedValue({ success: false, error: 'cancelled' });
  });

  it('should render the trigger button', () => {
    render(<FeedbackWidget appVersion="1.0.0" />);
    const trigger = screen.getByRole('button', { name: /feedback/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass('appbar-action');
  });

  it('should open modal when trigger clicked', () => {
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    expect(screen.getByPlaceholderText(/tell us/i)).toBeInTheDocument();
  });

  it('keeps the Windows titlebar outside the feedback backdrop', () => {
    render(<FeedbackWidget appVersion="1.0.0" titleBarInset />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    const textarea = screen.getByPlaceholderText(/tell us/i);
    const overlay = textarea.closest('.z-50');
    expect(overlay).toHaveClass('top-8', 'inset-x-0', 'bottom-0');
    expect(overlay?.querySelector('.bg-black\\/20')).toHaveClass('top-8');
  });

  it('should disable send when textarea is empty', () => {
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('should enable send when textarea has content', () => {
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.change(screen.getByPlaceholderText(/tell us/i), {
      target: { value: 'Great app!' },
    });
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
  });

  it('should show character counter', () => {
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    expect(screen.getByText('0/2000')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/tell us/i), {
      target: { value: 'Hello' },
    });
    expect(screen.getByText('5/2000')).toBeInTheDocument();
  });

  it('should call IPC feedback.send on submit', async () => {
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.change(screen.getByPlaceholderText(/tell us/i), {
      target: { value: 'Bug report' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Bug report', app_version: '1.0.0' })
      );
    });
  });

  it('should show success toast on successful send', async () => {
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.change(screen.getByPlaceholderText(/tell us/i), {
      target: { value: 'Feature request' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText(/thank you/i)).toBeInTheDocument();
    });
  });

  it('should show queued toast when offline', async () => {
    mockSend.mockResolvedValue({ success: false, queued: true });
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.change(screen.getByPlaceholderText(/tell us/i), {
      target: { value: 'test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText(/next start/i)).toBeInTheDocument();
    });
  });

  it('should show error toast on failure', async () => {
    mockSend.mockRejectedValue(new Error('IPC error'));
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.change(screen.getByPlaceholderText(/tell us/i), {
      target: { value: 'test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText(/failed/i)).toBeInTheDocument();
    });
  });

  it('should close modal and clear message after send', async () => {
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.change(screen.getByPlaceholderText(/tell us/i), {
      target: { value: 'Feature request' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/tell us/i)).not.toBeInTheDocument();
    });
  });
});

describe('feedback draft ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCancel.mockResolvedValue({ success: false, error: 'cancelled' });
  });
  function compose(text: string) {
    render(<FeedbackWidget appVersion="1.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  }
  it.each([false, true])(
    'retains an editable draft for rejected IPC throwing=%s',
    async (throwing) => {
      if (throwing) mockSend.mockRejectedValue(new Error('bounded IPC refusal'));
      else mockSend.mockResolvedValue({ success: false, error: 'storage_unavailable' });
      compose('harmless retained draft');
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(screen.getByRole('textbox')).toHaveValue('harmless retained draft')
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
      const firstId = mockSend.mock.calls[0][0].submission_id;
      mockSend.mockResolvedValue({ success: true });
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
      expect(mockSend.mock.calls[1][0].submission_id).toBe(firstId);
    }
  );
  it('does not erase a newer edit when an earlier submission succeeds', async () => {
    let release!: (result: { success: boolean }) => void;
    mockSend.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    compose('harmless first draft');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'harmless newer draft' } });
    release({ success: true });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('harmless newer draft'));
    await waitFor(() => expect(screen.getByText(/newer draft is kept/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  });
  it('attributes a queued result to the earlier draft when the user has already edited it', async () => {
    const result = Promise.withResolvers<{ success: boolean; queued: boolean }>();
    mockSend.mockReturnValue(result.promise);
    compose('harmless earlier draft');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'harmless newer draft' } });

    await act(async () => result.resolve({ success: false, queued: true }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Earlier feedback was saved on this device. DNAForge will retry it at its next start. Your newer draft is kept.'
    );
    expect(screen.getByRole('textbox')).toHaveValue('harmless newer draft');
    expect(screen.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  });
  it('does not close or erase a reopened form after cancel and stale completion', async () => {
    let release!: (result: { success: boolean }) => void;
    mockSend.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    compose('harmless original');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'harmless reopened draft' } });
    release({ success: true });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('harmless reopened draft'));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      'cancelled',
      'Automatic retries stopped. The service may already have received it. Your draft is kept.',
    ],
    ['storage_unavailable', 'Automatic retries could not be stopped. Your draft is kept.'],
  ] as const)('reports the actual cancellation outcome for %s', async (error, outcome) => {
    let finishCancel!: (result: FeedbackResult) => void;
    mockSend.mockResolvedValue({ success: false, queued: true });
    mockCancel.mockReturnValue(new Promise<FeedbackResult>((resolve) => (finishCancel = resolve)));
    compose('harmless saved draft');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/saved on this device/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));

    expect(screen.getByRole('status')).toHaveTextContent('Stopping automatic retries.');
    finishCancel({ success: false, error });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(outcome));
    expect(screen.getByRole('textbox')).toHaveValue('harmless saved draft');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith(mockSend.mock.calls[0][0].submission_id);
  });
  it('keeps a new send outcome when a previous cancellation settles', async () => {
    let finishCancel!: (result: FeedbackResult) => void;
    mockSend.mockResolvedValue({ success: false, queued: true });
    mockCancel.mockReturnValue(new Promise<FeedbackResult>((resolve) => (finishCancel = resolve)));
    compose('harmless first draft');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/saved on this device/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /feedback/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/saved on this device/i);
    await act(async () => finishCancel({ success: false, error: 'cancelled' }));

    expect(screen.getByRole('status')).toHaveTextContent(/saved on this device/i);
    expect(screen.getByRole('textbox')).toHaveValue('harmless first draft');
    expect(mockSend.mock.calls[0][0].submission_id).toBe(mockSend.mock.calls[1][0].submission_id);
  });
  it('puts its complete compose surface inside the private boundary', () => {
    compose('harmless private draft');
    expect(screen.getByRole('textbox').closest('[data-analytics-block]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Send' }).closest('.ph-no-capture')).not.toBeNull();
  });
});
