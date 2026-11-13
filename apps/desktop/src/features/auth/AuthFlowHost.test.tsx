import { userMessagePayload, userMessageValue } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { DesktopAuthState } from '../../shared/auth-types';

const h = vi.hoisted(() => ({
  state: { status: 'signed-out' } as DesktopAuthState,
  cancelSignIn: vi.fn(),
  reopenSignIn: vi.fn(),
  chooseOAuth: vi.fn(),
  chooseSso: vi.fn(),
  startEmailSignIn: vi.fn(),
  submitEmailCode: vi.fn(),
}));

vi.mock('../../stores/auth-store', () => {
  const snapshot = () => ({
    state: h.state,
    cancelSignIn: h.cancelSignIn,
    reopenSignIn: h.reopenSignIn,
    chooseOAuth: h.chooseOAuth,
    chooseSso: h.chooseSso,
    startEmailSignIn: h.startEmailSignIn,
    submitEmailCode: h.submitEmailCode,
  });
  const useAuthStore = (selector: (s: unknown) => unknown) => selector(snapshot());
  useAuthStore.getState = snapshot;
  return { useAuthStore };
});

import { AuthFlowHost } from './AuthFlowHost';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuthFlowHost', () => {
  it('renders nothing when not in a sign-in flow', () => {
    h.state = { status: 'signed-out' };
    const { container } = render(<AuthFlowHost />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when signed in', () => {
    h.state = {
      status: 'signed-in',
      session: {
        accountId: 'a',
        desktopSessionId: 's',
        channel: 'stable',
        accessTokenExpiresAt: 'x',
      },
    };
    const { container } = render(<AuthFlowHost />);
    expect(container.firstChild).toBeNull();
  });

  it('awaiting-confirmation shows a browser waiting message (no verification-code box)', () => {
    h.state = { status: 'awaiting-confirmation' };
    render(<AuthFlowHost />);
    expect(screen.getByTestId('auth-flow-host')).toBeTruthy();
    expect(screen.getByText(/continue in your web browser/i)).toBeTruthy();
    expect(screen.queryByTestId('auth-user-code')).toBeNull();
    expect(screen.queryByTestId('auth-user-code-pending')).toBeNull();
  });

  it('shows a completing state during exchange', () => {
    h.state = { status: 'exchanging' };
    render(<AuthFlowHost />);
    expect(screen.getByTestId('auth-flow-host')).toBeTruthy();
    expect(screen.getByText(/finishing up/i)).toBeTruthy();
  });

  it('cancel calls cancelSignIn', () => {
    h.state = { status: 'awaiting-confirmation' };
    render(<AuthFlowHost />);
    fireEvent.click(screen.getByTestId('auth-cancel'));
    expect(h.cancelSignIn).toHaveBeenCalled();
  });

  it('open-browser button calls reopenSignIn', () => {
    h.state = { status: 'awaiting-confirmation' };
    render(<AuthFlowHost />);
    fireEvent.click(screen.getByTestId('auth-open-browser'));
    expect(h.reopenSignIn).toHaveBeenCalled();
  });

  it('surfaces a hint when the browser failed to open', () => {
    h.state = { status: 'awaiting-confirmation', browserOpenFailed: true };
    render(<AuthFlowHost />);
    expect(screen.getByTestId('auth-browser-open-failed')).toBeTruthy();
  });

  it('does NOT show the open-failed hint on a normal awaiting state', () => {
    h.state = { status: 'awaiting-confirmation' };
    render(<AuthFlowHost />);
    expect(screen.queryByTestId('auth-browser-open-failed')).toBeNull();
  });

  it('choosing: a valid email enables "Email me a code" and calls startEmailSignIn', () => {
    h.state = { status: 'choosing' };
    render(<AuthFlowHost />);
    const submit = screen.getByTestId('auth-email-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('auth-email-input'), { target: { value: 'me@lab.edu' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(h.startEmailSignIn).toHaveBeenCalledWith('me@lab.edu');
  });

  it('choosing: Google and GitHub buttons show official provider marks', () => {
    h.state = { status: 'choosing' };
    render(<AuthFlowHost />);
    expect(screen.getByTestId('auth-google').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('auth-github').querySelector('svg')).toBeTruthy();
  });

  it('choosing: OAuth buttons say Continue with Google/GitHub (not Sign in with…)', () => {
    h.state = { status: 'choosing' };
    render(<AuthFlowHost />);
    expect(screen.getByText('Continue to DNAForge')).toBeTruthy();
    const google = screen.getByTestId('auth-google');
    const github = screen.getByTestId('auth-github');
    expect(google).toHaveTextContent('Continue with Google');
    expect(github).toHaveTextContent('Continue with GitHub');
    expect(screen.queryByText(/Sign in with/i)).toBeNull();
  });

  it('choosing: Google calls chooseOAuth AND shows immediate connecting feedback', async () => {
    h.state = { status: 'choosing' };
    render(<AuthFlowHost />);
    fireEvent.click(screen.getByTestId('auth-google'));
    expect(h.chooseOAuth).toHaveBeenCalledWith('google');
    expect(screen.getByTestId('auth-connecting')).toBeTruthy();
    expect(screen.queryByTestId('auth-github')).toBeNull();
    await act(async () => {});
  });

  it('choosing: GitHub calls chooseOAuth', async () => {
    h.state = { status: 'choosing' };
    render(<AuthFlowHost />);
    fireEvent.click(screen.getByTestId('auth-github'));
    expect(h.chooseOAuth).toHaveBeenCalledWith('github');
    await act(async () => {});
  });

  it('choosing: providers are listed BEFORE the email option (primary vs secondary)', () => {
    h.state = { status: 'choosing' };
    render(<AuthFlowHost />);
    const google = screen.getByTestId('auth-google');
    const email = screen.getByTestId('auth-email-input');
    expect(google.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('choosing: SSO expands email input then calls chooseSso', async () => {
    h.state = { status: 'choosing' };
    render(<AuthFlowHost />);
    fireEvent.click(screen.getByTestId('auth-sso'));
    expect(screen.getByTestId('auth-sso-input')).toBeTruthy();
    const submit = screen.getByTestId('auth-sso-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('auth-sso-email'), {
      target: { value: 'pi@example.edu' },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(h.chooseSso).toHaveBeenCalledWith('pi@example.edu');
    expect(screen.getByTestId('auth-connecting')).toBeTruthy();
    await act(async () => {});
  });

  it('starting: shows a loading spinner in place (not the chooser yet)', () => {
    h.state = { status: 'starting' };
    render(<AuthFlowHost />);
    expect(screen.getByTestId('auth-flow-host')).toBeTruthy();
    expect(screen.getByTestId('auth-starting')).toBeTruthy();
    expect(screen.queryByTestId('auth-google')).toBeNull();
  });

  it('email-sent: Verify is gated on a 6-digit code and calls submitEmailCode', () => {
    h.state = { status: 'email-sent', email: 'me@lab.edu' };
    render(<AuthFlowHost />);
    const verify = screen.getByTestId('auth-code-submit') as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('auth-code-input'), { target: { value: '123456' } });
    expect(verify.disabled).toBe(false);
    fireEvent.click(verify);
    expect(h.submitEmailCode).toHaveBeenCalledWith('123456');
  });

  it('email-sent: says up front that a new code can be requested 60 seconds after the last', () => {
    h.state = { status: 'email-sent', email: 'me@lab.edu' };
    render(<AuthFlowHost />);
    expect(screen.getByTestId('auth-resend-hint').textContent).toContain(
      'You can request a new code 60 seconds after the last one.'
    );
    expect(screen.getByTestId('auth-resend-hint').contains(screen.getByTestId('auth-resend'))).toBe(
      true
    );
  });

  it('email-sent: non-digits are stripped from the code input', () => {
    h.state = { status: 'email-sent', email: 'me@lab.edu' };
    render(<AuthFlowHost />);
    const input = screen.getByTestId('auth-code-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12ab34' } });
    expect(input.value).toBe('1234');
  });

  it('email-sent: an error message renders inline; Resend calls startEmailSignIn', () => {
    h.state = {
      status: 'email-sent',
      email: 'me@lab.edu',
      error: 'That code is invalid or expired. Try again.',
    };
    render(<AuthFlowHost />);
    expect(screen.getByTestId('auth-email-error').textContent).toMatch(/invalid or expired/i);
    fireEvent.click(screen.getByTestId('auth-resend'));
    expect(h.startEmailSignIn).toHaveBeenCalledWith('me@lab.edu');
  });

  it('clears stale code when a fresh chooser opens (no pre-fill)', () => {
    h.state = { status: 'email-sent', email: 'me@lab.edu' };
    const { rerender } = render(<AuthFlowHost />);
    fireEvent.change(screen.getByTestId('auth-code-input'), { target: { value: '123456' } });
    expect((screen.getByTestId('auth-code-input') as HTMLInputElement).value).toBe('123456');
    h.state = { status: 'choosing' };
    rerender(<AuthFlowHost />);
    h.state = { status: 'email-sent', email: 'me@lab.edu' };
    rerender(<AuthFlowHost />);
    expect((screen.getByTestId('auth-code-input') as HTMLInputElement).value).toBe('');
  });

  it('email submit shows a "Sending…" loading state after click', () => {
    h.state = { status: 'choosing' };
    render(<AuthFlowHost />);
    fireEvent.change(screen.getByTestId('auth-email-input'), { target: { value: 'me@lab.edu' } });
    const btn = screen.getByTestId('auth-email-submit') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.textContent).toMatch(/sending/i);
    expect(btn.disabled).toBe(true);
  });

  it('choosing with a send failure shows the reason beside Google and GitHub', () => {
    h.state = {
      status: 'choosing',
      error:
        'Please wait about 40 minutes before requesting another code, or continue with Google or GitHub.',
      errorMessagePayload: userMessagePayload('auth.emailWait', {
        duration: userMessageValue('about 40 minutes'),
      }),
    };
    render(<AuthFlowHost />);
    expect(screen.getByRole('alert').textContent).toBe(
      'Please wait about 40 minutes before requesting another code, or continue with Google or GitHub.'
    );
    fireEvent.click(screen.getByTestId('auth-github'));
    expect(h.chooseOAuth).toHaveBeenCalledWith('github');
  });

  it('re-enables the email button when a send fails and the chooser stays open', async () => {
    h.state = { status: 'choosing' };
    h.startEmailSignIn.mockImplementation(async () => {
      h.state = {
        status: 'choosing',
        error: 'Could not send the code. Try again, or continue with Google or GitHub.',
      };
    });
    const { rerender } = render(<AuthFlowHost />);
    fireEvent.change(screen.getByTestId('auth-email-input'), { target: { value: 'me@lab.edu' } });
    fireEvent.click(screen.getByTestId('auth-email-submit'));
    await act(async () => {});
    rerender(<AuthFlowHost />);
    const btn = screen.getByTestId('auth-email-submit') as HTMLButtonElement;
    expect(btn.textContent).toBe('Email me a code');
    expect(btn.disabled).toBe(false);
    expect(screen.getByTestId('auth-email-start-error').textContent).toBe(
      'Could not send the code. Try again, or continue with Google or GitHub.'
    );
  });

  it('code field placeholder is dashed slots (not 000000)', () => {
    h.state = { status: 'email-sent', email: 'me@lab.edu' };
    render(<AuthFlowHost />);
    const ph = (screen.getByTestId('auth-code-input') as HTMLInputElement).placeholder;
    expect(ph).not.toMatch(/0{6}/);
    expect(ph).toMatch(/[—–-]/);
  });
});
