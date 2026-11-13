import { type UserMessage, toUserMessage, userMessage } from '@waypoint/user-messages';

import { useEffect, useState } from 'react';
import { Button, UI_MODAL_LAYER_CLASS } from '../components/ui';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { parseSequencePackageAdmissionDescriptor } from '@waypoint/share-bundle/sequence-package-admission';
import type { WorkspaceSessionSnapshot } from '@waypoint/domain-services';
import { hostedDurableSync } from './controller';
import type {
  WorkspaceSessionReconcileInput,
  WorkspaceSessionReconcileSide,
} from './sync-reconcile';

type ConflictPreview =
  | { kind: 'content'; content: string }
  | { kind: 'message'; message: UserMessage };

type Review = Awaited<ReturnType<typeof hostedDurableSync.inspectConflict>>;

export function HostedConflictPanel({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose(): void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [choices, setChoices] = useState<NonNullable<WorkspaceSessionReconcileInput['choices']>>(
    {}
  );
  const [error, setError] = useState<UserMessage | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void hostedDurableSync
      .inspectConflict(workspaceId)
      .then((next) => {
        if (!cancelled) setReview(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(toUserMessage(cause, 'operation.failed'));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const conflicts = review?.result.kind === 'conflict' ? review.result.conflicts : [];
  async function resolve() {
    setBusy(true);
    setError(null);
    try {
      const next = await hostedDurableSync.resolveConflict(workspaceId, choices);
      if (next.result.kind === 'merged') onClose();
      else {
        setReview(next);
        setError(
          userMessage(
            'failure.the-compared-content-changed-or-still-conflicts-review-the-current-ver'
          )
        );
        setChoices({});
      }
    } catch (cause) {
      setError(toUserMessage(cause, 'operation.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`hosted-share-backdrop ${UI_MODAL_LAYER_CLASS}`}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="hosted-conflict-title"
        className="hosted-conflict-dialog"
        data-testid="hosted-sync-conflict-dialog"
      >
        <h2 id="hosted-conflict-title">Review saved versions</h2>
        <p>
          Your local draft and the server version remain separate until you choose. Choosing a side
          applies the complete package, including its sequence, metadata and attachments.
        </p>
        {error ? <p role="alert">{toUserMessage(error, 'operation.failed')}</p> : null}
        {!review && !error ? <p>Loading exact saved versions…</p> : null}
        {review?.result.kind === 'invalid' ? <p role="alert">{review.result.reason}</p> : null}
        {review?.result.kind === 'merged' ? (
          <p>These changes can be combined without choosing between conflicting content.</p>
        ) : null}
        {review
          ? conflicts.map((conflict) => (
              <fieldset key={conflict.reviewFingerprint} data-resource-id={conflict.resourceId}>
                <legend>
                  {conflict.path} — {conflict.reason.replace(/-/gu, ' ')}
                </legend>
                <div className="hosted-conflict-sides">
                  <ConflictSide
                    label="Common version"
                    side={conflict.base}
                    snapshot={review.base}
                  />
                  <ConflictSide
                    label="My saved draft"
                    side={conflict.local}
                    snapshot={review.local}
                  />
                  <ConflictSide
                    label="Server version"
                    side={conflict.remote}
                    snapshot={review.remote}
                  />
                </div>
                {(['mine', 'theirs'] as const).map((choice) => (
                  <label key={choice}>
                    <input
                      type="radio"
                      name={conflict.resourceId}
                      value={choice}
                      checked={
                        choices[conflict.resourceId]?.choice === choice &&
                        choices[conflict.resourceId]?.reviewFingerprint ===
                          conflict.reviewFingerprint
                      }
                      onChange={() =>
                        setChoices((current) => ({
                          ...current,
                          [conflict.resourceId]: {
                            choice,
                            reviewFingerprint: conflict.reviewFingerprint,
                          },
                        }))
                      }
                    />
                    {choice === 'mine'
                      ? conflict.local
                        ? 'Keep my draft'
                        : 'Keep my deletion'
                      : conflict.remote
                        ? 'Keep server version'
                        : 'Keep server deletion'}
                  </label>
                ))}
              </fieldset>
            ))
          : null}
        <p>
          The local side is retained privately for seven days before a reviewed choice replaces it.
          Accepted server versions follow normal history retention.
        </p>
        <div className="hosted-conflict-actions">
          <Button type="button" onClick={onClose} disabled={busy}>
            Close without changing either version
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="hosted-sync-resolve"
            disabled={
              busy ||
              !review ||
              review.result.kind === 'invalid' ||
              conflicts.some(
                (conflict) =>
                  choices[conflict.resourceId]?.reviewFingerprint !== conflict.reviewFingerprint
              )
            }
            onClick={() => void resolve()}
          >
            {busy ? 'Checking current versions…' : 'Apply reviewed choices'}
          </Button>
        </div>
      </section>
    </div>
  );
}

function ConflictSide({
  label,
  side,
  snapshot,
}: {
  label: string;
  side: WorkspaceSessionReconcileSide | null;
  snapshot: WorkspaceSessionSnapshot;
}) {
  const [summary, setSummary] = useState<ConflictPreview | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    if (side)
      void summarize(side, snapshot)
        .then((value) => {
          if (!cancelled) setSummary(value);
        })
        .catch((cause: unknown) => {
          if (!cancelled)
            setSummary({
              kind: 'message',
              message: toUserMessage(cause, 'conflict.previewFailed'),
            });
        });
    return () => {
      cancelled = true;
    };
  }, [side, snapshot]);
  return (
    <div>
      <h3>{label}</h3>
      {side ? (
        <>
          <p>
            {side.path} · {side.fileCount} files · {side.sizeBytes.toLocaleString()} bytes
          </p>
          <pre>
            {summary?.kind === 'message'
              ? summary.message
              : summary?.kind === 'content'
                ? summary.content
                : userMessage('conflict.inspecting')}
          </pre>
          <details>
            <summary>Files and content fingerprints</summary>
            <ul>
              {side.files.map((file) => (
                <li key={file.path}>
                  {file.path} — {file.contentSha256?.slice(0, 16)}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p>Deleted</p>
      )}
    </div>
  );
}

async function summarize(
  side: WorkspaceSessionReconcileSide,
  snapshot: WorkspaceSessionSnapshot
): Promise<ConflictPreview> {
  const marker = side.files.find((file) => file.path.endsWith('/.forge/plasmid.json'));
  let product = side.files[0];
  if (marker) {
    if (marker.sizeBytes > 2 * 1024 * 1024)
      return {
        kind: 'message',
        message: userMessage('conflict.metadataTooLarge'),
      };
    const bytes = await hostedDurableSync.runtime.readFile({ snapshot, file: marker });
    const parsed = parseSequencePackageAdmissionDescriptor(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      marker.path
    );
    if (!parsed.ok) return { kind: 'message', message: userMessage('conflict.metadataUnreadable') };
    product = side.files.find((file) => file.path === parsed.descriptor.productPath)!;
  }
  if (!product)
    return {
      kind: 'message',
      message: userMessage('conflict.noSequenceProduct'),
    };
  const sequenceProduct =
    !!marker ||
    product.contentType === 'application/genbank' ||
    /\.(?:gb|gbk|gbff|genbank)$/iu.test(product.path);
  if (product.sizeBytes > 2 * 1024 * 1024)
    return {
      kind: 'message',
      message: userMessage('conflict.sequenceTooLarge'),
    };
  if (
    !sequenceProduct &&
    !product.contentType.startsWith('text/') &&
    product.contentType !== 'application/json'
  )
    return {
      kind: 'message',
      message: userMessage('conflict.binaryContent'),
    };
  const bytes = await hostedDurableSync.runtime.readFile({ snapshot, file: product });
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!sequenceProduct) return { kind: 'content', content: text.slice(0, 4000) };
  const sequence = parseGenBankFull(text, { featurePolicy: 'preserve' });
  return {
    kind: 'content',
    content: `${sequence.name}\n${sequence.sequence.length.toLocaleString()} bases · ${sequence.circular ? 'circular' : 'linear'}\n${sequence.annotations.length} annotations\n${sequence.annotations
      .slice(0, 12)
      .map(
        (annotation) =>
          `${annotation.name || annotation.type}: ${annotation.start}–${annotation.end}`
      )
      .join(
        '\n'
      )}\nBases (first 160): ${sequence.sequence.slice(0, 160)}${marker ? `\n${side.fileCount - 2} additional package files` : ''}`,
  };
}
