import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../presentation/PresentationSurface';
import {
  toUserMessage,
  userMessage,
  renderUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button, TextField, UI_MODAL_LAYER_CLASS } from '../components/ui';
import { createHostedWorkspaceShare } from './api';

export interface HostedShareDialogProps {
  workspaceId: string;
  revisionId: string;
  revisionNumber: number;
  workspaceName: string;
  onClose: () => void;
  onCreated?: (message: string) => void;
  blockedReason?: UserMessage;
  expectedAccountId?: string;
}

export function HostedShareDialog(props: HostedShareDialogProps) {
  return (
    <ScopedHostedShareDialog
      key={JSON.stringify([props.expectedAccountId, props.workspaceId, props.revisionId])}
      {...props}
    />
  );
}

function ScopedHostedShareDialog({
  workspaceId,
  revisionId,
  revisionNumber,
  workspaceName,
  onClose,
  onCreated,
  blockedReason,
  expectedAccountId,
}: HostedShareDialogProps) {
  const presentationOverlay = usePresentationOverlay('modal');

  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const unavailableReason: UserMessage | undefined =
    blockedReason ?? (!expectedAccountId ? userMessage('sharing.signInRequired') : undefined);
  const [label, setLabel] = useState(workspaceName);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function publish(): Promise<void> {
    if (unavailableReason || !expectedAccountId || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await createHostedWorkspaceShare({
        workspaceId,
        expectedLatestVersionId: revisionId,
        displayLabel: label.trim() || workspaceName,
        expectedAccountId,
      });
      if (!alive.current) return;
      setShareUrl(result.url);
      setMessage('Pinned public link created.');
      onCreated?.('Pinned public link created.');
    } catch (cause) {
      if (!alive.current) return;
      setError(toUserMessage(cause, 'failure.could-not-publish-the-sequence-link'));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function copyLink(): Promise<void> {
    if (!shareUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(shareUrl);
      if (!alive.current) return;
      setMessage('Link copied. Anyone who receives it can view this pinned revision.');
    } catch {
      if (!alive.current) return;
      setError(
        userMessage('failure.clipboard-access-is-unavailable-select-the-url-and-copy-it-manually')
      );
    }
  }

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className={`hosted-share-backdrop ${UI_MODAL_LAYER_CLASS}`}
      data-testid="hosted-share-dialog-backdrop"
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <section
          className="hosted-share-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="hosted-share-title"
          data-testid="hosted-share-dialog"
        >
          <div className="hosted-share-heading">
            <div>
              <div className="hosted-share-eyebrow">Public sequence link</div>
              <h2 id="hosted-share-title">Share revision {revisionNumber}</h2>
            </div>
            <button type="button" aria-label="Close share dialog" onClick={onClose}>
              ×
            </button>
          </div>

          {shareUrl ? (
            <>
              <p className="hosted-share-copy" data-testid="hosted-share-success">
                This link opens a read-only scientific preview. Viewers can sign in to create a
                private editable fork or open the pinned revision in DNAForge desktop.
              </p>
              {message ? (
                <p
                  className="hosted-share-message"
                  data-testid="hosted-share-message"
                  role="status"
                >
                  {message}
                </p>
              ) : null}
              <label className="hosted-share-field">
                <span>Canonical share URL</span>
                <TextField data-testid="hosted-share-url" monospace readOnly value={shareUrl} />
              </label>
              <div className="hosted-share-actions">
                <Button
                  type="button"
                  variant="primary"
                  data-testid="hosted-share-copy"
                  onClick={() => void copyLink()}
                >
                  Copy link
                </Button>
                <a
                  className="hosted-share-preview"
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open preview
                </a>
                <Button type="button" onClick={onClose}>
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="hosted-share-warning" data-testid="hosted-share-warning">
                Anyone who receives this link can view the exact files in this pinned revision. Do
                not publish confidential sequence data or credentials.
              </p>
              <label className="hosted-share-field">
                <span>Link label</span>
                <TextField
                  data-testid="hosted-share-label"
                  value={label}
                  maxLength={120}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              {error ? (
                <p className="hosted-share-error" data-testid="hosted-share-error" role="alert">
                  {toUserMessage(error, 'sharing.failed')}
                </p>
              ) : null}
              {unavailableReason ? (
                <p className="hosted-share-error" role="status">
                  {renderUserMessage(unavailableReason)}
                </p>
              ) : null}
              {message ? (
                <p
                  className="hosted-share-message"
                  data-testid="hosted-share-message"
                  role="status"
                >
                  {message}
                </p>
              ) : null}
              <div className="hosted-share-actions">
                <Button
                  type="button"
                  variant="primary"
                  data-testid="hosted-share-publish"
                  disabled={busy || Boolean(unavailableReason)}
                  onClick={() => void publish()}
                >
                  {busy ? 'Publishing…' : 'Publish public link'}
                </Button>
                <Button type="button" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
