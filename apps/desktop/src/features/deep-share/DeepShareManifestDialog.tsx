import { toUserMessage, userMessage, userEntityLabel } from '@waypoint/user-messages';
import { Button } from '../../components/ui';
import type { DeepShareReview } from '../../shared/deep-share-ipc';

export interface DeepShareManifestDialogProps {
  review: DeepShareReview;
  selectedArtifactIds: ReadonlySet<string>;
  selectedConversationIds: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  publishedVersionNumber?: number;
  onToggleArtifact(id: string): void;
  onToggleConversation(id: string): void;
  onPublish(): void;
  onCancel(): void;
}

export function DeepShareManifestDialog(props: DeepShareManifestDialogProps) {
  const artifactById = new Map(props.review.manifest.artifacts.map((item) => [item.id, item]));
  const selectedChats = new Map(props.review.chats.map((chat) => [chat.id, chat]));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="deep-share-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-6"
      data-testid="deep-share-dialog"
    >
      <section className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-md border border-border bg-bg shadow-2xl">
        <header className="border-b border-border px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-muted">
            Anyone with the link · read-only
          </p>
          <h2 id="deep-share-title" className="mt-1 text-lg font-semibold text-fg">
            Review Deep Share
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {props.publishedVersionNumber === undefined
              ? 'Only the artifacts, files, and conversations shown here will be published.'
              : `Version ${props.publishedVersionNumber} is published. Copy its existing link.`}
          </p>
        </header>

        <div className="space-y-6 overflow-y-auto px-5 py-4">
          <section aria-labelledby="deep-share-artifacts-heading">
            <h3 id="deep-share-artifacts-heading" className="text-sm font-semibold text-fg">
              Artifacts and provenance
            </h3>
            <div className="mt-2 space-y-2" data-testid="deep-share-artifact-list">
              {props.review.manifest.artifacts.map((artifact) => {
                const root = artifact.id === props.review.rootArtifactId;
                return (
                  <label
                    key={artifact.id}
                    className="flex items-start gap-3 rounded border border-border px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={props.selectedArtifactIds.has(artifact.id)}
                      disabled={root || props.busy || props.publishedVersionNumber !== undefined}
                      onChange={() => props.onToggleArtifact(artifact.id)}
                      aria-label={`Include ${artifact.name}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-fg">
                        {artifact.name}
                        {root ? ' · required root' : ''}
                      </span>
                      <span className="block text-xs text-fg-muted">
                        {artifact.type} · {artifact.id}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {props.review.manifest.relationships.length > 0 && (
              <ul
                className="mt-3 space-y-1 text-xs text-fg-muted"
                data-testid="deep-share-relations"
              >
                {props.review.manifest.relationships.map((relationship) => (
                  <li
                    key={`${relationship.sourceArtifactId}:${relationship.relation}:${relationship.targetArtifactId}`}
                  >
                    {userEntityLabel(artifactById.get(relationship.sourceArtifactId)?.name)} —{' '}
                    {relationship.relation} →{' '}
                    {userEntityLabel(artifactById.get(relationship.targetArtifactId)?.name)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="deep-share-files-heading">
            <h3 id="deep-share-files-heading" className="text-sm font-semibold text-fg">
              Exact files
            </h3>
            <ul className="mt-2 divide-y divide-border rounded border border-border">
              {props.review.files.map((file) => (
                <li key={file.id} className="px-3 py-2 text-xs" data-testid="deep-share-file">
                  <p className="break-all text-fg">{file.relativePath}</p>
                  <p className="mt-0.5 text-fg-muted">
                    {file.role} · {formatBytes(file.sizeBytes)} · sha256 {file.sha256}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="deep-share-chats-heading">
            <h3 id="deep-share-chats-heading" className="text-sm font-semibold text-fg">
              Conversations · optional
            </h3>
            <p className="mt-1 text-xs text-fg-muted">
              Conversations start unselected. Exact reference counts do not imply fuzzy relevance.
            </p>
            <div className="mt-2 space-y-2">
              {props.review.conversationCandidates.map((candidate) => (
                <div key={candidate.id} className="rounded border border-border px-3 py-2">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={props.selectedConversationIds.has(candidate.id)}
                      disabled={props.busy || props.publishedVersionNumber !== undefined}
                      onChange={() => props.onToggleConversation(candidate.id)}
                      aria-label={`Include conversation ${candidate.title}`}
                    />
                    <span>
                      <span className="block text-sm text-fg">{candidate.title}</span>
                      <span className="block text-xs text-fg-muted">
                        {candidate.exactReferenceCount} exact included-artifact reference(s)
                      </span>
                    </span>
                  </label>
                  {selectedChats.has(candidate.id) && (
                    <div
                      className="mt-3 space-y-2 border-l-2 border-border pl-3"
                      data-testid="deep-share-chat-transcript"
                    >
                      {selectedChats.get(candidate.id)?.messages.map((message) => (
                        <div key={message.id} className="text-xs">
                          <strong className="capitalize text-fg">{message.role}</strong>
                          <p className="mt-0.5 whitespace-pre-wrap text-fg-muted">
                            {message.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {props.review.conversationCandidates.length === 0 && (
                <p className="text-xs text-fg-muted">No conversations belong to this project.</p>
              )}
            </div>
          </section>

          <section aria-labelledby="deep-share-omissions-heading">
            <h3 id="deep-share-omissions-heading" className="text-sm font-semibold text-fg">
              Visible omissions
            </h3>
            {props.review.manifest.omissions.length === 0 ? (
              <p className="mt-1 text-xs text-fg-muted">No discovered items were omitted.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs text-fg-muted">
                {props.review.manifest.omissions.map((omission) => (
                  <li key={`${omission.code}:${omission.subject}:${omission.detail}`}>
                    {userMessage('sharing.omittedContent')}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {props.error && (
            <p
              role="alert"
              className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700"
            >
              {toUserMessage(props.error, 'sharing.failed')}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <p className="text-xs text-fg-muted">
            {props.publishedVersionNumber === undefined
              ? 'Publishing creates an immutable capability link.'
              : 'Copy retries keep the same published version.'}
          </p>
          <div className="flex gap-2">
            <Button type="button" onClick={props.onCancel} disabled={props.busy}>
              {props.publishedVersionNumber === undefined ? 'Cancel' : 'Close'}
            </Button>
            <Button
              type="button"
              onClick={props.onPublish}
              disabled={props.busy}
              variant="primary"
              data-testid="deep-share-publish"
            >
              {props.publishedVersionNumber === undefined
                ? props.busy
                  ? 'Preparing exact bundle…'
                  : 'Publish & copy link'
                : props.busy
                  ? 'Copying published link…'
                  : 'Copy published link'}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}
