import { renderUserMessage, type UserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, UI_MODAL_LAYER_CLASS } from '../components/ui';
import { onHostedKeepWorkRequest, useHostedDemoSession } from './capabilities';
import { DEMO_SWEEP_GRACE_MS, requestDemoCarry, resolveDemoSessionId } from './demo-session';

export function HostedKeepWorkButton() {
  const demo = useHostedDemoSession();
  const [reason, setReason] = useState<UserMessage | null | undefined>(undefined);
  useEffect(() => onHostedKeepWorkRequest((next) => setReason(next)), []);
  if (!demo) return null;
  return (
    <>
      <button
        type="button"
        className="hosted-primary-button"
        data-testid="hosted-demo-keep-work"
        title="Create an account and keep these projects"
        onClick={() => setReason(null)}
      >
        Sign up to keep your work
      </button>
      {reason !== undefined ? (
        <HostedKeepWorkDialog reason={reason} onClose={() => setReason(undefined)} />
      ) : null}
    </>
  );
}

function HostedKeepWorkDialog({
  reason,
  onClose,
}: {
  readonly reason: UserMessage | null;
  readonly onClose: () => void;
}) {
  const minutes = Math.round(DEMO_SWEEP_GRACE_MS / 60_000);
  const signUp = () => {
    const sessionId = resolveDemoSessionId();
    if (sessionId) requestDemoCarry(sessionId);
    window.location.assign('/login?next=/hosted.html');
  };
  return createPortal(
    <div className={`hosted-share-backdrop ${UI_MODAL_LAYER_CLASS}`}>
      <section
        className="hosted-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hosted-demo-keep-work-title"
        data-testid="hosted-demo-keep-work-dialog"
      >
        <div className="hosted-share-heading">
          <div>
            <div className="hosted-share-eyebrow">Demo session</div>
            <h2 id="hosted-demo-keep-work-title">
              {renderUserMessage(reason ?? userMessage('failure.sign-up-to-keep-your-work'))}
            </h2>
          </div>
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="hosted-share-copy">
          This demo runs entirely in your browser. Your projects are saved in this tab and are
          removed about {minutes} minutes after you close it. Create a free account to keep them,
          run server jobs, search public databases and share links.
        </p>
        <div className="hosted-share-actions">
          <Button
            type="button"
            variant="primary"
            data-testid="hosted-demo-sign-up"
            onClick={signUp}
          >
            Sign up and keep these projects
          </Button>
          <Button type="button" onClick={onClose}>
            Keep exploring
          </Button>
        </div>
      </section>
    </div>,
    document.body
  );
}
