import { toUserMessage } from '@waypoint/user-messages';
import { useState, useCallback, useRef } from 'react';
import { platform } from '../platform';
import { TelemetryBlockedSurface } from './TelemetryBlockedSurface';
import { sanitizeFeedbackText as sanitize, type FeedbackError } from '../shared/feedback';
import { ChatTabIcon } from './icons/glyphs';
import { Button, TextArea } from './ui';

const MAX_LENGTH = 2000;

interface FeedbackWidgetProps {
  appVersion: string;

  titleBarInset?: boolean;
}

type ToastState = { type: 'success' | 'error'; message: string } | null;

export function FeedbackWidget({ appVersion, titleBarInset = false }: FeedbackWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const showToast = useCallback((state: ToastState) => {
    setToast(state);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const revision = useRef(0);
  const session = useRef(0);
  const submission = useRef<{ id: string; revision: number } | null>(null);
  const active = useRef<symbol | null>(null);
  const cancelling = useRef<symbol | null>(null);
  const [notice, setNotice] = useState<{ text: string; retry: boolean } | null>(null);

  function closeComposer(): void {
    session.current += 1;
    active.current = null;
    setSending(false);
    setIsOpen(false);
    const submitted = submission.current;
    if (!submitted || cancelling.current) return;

    const owner = Symbol();
    cancelling.current = owner;
    const draftRevision = revision.current;
    const retry = submitted.revision === draftRevision;
    setNotice({ text: 'Stopping automatic retries. Your draft is kept.', retry });
    const finish = (cancelled: boolean) => {
      if (cancelling.current !== owner) return;
      cancelling.current = null;
      if (revision.current !== draftRevision) return;
      if (cancelled) {
        setNotice({
          text: 'Automatic retries stopped. The service may already have received it. Your draft is kept.',
          retry,
        });
      } else {
        setNotice({ text: 'Automatic retries could not be stopped. Your draft is kept.', retry });
        showToast({ type: 'error', message: 'Could not stop the saved retry. Draft kept.' });
      }
    };
    void platform()
      .feedback.cancel(submitted.id)
      .then(
        (result) => finish(result.error === 'cancelled'),
        () => finish(false)
      );
  }

  function errorMessage(reason?: FeedbackError): string {
    switch (reason) {
      case 'queue_full':
        return 'Saved feedback is full. Your draft is kept. Retry after earlier feedback is sent.';
      case 'queue_corrupt':
        return 'Saved feedback needs recovery. Your draft and existing saved records are kept.';
      case 'storage_unavailable':
        return 'Could not confirm a local save. Your draft is kept.';
      case 'permanent_refusal':
      case 'invalid_payload':
        return 'The service refused this feedback. Edit your draft and try again.';
      case 'delivery_unconfirmed':
        return 'Receipt could not be confirmed. Automatic retries stopped. Your draft is kept.';
      case 'cancelled':
        return 'Stopped waiting. The service may already have received it. Your draft is kept.';
      default:
        return 'Failed to send feedback. Your draft is kept. Try again.';
    }
  }

  async function handleSend(): Promise<void> {
    const sanitized = sanitize(message).trim();
    if (active.current) return;
    if (!sanitized) {
      setNotice({ text: 'Enter text before sending feedback. Your draft is kept.', retry: false });
      return;
    }
    const draftRevision = revision.current;
    const formSession = session.current;
    if (submission.current?.revision !== draftRevision) {
      submission.current = { id: crypto.randomUUID(), revision: draftRevision };
    }
    const id = submission.current.id;
    const owner = Symbol();
    cancelling.current = null;
    active.current = owner;
    setSending(true);
    setNotice(null);
    try {
      const result = await platform().feedback.send({
        message: sanitized,
        app_version: appVersion,
        submission_id: id,
        platform_info: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      });
      if (active.current !== owner || session.current !== formSession) return;
      const sameDraft = revision.current === draftRevision;
      if (result.success) {
        showToast({ type: 'success', message: 'Feedback received — thank you!' });
        if (sameDraft) {
          setMessage('');
          revision.current += 1;
          submission.current = null;
          setIsOpen(false);
          session.current += 1;
        } else {
          setNotice({ text: 'Earlier feedback received. Your newer draft is kept.', retry: false });
        }
      } else if (result.queued) {
        setNotice({
          text: sameDraft
            ? 'Saved on this device. Retry now, or DNAForge will retry at its next start.'
            : 'Earlier feedback was saved on this device. DNAForge will retry it at its next start. Your newer draft is kept.',
          retry: sameDraft,
        });
      } else {
        setNotice({ text: errorMessage(result.error), retry: sameDraft });
      }
    } catch {
      if (active.current === owner && session.current === formSession) {
        setNotice({
          text: 'Failed to send feedback. Your draft is kept. Try again.',
          retry: revision.current === draftRevision,
        });
      }
    } finally {
      if (active.current === owner) {
        active.current = null;
        setSending(false);
      }
    }
  }

  const charCount = message.length;
  const isOverLimit = charCount > MAX_LENGTH;
  const overlayBounds = titleBarInset ? 'inset-x-0 bottom-0 top-8' : 'inset-0';

  return (
    <TelemetryBlockedSurface className="contents">
      <button
        onClick={() => {
          session.current += 1;
          setIsOpen(true);
        }}
        className="appbar-action"
        aria-label="Send feedback"
        title="Send feedback"
      >
        {titleBarInset && <ChatTabIcon className="appbar-compact-icon h-3.5 w-3.5" />}
        <span className="appbar-action-label">Feedback</span>
      </button>

      {isOpen && (
        <div className={`fixed ${overlayBounds} z-50 flex items-end justify-end p-4`}>
          <div className={`fixed ${overlayBounds} bg-black/20`} onClick={closeComposer} />
          <div
            data-testid="feedback-composer"
            className="relative bg-bg border border-border rounded-xl shadow-lg w-80 p-4"
          >
            <h3 className="text-sm font-semibold text-fg mb-2">Send Feedback</h3>
            <TextArea
              value={message}
              onChange={(e) => {
                revision.current += 1;
                setMessage(e.target.value);
                setNotice(null);
              }}
              aria-label="Feedback message"
              data-testid="feedback-message"
              maxLength={MAX_LENGTH}
              placeholder="Tell us what you think, or report a bug..."
              rows={4}
              autoFocus
            />
            {notice && (
              <p role="status" data-testid="feedback-status" className="mt-2 text-xs text-fg-muted">
                {notice.text}
              </p>
            )}
            <div className="flex justify-between items-center mt-2">
              <span className={`text-xs ${isOverLimit ? 'text-red-500' : 'text-fg-subtle'}`}>
                {charCount}/{MAX_LENGTH}
              </span>
              <div className="flex gap-2">
                <Button onClick={closeComposer}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={handleSend}
                  disabled={!message.trim() || isOverLimit || sending}
                  aria-label={sending ? 'Sending' : notice?.retry ? 'Retry' : 'Send'}
                >
                  {sending ? 'Sending...' : notice ? 'Retry' : 'Send'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-[60] px-4 py-2 rounded-lg text-sm shadow-lg transition-opacity ${
            toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {toUserMessage(toast.message, 'operation.failed')}
        </div>
      )}
    </TelemetryBlockedSurface>
  );
}
