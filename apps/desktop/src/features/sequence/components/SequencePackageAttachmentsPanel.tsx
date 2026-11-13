import { toUserMessage, userMessage, withUserMessage } from '@waypoint/user-messages';
import { useRef, useState } from 'react';

import { parseSequencePackageDocument } from '../../../db/sequence-package';
import {
  prepareSequenceUserAttachmentMutation,
  type UserAttachmentMutation,
} from '../../../db/sequence-package-user-attachment-mutation';
import { platform } from '../../../platform';
import type { SequenceUserAttachmentMutationRequest } from '../../../shared/sequence-package-revision';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../../../shared/workspace-file-atomic';
import { getWorkspaceEditorBlockers } from '../../../services/workspace-editor-mutation-state';
import type { SequencePackageHistoryView } from '../hooks/useSequencePackageHistory';

interface Preview {
  request: SequenceUserAttachmentMutationRequest;
  index: NonNullable<SequencePackageHistoryView['index']>;
  sourcePath: string | null;
  fileName: string | null;
  digest: string | null;
  previousName: string | null;
  previousDigest: string | null;
  attempted: boolean;
}

interface Baseline {
  markerSha256: string;
  productSha256: string;
}

export function SequencePackageAttachmentsPanel({
  history,
  isDirty,
  onRefresh,
}: {
  history: SequencePackageHistoryView;
  isDirty: boolean;
  onRefresh(): void | Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const live = useRef({ history, isDirty });
  live.current = { history, isDirty };
  const index = history.index;
  const attachments = index
    ? Object.entries(index.document.userAttachments).sort(([a], [b]) => a.localeCompare(b))
    : [];
  const blocker =
    !index || !history.workspaceRoot
      ? 'Open a managed sequence package to manage attachments.'
      : history.selectedRevisionId !== null
        ? 'Select the current version before changing attachments.'
        : isDirty
          ? 'Save or discard unfinished package edits before changing attachments.'
          : index.currentProductStatus !== 'verified' || !index.document.versionHistory.headId
            ? 'The current sequence must have a verified saved version before attachments can change.'
            : null;

  const begin = async (kind: UserAttachmentMutation['kind'], attachmentId?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPreview(null);
    setError(null);
    setNotice(null);
    try {
      const current = live.current;
      const sourceIndex = current.history.index;
      if (
        !sourceIndex ||
        !current.history.workspaceRoot ||
        current.isDirty ||
        current.history.selectedRevisionId !== null ||
        sourceIndex.currentProductStatus !== 'verified' ||
        !sourceIndex.document.versionHistory.headId
      ) {
        throw withUserMessage(
          new Error(
            'The current package is not ready for an attachment change. Save, refresh, and select Current.'
          ),
          'attachments.guard.the-current-package-is-not-ready-for-an-attachment-change-save-refresh-and-select-current'
        );
      }
      assertPackageEditorsSettled(sourceIndex);
      const id = attachmentId ?? crypto.randomUUID();
      const previous = sourceIndex.document.userAttachments[id];
      const previousMember = previous
        ? sourceIndex.document.members.find((member) => member.id === previous.memberId)
        : undefined;
      if (kind !== 'attach' && (!previous || previous.sha256 === null)) {
        throw withUserMessage(
          new Error(
            'This attachment has no verified current bytes; it cannot be replaced or detached here.'
          ),
          'attachments.guard.this-attachment-has-no-verified-current-bytes-it-cannot-be-replaced-or-detached-here'
        );
      }
      const baseline = await captureBaseline(sourceIndex);
      let sourcePath: string | null = null;
      let fileName: string | null = null;
      let mutation: UserAttachmentMutation;
      if (kind === 'detach') {
        mutation = { kind, attachmentId: id, createdAt: new Date().toISOString() };
      } else {
        const selected = await platform().dialog.open({
          title: kind === 'attach' ? 'Choose a file to attach' : 'Choose replacement attachment',
          multiple: false,
        });
        sourcePath = Array.isArray(selected) ? (selected[0] ?? null) : selected;
        if (!sourcePath) return;
        fileName = sourcePath.split(/[\\/]/).pop() ?? null;
        if (!fileName)
          throw withUserMessage(
            new Error('The selected attachment has no file name.'),
            'attachments.guard.the-selected-attachment-has-no-file-name'
          );
        const content = await platform().fs.readFileBounded(
          sourcePath,
          MAX_WORKSPACE_BINARY_WRITE_BYTES
        );
        mutation = {
          kind,
          attachmentId: id,
          memberId: crypto.randomUUID(),
          fileName,
          content,
          createdAt: new Date().toISOString(),
        };
      }
      const prepared = await prepareSequenceUserAttachmentMutation(sourceIndex.document, mutation);
      const digest = prepared.asset?.sha256 ?? null;
      if (
        sourceIndex !== live.current.history.index ||
        live.current.isDirty ||
        live.current.history.selectedRevisionId !== null
      ) {
        throw withUserMessage(
          new Error('The package view changed while preparing this attachment. Preview again.'),
          'attachments.guard.the-package-view-changed-while-preparing-this-attachment-preview-again'
        );
      }
      const after = await captureBaseline(sourceIndex);
      if (
        after.markerSha256 !== baseline.markerSha256 ||
        after.productSha256 !== baseline.productSha256
      ) {
        throw withUserMessage(
          new Error(
            'The package changed while preparing this attachment. Refresh and preview again.'
          ),
          'attachments.guard.the-package-changed-while-preparing-this-attachment-refresh-and-preview-again'
        );
      }
      setPreview({
        request: {
          workspaceRoot: current.history.workspaceRoot,
          packageRoot: sourceIndex.packageRoot,
          packageId: sourceIndex.document.id,
          expectedMarkerSha256: baseline.markerSha256,
          expectedProductSha256: baseline.productSha256,
          operationId: `user-attachment:${crypto.randomUUID()}`,
          mutation,
        },
        index: sourceIndex,
        sourcePath,
        fileName,
        digest,
        previousName: previousMember
          ? displayNameForMember(previousMember.id, previousMember.path)
          : null,
        previousDigest: previous?.sha256 ?? null,
        attempted: false,
      });
    } catch (cause) {
      setError(toUserMessage(cause, 'attachments.changeFailed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (live.current.isDirty || live.current.history.selectedRevisionId !== null) {
        throw withUserMessage(
          new Error('Unfinished edits or a historical view now block the attachment change.'),
          'attachments.guard.unfinished-edits-or-a-historical-view-now-block-the-attachment-change'
        );
      }
      assertPackageEditorsSettled(preview.index);
      if (!preview.attempted) {
        if (live.current.history.index !== preview.index) {
          throw withUserMessage(
            new Error('The History view changed. Preview the attachment again.'),
            'attachments.guard.the-history-view-changed-preview-the-attachment-again'
          );
        }
        const baseline = await captureBaseline(preview.index);
        if (
          baseline.markerSha256 !== preview.request.expectedMarkerSha256 ||
          baseline.productSha256 !== preview.request.expectedProductSha256
        ) {
          throw withUserMessage(
            new Error('The package changed after preview. Refresh and preview again.'),
            'attachments.guard.the-package-changed-after-preview-refresh-and-preview-again'
          );
        }
        if (
          preview.sourcePath &&
          preview.digest &&
          (await platform().fs.sha256File(preview.sourcePath)) !== preview.digest
        ) {
          throw withUserMessage(
            new Error('The chosen file changed after preview. Choose it again.'),
            'attachments.guard.the-chosen-file-changed-after-preview-choose-it-again'
          );
        }
      }
      setPreview((current) => (current === preview ? { ...current, attempted: true } : current));
      const receipt = await platform().fs.publishSequenceUserAttachmentMutation(preview.request);
      setPreview(null);
      setNotice(`Attachment change saved in version ${receipt.revisionId}.`);
      try {
        await onRefresh();
      } catch (cause) {
        setError(userMessage('attachments.refreshFailed'));
      }
    } catch (cause) {
      setError(toUserMessage(cause, 'attachments.changeFailed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Package attachments"
      className="space-y-3 border-t border-border p-4 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-fg">Attachments</h3>
        <button
          type="button"
          disabled={Boolean(blocker) || busy}
          onClick={() => void begin('attach')}
          className="rounded border border-border px-2 py-1 disabled:opacity-50"
        >
          Attach file
        </button>
      </div>
      {blocker && <p className="text-xs text-fg-muted">{blocker}</p>}
      {attachments.length === 0 && (
        <p className="text-xs text-fg-muted">No current user attachments.</p>
      )}
      {attachments.map(([id, attachment]) => {
        const member = index?.document.members.find(
          (candidate) => candidate.id === attachment.memberId
        );
        const name = member ? displayNameForMember(member.id, member.path) : id;
        const unavailable = attachment.sha256 === null;
        return (
          <div
            key={id}
            className="rounded border border-border p-2"
            data-testid={`attachment-${id}`}
          >
            <div className="truncate font-medium text-fg" title={name}>
              {name}
            </div>
            <div className="text-xs text-fg-muted">
              {unavailable ? 'Legacy bytes not verified' : `${attachment.sha256!.slice(0, 19)}…`}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={Boolean(blocker) || unavailable || busy}
                onClick={() => void begin('replace', id)}
                className="rounded border border-border px-2 py-1 disabled:opacity-50"
              >
                Replace
              </button>
              <button
                type="button"
                disabled={Boolean(blocker) || unavailable || busy}
                onClick={() => void begin('detach', id)}
                className="rounded border border-border px-2 py-1 disabled:opacity-50"
              >
                Detach
              </button>
            </div>
          </div>
        );
      })}
      {preview && (
        <div className="rounded border border-accent p-3" data-testid="attachment-preview">
          <p className="font-medium text-fg">Preview {preview.request.mutation.kind}</p>
          <p className="mt-1 text-xs text-fg-muted">
            {preview.previousName ?? preview.fileName ?? 'Attachment'} · current version{' '}
            {preview.index.document.versionHistory.headId}
          </p>
          <p className="break-all text-xs text-fg-muted">
            Current: {preview.previousDigest ?? 'No current attachment'}
          </p>
          <p className="break-all text-xs text-fg-muted">
            After: {preview.digest ?? 'No current attachment'}
          </p>
          {preview.digest && (
            <p className="break-all text-xs text-fg-muted">Exact file SHA-256: {preview.digest}</p>
          )}
          <p className="mt-1 text-xs text-fg-muted">
            Existing package files and older versions are retained.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy || Boolean(blocker)}
              onClick={() => void confirm()}
              className="rounded border border-accent px-2 py-1 disabled:opacity-50"
            >
              {preview.attempted ? 'Retry exact change' : 'Confirm attachment change'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
              className="rounded border border-border px-2 py-1 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-error">
          {toUserMessage(error, 'attachments.changeFailed')}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-fg-muted">
          {notice}
        </p>
      )}
    </section>
  );
}

function assertPackageEditorsSettled(
  index: NonNullable<SequencePackageHistoryView['index']>
): void {
  const active = getWorkspaceEditorBlockers({
    workspaceRoot: index.packageRoot,
    affectedEntityIds: [index.document.id],
  }).some((editor) => editor.entityId === index.document.id && editor.state !== 'clean');
  if (active)
    throw withUserMessage(
      new Error('Save or discard unfinished package edits before changing attachments.'),
      'attachments.guard.save-or-discard-unfinished-package-edits-before-changing-attachments'
    );
}

async function captureBaseline(
  index: NonNullable<SequencePackageHistoryView['index']>
): Promise<Baseline> {
  const marker = await platform().fs.readTextFile(index.markerPath);
  const onDisk = JSON.parse(marker) as { formatVersion?: unknown };
  if (onDisk.formatVersion !== index.document.formatVersion) {
    throw withUserMessage(
      new Error('This package needs controlled migration before attachments can change.'),
      'attachments.guard.this-package-needs-controlled-migration-before-attachments-can-change'
    );
  }
  const live = parseSequencePackageDocument(marker);
  if (live.id !== index.document.id || JSON.stringify(live) !== JSON.stringify(index.document)) {
    throw withUserMessage(
      new Error('The package changed since History loaded. Refresh it and preview again.'),
      'attachments.guard.the-package-changed-since-history-loaded-refresh-it-and-preview-again'
    );
  }
  const productSha256 = await platform().fs.sha256File(index.productPath);
  const head = index.document.versionHistory.revisions.find(
    (revision) => revision.id === index.document.versionHistory.headId
  );
  if (!head || productSha256 !== head.productSnapshot.sha256) {
    throw withUserMessage(
      new Error('The current product is not the verified saved version.'),
      'attachments.guard.the-current-product-is-not-the-verified-saved-version'
    );
  }
  const markerSha256 = await sha256Text(marker);
  if (
    (await platform().fs.readTextFile(index.markerPath)) !== marker ||
    (await platform().fs.sha256File(index.productPath)) !== productSha256
  ) {
    throw withUserMessage(
      new Error('The package changed while it was being checked. Preview again.'),
      'attachments.guard.the-package-changed-while-it-was-being-checked-preview-again'
    );
  }
  return { markerSha256, productSha256 };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function displayNameForMember(memberId: string, path: string): string {
  const fileName = path.split('/').pop() ?? path;
  const managedPrefix = `user-attachment-${memberId}-`;
  return fileName.startsWith(managedPrefix) ? fileName.slice(managedPrefix.length) : fileName;
}
